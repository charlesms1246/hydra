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

import { guiServer, type StateSource } from "./server.ts";
import { load, locked, resolvePassphrase, STATE_FILE } from "../../cli/src/state.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback = ""): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

// **THE SAME PASSPHRASE PATH AS THE OTHER TWO FRONT ENDS**, and it is shared rather than repeated
// for the reason `FRONT-END-PARITY-INVENTORY.md` gives: a locked state handled in `cli.ts` and not
// in `main.ts` is exactly how the TUI came to crash on a file the Identity page told users to make.
if (locked()) await resolvePassphrase();

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
const server = guiServer({ token, stateNow });

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
  process.on(signal, () => { server.close(); process.exit(0); });
}
