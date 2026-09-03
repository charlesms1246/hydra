/**
 * Where a report comes from. The last step of `decisions/0035` with no way to perform it.
 *
 * THE MODERATION DISCLOSURE TABLE'S FIRST ROW IS `report.filed`, and until this existed nothing
 * could file a report — `Reports.file()` had no caller outside its own tests. That is
 * E-UNREACHABLE for the third time and the most visible instance yet: the table opens by
 * describing what an operator learns when a report arrives, for an event that could not happen.
 *
 * A SPOOL, NOT THE QUEUE, and the reason is concurrency rather than taste. `queue.ts` writes by
 * atomic rename, which is last-writer-wins — correct for one writer and silently lossy with two.
 * A public endpoint accepting reports while an operator records a decision would drop one or the
 * other, and the one dropped would be a report nobody knows arrived. So intake only ever APPENDS,
 * `ingest` folds the spool into the queue, and the CLI stays the queue's only writer.
 *
 * THE VAULT DOES NOT DO THIS. `vault-server` must not import `moderation` — `no-key-in-server`,
 * `no-accounts` and `x3dh-authenticates-not-vault` all fired the last time moderation was put
 * there — and an intake endpoint bolted to the vault would drag the queue, the retention policy
 * and the bodies-kept rule in with it. Here the vault stays a store that knows nothing about
 * moderation, which is the dependency direction the whole design rests on.
 */

import { appendFileSync, statSync, existsSync } from "node:fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

import { RateLimiter, type RateLimitConfig } from "../../vault-server/src/ratelimit.ts";

/** One line of the spool. Deliberately the same three fields `Reports.file` takes, and no more. */
export type Spooled = { readonly blobId: string; readonly body: string; readonly at: number };

/**
 * The longest report body accepted.
 *
 * Generous enough to explain a situation and bounded because it is written by a stranger and
 * stored. A reporter who needs more room is describing several things and should file several
 * reports, which is also what makes them separately readable.
 */
export const MAX_BODY = 4000;

/**
 * How large the spool may grow before intake refuses.
 *
 * `decisions/0035` bounds the QUEUE structurally — one review per object, so ten thousand reports
 * against one post produce one review. **That does not bound the spool**, which is pre-dedup and
 * grows with the adversary's effort, and an unbounded file on the operator's disk is the flooding
 * attack succeeding one stage earlier than the design looked.
 *
 * Refusing is the lesser harm and it is stated rather than silent: a 503 tells an honest reporter
 * to come back, where filling the disk stops the service for everybody. `ingest` empties the spool,
 * so an operator who runs it is never near this.
 */
export const MAX_SPOOL_BYTES = 32 * 1024 * 1024;

const send = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

/**
 * The public report endpoint.
 *
 * Unauthenticated by construction: `no-accounts` means there is no reporter to authenticate, and
 * anything that identified one well enough to limit them would be the first identity in the
 * system. Per-peer limiting is available and OFF by default — it discloses nothing new, since
 * `rate.peerBucket` is already on the vault's table, but it is a configuration choice with a
 * stated cost rather than a default.
 */
export function serveIntake(
  spool: string,
  port = 0,
  options: { rateLimit?: RateLimitConfig } = {},
): Promise<{ url: string; server: Server }> {
  const limiter = new RateLimiter(options.rateLimit);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/report") {
        return send(res, 404, { error: "no such endpoint" });
      }
      if (!limiter.allow(req.socket.remoteAddress ?? "")) {
        return send(res, 429, { error: "too many requests" });
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        // Checked while reading, not after: a body is refused for being too long by not being
        // held in the first place.
        if (raw.length > MAX_BODY * 2) return send(res, 413, { error: "report too long" });
      }
      let parsed: { blobId?: unknown; body?: unknown };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        return send(res, 400, { error: "a report is JSON: { blobId, body }" });
      }
      const { blobId, body } = parsed;
      if (typeof blobId !== "string" || typeof body !== "string" || body.trim() === "") {
        return send(res, 400, { error: "a report needs a blobId and a body" });
      }
      if (body.length > MAX_BODY) return send(res, 413, { error: "report too long" });

      // PUBLIC BLOBS ONLY, AND SAID OUT LOUD. `decisions/0035` §2: there is no report path for the
      // encrypted class, and the intake must say so rather than accepting and dropping. A reporter
      // who believes they have been heard and has not is worse served than one told the truth —
      // and the reason is not a limitation to apologise for: nobody but the participants can read
      // an encrypted object, so there is nothing for an operator to review.
      if (!blobId.startsWith("pub:")) {
        return send(res, 422, {
          error: "only public posts can be reported",
          because: "an encrypted object can be read by nobody but the people in the conversation, "
            + "including this service, so there is nothing here that could review it. Nothing has "
            + "been recorded. If you are being harmed by a message you have received, blocking and "
            + "deleting are yours to do and do not need us.",
        });
      }
      if (existsSync(spool) && statSync(spool).size > MAX_SPOOL_BYTES) {
        return send(res, 503, { error: "the report spool is full; try again later" });
      }
      const line: Spooled = { blobId, body, at: Date.now() };
      appendFileSync(spool, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      // NO IDENTIFIER FOR THE REPORT IS RETURNED. A handle a reporter could quote back would be a
      // thing to look them up by, and there is nothing to look up: `0035` §2 keeps no reporter.
      return send(res, 202, { ok: true, filed: true });
    })().catch(() => send(res, 500, { error: "internal error" }));
  });
  return new Promise((ok) => {
    // 127.0.0.1, like the vault: nothing here has been deployed, and a service that binds every
    // interface by default is one that gets exposed by accident rather than by decision.
    server.listen(port, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server }));
  });
}
