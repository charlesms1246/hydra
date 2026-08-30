/**
 * The vault over HTTP.
 *
 * `HYDRA_HANDOFF.md` Phase 3 requires the vault to be "self-hostable and documented at launch",
 * and until now `Vault` was an in-process object — which meant its disclosure table described
 * a model rather than a service.
 *
 * THE POINT OF THIS FILE IS THAT IT DISCLOSES MORE. A transport is not neutral. Binding to a
 * socket hands the operator a source address, request headers, and per-request timing that the
 * in-process object never had, and none of it is optional — the kernel knows the peer address
 * whether or not this code reads it. So `observations.ts` gains rows for exactly those, and
 * `operator-view.test.ts` checks the HTTP surface against the extended table the same way it
 * checks the object against the base one.
 *
 * What this code can control is whether it *records* them, and it does not: no access log, no
 * request id, nothing written down per request beyond what `Vault` already keeps. The rows are
 * on the table anyway, because "we choose not to log it" is a promise about behaviour and the
 * standing rule is that the product states properties instead. An operator who changes one line
 * has the log; a user reading the table should know that.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Vault, ENCRYPTED_ENDPOINT, PUBLIC_ENDPOINT } from "./server.ts";
import type { Endpoint } from "./server.ts";

/** Largest body accepted, in bytes: the largest size bucket plus a little framing. */
export const MAX_BODY = 262_144 + 1024;

const endpointOf = (path: string): Endpoint | null =>
  path.startsWith(ENCRYPTED_ENDPOINT) ? ENCRYPTED_ENDPOINT
    : path.startsWith(PUBLIC_ENDPOINT) ? PUBLIC_ENDPOINT
      : null;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Refused rather than truncated: a truncated body would be stored under an id that does
    // not match its bytes, and content addressing would quietly stop being true.
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Bind the vault to a port.
 *
 * `PUT /v1/enc/<id>` uploads, with the invite in `x-hydra-invite`. `POST /v1/enc` with a JSON
 * array of ids fetches a batch — reads are batched because a client that asks for one id tells
 * the operator which message it wanted. `DELETE /v1/pub/<id>` is the operator's takedown.
 */
export function serve(
  vault: Vault,
  port = 0,
  options: { observeTransport?: boolean } = {},
): Promise<{ url: string; server: Server }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // Off by default. Flipping it is one argument, which is exactly why the transport rows
      // are on the disclosure table whether or not it is on.
      if (options.observeTransport) {
        vault.observeRequest({
          at: Date.now(),
          peer: req.socket.remoteAddress ?? "",
          headers: Object.keys(req.headers),
        });
      }
      const send = (code: number, body: unknown) => {
        const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        // No `Server`, no `Date` beyond what node insists on, no request id. Every header is a
        // thing the operator would otherwise be handed for free.
        res.writeHead(code, { "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" });
        res.end(payload);
      };
      try {
        const path = (req.url ?? "").split("?")[0];
        const endpoint = endpointOf(path);
        if (!endpoint) return send(404, { error: "no such endpoint" });
        const id = path.slice(endpoint.length + 1);

        if (req.method === "PUT") {
          const body = await readBody(req);
          const invite = req.headers["x-hydra-invite"];
          const reply = vault.handle({
            op: "upload", endpoint, id, body: new Uint8Array(body),
            invite: typeof invite === "string" ? invite : undefined,
            pin: req.headers["x-hydra-pin"] === "1",
          });
          return send(reply.ok ? 201 : 400, reply);
        }

        if (req.method === "POST") {
          const ids = JSON.parse((await readBody(req)).toString("utf8") || "[]") as string[];
          const reply = vault.handle({ op: "fetch", endpoint, ids });
          if (!reply.ok) return send(400, reply);
          // The response says which ids were found and returns them base64'd in one object,
          // so a client fetches its whole channel set in a single round trip.
          const found = Object.fromEntries(
            [...(reply as { found: ReadonlyMap<string, Uint8Array> }).found]
              .map(([k, v]) => [k, Buffer.from(v).toString("base64")]),
          );
          return send(200, { found });
        }

        if (req.method === "DELETE") {
          return send(200, vault.handle({ op: "remove", id }));
        }

        return send(405, { error: "method not allowed" });
      } catch (e) {
        // Deliberately uninformative. An error that echoed the request would put the caller's
        // own bytes into whatever collects stderr.
        return send(400, { ok: false, error: String((e as Error).message).slice(0, 80) });
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ url: `http://127.0.0.1:${p}`, server });
    });
  });
}
