#!/usr/bin/env node
/**
 * `hydra gui` — the local API a page drives, and the token that lets it.
 *
 * **THE PAGE IS NOT SERVED FROM HERE.** This binds loopback and answers a handful of named
 * endpoints; the interface is elsewhere, hosted or standalone, and talks to this. Nothing about
 * the product moves to a server — see `claude-docs/GUI-API-CONTRACT.md`.
 *
 *     hydra gui                 mint a token, bind 127.0.0.1 on a free port
 *     hydra gui --port 8123     a fixed port, for a page with a stored base URL
 *
 * **THE TOKEN GOES IN THE URL FRAGMENT AND NOWHERE ELSE.** A fragment is never sent to a server,
 * so it stays out of `Referer`, out of browser history and out of every log between the page and
 * whoever hosts it. A query parameter is in all three. The page reads `location.hash`, holds the
 * token in memory, strips it from the URL, and sends `x-hydra-token`.
 *
 * PRINTED ONCE AND NOT PERSISTED. Minted per run, so an old one stops working — which is a
 * property rather than an inconvenience: a token that outlives the process it authorised is a
 * credential nobody is tracking.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";

import { guiServer, problemOf, type FlushAttempt, type StateSource } from "./server.ts";
import { serialise } from "./serialise.ts";
import { chainFor } from "../../cli/src/chain.ts";
import { flush, FLUSH_LIMIT } from "../../cli/src/commands.ts";
import { load, locked, currentPassphrase, resolvePassphrase, save, STATE_FILE }
  from "../../cli/src/state.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback = ""): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

// **THE SAME PASSPHRASE PATH AS THE OTHER TWO FRONT ENDS**, and it is shared rather than repeated
// for the reason `FRONT-END-PARITY-INVENTORY.md` gives: a locked state handled in `cli.ts` and not
// in `main.ts` is exactly how the TUI came to crash on a file the Identity page told users to make.
// **AND NOT TWICE.** Reached as `hydra gui`, `cli.ts` has already resolved the passphrase before
// dispatching — `locked()` still reports true, because it reads the FILE rather than whether this
// process can open it, so prompting on that alone asks the same user for the same phrase again.
// `currentPassphrase()` is the question actually being asked: do we have one yet.
if (locked() && !currentPassphrase()) await resolvePassphrase();

/**
 * Read the state fresh on every request.
 *
 * Not cached: a user may be running the TUI at the same time, and a page showing a queue that
 * emptied ten minutes ago is a page lying about what the client is doing. Reading a small JSON
 * file per request is cheap; disagreeing with the other front end is not.
 */
function stateNow(): StateSource {
  if (!existsSync(STATE_FILE)) return { t: "none", file: STATE_FILE };
  try {
    return { t: "ready", state: load(), file: STATE_FILE };
  } catch {
    // `load` throws for an envelope with no passphrase, and for a version it refuses to guess at.
    // Both are "there is a file and this process cannot read it", which is what the page is told.
    return { t: "locked", file: STATE_FILE };
  }
}

const token = randomBytes(16).toString("hex");

/**
 * The one lock, shared by the HTTP handlers and the ticker below.
 *
 * Not one per entry point: a flush landing mid-send is the same interleaving as two sends, from
 * the other direction. See `serialise.ts`.
 */
const exclusive = serialise();

/**
 * The last upload attempt the ticker made, and the run of failures behind it.
 *
 * **THIS PROCESS IS THE ONLY THING THAT KNOWS.** The ticker must swallow a vault failure or one
 * dead vault takes the client down, and until this existed the swallowing was total: `status` is
 * derived entirely from the state file, so its payload for a client whose uploads have been
 * failing for an hour was identical to one whose vault is fine. Kept here rather than in the state
 * file because it describes this run, not the identity, and a save on every failed tick is a write
 * amplification nobody asked for.
 */
let lastFlush: FlushAttempt | null = null;
let consecutiveFailures = 0;

const server = guiServer({
  token, stateNow, save, chainFor, now: () => Date.now(), exclusive,
  lastFlush: () => lastFlush,
});

