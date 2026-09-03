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
import { createServer as createSecureServer } from "node:https";
import { constants } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Vault, ENCRYPTED_ENDPOINT, PUBLIC_ENDPOINT } from "./server.ts";
import { RateLimiter, DEFAULT_RATE_LIMIT } from "./ratelimit.ts";
import type { RateLimitConfig } from "./ratelimit.ts";
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
 * the operator which message it wanted. `DELETE /v1/pub/<id>` is the operator's takedown, and it
 * requires `x-hydra-removal` to match the `removalToken` the server was started with — refused
 * outright if none was configured. It had no check whatsoever until `decisions/0035`, and a
 * public blob's id is public by construction, so anyone who could read a post could delete it.
 */
/**
 * Terminating TLS here rather than behind a proxy.
 *
 * The alternative was a reverse proxy, and the reasoning against it is this project's own: a
 * proxy means a DIFFERENT PARTY holds the SNI, the cipher suite, the ALPN and the resumption
 * state — not nobody. Given the choice between two parties seeing it, pick the one you control
 * and can describe. So the rows go on the disclosure table and this process produces them.
 *
 * SESSION TICKETS ARE OFF, and that is the one that mattered. A ticket lets a client resume,
 * which means the server can recognise the same client across separate connections — a durable
 * link between requests that the whole design refuses to keep anywhere else. `SSL_OP_NO_TICKET`
 * turns it off; `tls.resumption` is on the NOT_OBSERVABLE table with that as its mechanism.
 *
 * The cost is real and is not hidden: every connection does a full handshake. That is more CPU
 * on both ends and an extra round trip, paid so that two connections from one client cannot be
 * joined by the server.
 */
export type TlsConfig = {
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
};

export function serve(
  vault: Vault,
  port = 0,
  options: {
    observeTransport?: boolean;
    rateLimit?: RateLimitConfig;
    tls?: TlsConfig;
    /**
     * The secret an operator's takedown must carry. **Without it `DELETE` is refused entirely.**
     *
     * It had no check at all, and a public blob's id is public by construction — it is how the
     * object is fetched. So anyone who could READ a public post could DELETE it, unauthenticated,
     * with one request. Verified against the real server before this existed: a stranger with no
     * header got `{"removed":true}` and the object was gone.
     *
     * Refusing when unset rather than allowing is the safe default: an operator who has not
     * decided who may take content down has not thereby decided that everyone may.
     *
     * This does not decide the moderation pipeline — see `decisions/0035`. It is the narrowest
     * thing that is right under every option in it, because every one of them ends with the
     * OPERATOR performing the removal, whoever asked for it.
     */
    removalToken?: string;
  } = {},
): Promise<{ url: string; server: Server; limiter: RateLimiter }> {
  // Defaults to `global`: a public service needs a limit, and the mode that needs no
  // per-client state is the one to reach for first. `per-peer` is a decision with a row on
  // the disclosure table, so it has to be asked for.
  const limiter = new RateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT);
  vault.useRateLimiter(limiter);
  if (options.tls) vault.servedOverTls();
  const handler = (req: IncomingMessage, res: ServerResponse) => {
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
      if (!limiter.allow(req.socket.remoteAddress ?? "")) {
        // No Retry-After: it would tell a caller how the limiter is configured, and a client
        // that is being refused can back off without being told the shape of the bucket.
        res.writeHead(429, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "rate limited" }));
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
          // Every encrypted upload carries one, cover included — see `UploadRequest`.
          const deleteHash = req.headers["x-hydra-delete-hash"];
          const reply = vault.handle({
            op: "upload", endpoint, id, body: new Uint8Array(body),
            invite: typeof invite === "string" ? invite : undefined,
            deleteHash: typeof deleteHash === "string" ? deleteHash : undefined,
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
          // THE ENCRYPTED CLASS IS A CAPABILITY, NOT THE OPERATOR'S ACT. A token in the header,
          // hashed and compared by the server, which holds no discretion over it — see
          // `decisions/0035` §1 and `channel/src/deletion.ts`.
          if (endpoint === ENCRYPTED_ENDPOINT) {
            const offered = req.headers["x-hydra-delete"];
            const token = typeof offered === "string"
              ? new Uint8Array(Buffer.from(offered, "hex")) : undefined;
            const reply = vault.handle({ op: "remove", id, token });
            // 404 on refusal, for the reason the public path gives: a distinguishable failure
            // confirms the object exists to anyone probing ids.
            return (reply as { removed?: boolean }).removed
              ? send(200, reply) : send(404, { error: "no such object" });
          }
          const offered = req.headers["x-hydra-removal"];
          if (!options.removalToken || offered !== options.removalToken) {
            // Uninformative, and 404 rather than 401: a 401 would confirm the object exists to
            // anyone probing ids, which is the same disclosure the read path is careful about.
            return send(404, { error: "no such object" });
          }
          return send(200, vault.handle({ op: "remove", id }));
        }

        return send(405, { error: "method not allowed" });
      } catch (e) {
        // Deliberately uninformative. An error that echoed the request would put the caller's
        // own bytes into whatever collects stderr.
        return send(400, { ok: false, error: String((e as Error).message).slice(0, 80) });
      }
    })();
  };
  const server: Server = options.tls
    ? createSecureServer({
      key: options.tls.key,
      cert: options.tls.cert,
      // No tickets, and no session cache either: both are resumption, and resumption is the
      // server recognising a client it has seen before.
      secureOptions: constants.SSL_OP_NO_TICKET,
      sessionTimeout: 0,
    }, handler) as unknown as Server
    : createServer(handler);
  if (options.tls) (server as unknown as { setMaxListeners(n: number): void }).setMaxListeners(0);

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ url: `${options.tls ? "https" : "http"}://127.0.0.1:${p}`, server, limiter });
    });
  });
}