/**
 * Uploads go up on a clock, not on a request — the same reason the TUI is resident.
 *
 * **WITHOUT THIS, A MESSAGE SENT THROUGH THE API IS NEVER UPLOADED.** `send` publishes the chain
 * event and queues the objects for a jittered moment later; something has to be running then.
 * `decisions/0022` is why the resident client exists at all, and an API process is resident.
 *
 * IT SKIPS RATHER THAN QUEUES when something else holds the lock, exactly as the TUI's ticker
 * does: a slow publish must not build a backlog of flushes that all fire when it finishes, because
 * that is the burst `upload.burst` exists to prevent.
 */
const TICK_MS = 1000;
const ticker = setInterval(() => {
  void exclusive("flush", async () => {
    const now = stateNow();
    if (now.t !== "ready") return;
    const due = now.state.pending.filter((p) => p.uploadAt <= Date.now()).length;
    // **NOT AN ATTEMPT, SO NOT COUNTED.** The ticker runs every second and mostly finds nothing
    // due. Counting these would report a vault as failing when it was never asked, which is the
    // over-claim in the frightening direction and still an over-claim.
    if (due === 0) return;
    try {
      const r = await flush(now.state, Date.now(), undefined, FLUSH_LIMIT);
      save(now.state);
      consecutiveFailures = 0;
      lastFlush = { at: Date.now(), ok: true, uploaded: r.uploaded, consecutiveFailures: 0,
        problem: null };
    } catch (e) {
      consecutiveFailures += 1;
      lastFlush = { at: Date.now(), ok: false, uploaded: 0, consecutiveFailures,
        problem: problemOf(e, now.state.vaultUrl) };
      throw e;
    }
  }).catch((e: unknown) => {
    // **A VAULT THAT IS DOWN MUST NOT TAKE THE PROCESS WITH IT — AND THAT IS NOT THE SAME AS
    // SAYING NOTHING.** This used to point at the queue on `status` as "the honest signal". The
    // queue was not a signal: it stands still identically whether the vault is dead or the next
    // upload is simply not due, and `status` carried nothing else. It does now, and the detail
    // that is too unbounded to send to a browser is printed here, where a user running
    // `hydra gui` can see it.
    console.error("hydra gui: upload attempt failed:", e);
  });
}, TICK_MS);
ticker.unref();

// 0 MEANS "ANY FREE PORT", which is the default because a fixed one collides and because nothing
// should be discoverable at a known address without the token anyway.
const port = Number(flag("port", "0"));

// **A TAKEN PORT IS A SENTENCE, NOT A STACK TRACE.** Found by driving this: `--port` on a port
// something else holds emitted an unhandled `error` event and printed eleven lines of Node
// internals at a user. That is the same defect the TUI had on a locked state file this morning,
// reproduced in new code within an hour of the fix — which is the argument for driving a thing
// rather than reading it.
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    process.stderr.write(`\n  port ${port} is already in use, so hydra gui did not start.\n`);
    process.stderr.write("  Use a different one, or drop --port and it will take a free port.\n\n");
    process.exit(2);
  }
  process.stderr.write(`\n  hydra gui could not listen: ${e.message}\n\n`);
  process.exit(2);
});

server.listen(port, "127.0.0.1", () => {
  const bound = (server.address() as AddressInfo).port;
  process.stdout.write(`\n  hydra gui on http://127.0.0.1:${bound}\n`);
  process.stdout.write(`  token ${token}\n\n`);
  process.stdout.write("  Open your interface with the token in the URL FRAGMENT, not a query:\n");
  process.stdout.write(`      <your-page>/#t=${token}\n\n`);
  process.stdout.write("  A fragment is never sent to a server, so it stays out of Referer, out of\n");
  process.stdout.write("  browser history and out of anyone's logs. A query parameter is in all three.\n\n");
  process.stdout.write("  The first request will ask your browser for permission to reach this\n");
  process.stdout.write("  machine's local network. Chrome blocks it by default and the page cannot\n");
  process.stdout.write("  tell you why, because the request never arrives here.\n\n");
  process.stdout.write("  Loopback only. This token dies with this process.\n\n");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { clearInterval(ticker); server.close(); process.exit(0); });
}
