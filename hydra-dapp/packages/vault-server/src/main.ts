#!/usr/bin/env node
/**
 * Run the vault.
 *
 * `HYDRA_HANDOFF.md` Phase 3 wants the vault "self-hostable and documented at launch", and
 * until now it was a class with an HTTP adapter and no way to start it — which meant the
 * disclosure table described something nobody could run.
 *
 *     node packages/vault-server/src/main.ts --generate-invites 50   # mint codes and stop
 *     node packages/vault-server/src/main.ts --port 8080 --dir ./vault --invites a,b,c
 *
 * Add `--removal-token-file ./removal.token` to be able to take a public post down. Without it
 * every takedown is refused — see `ERRORS.md` E-UNREACHABLE for the time that was not on purpose.
 *
 * Every default here is the more private one, and each is a decision with a row on the
 * disclosure table behind it: transport observation is OFF, rate limiting is `global` (which
 * keeps no per-client state and is worse at its job), and there is no access log. Turning any
 * of them on is one flag, which is exactly why the rows are on the table whether or not it has
 * been turned on.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { Vault } from "./server.ts";
import { serve } from "./http.ts";
import { removalAuthorityFromFile } from "./authority.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import type { RateLimitConfig } from "./ratelimit.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback = ""): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

/**
 * Mint invite codes and stop, without starting a server.
 *
 * BECAUSE AN OPERATOR WHO HAS TO INVENT CODES BY HAND WILL INVENT ONE PER PERSON, and that single
 * habit undoes everything else this vault does. An upload requires a code, the only way to get one
 * is from the operator, and `hydra init --invites` is the only way in — so on the submission
 * surface a source asks the organisation for permission to upload BEFORE their first message. If
 * the codes are per-person, the invite is an identity acquired before anything else happens, and it
 * dominates the timing defence, the cover traffic and the padded read alike. See
 * `decisions/0038` and the `invite.issuance` row.
 *
 * 128 bits from the OS, so a code cannot be guessed and nothing about it encodes who it is for.
 */
const generate = Number(flag("generate-invites", "0"));
if (generate > 0) {
  for (let i = 0; i < generate; i++) console.log(randomBytes(16).toString("hex"));
  console.error("");
  console.error(`${generate} invite codes. Each buys ONE upload, and one message costs several —`);
  console.error("a client sends its cover objects alongside the message, and every one of them is");
  console.error("an upload. Issue accordingly, or the timing defence is what runs out first.");
  console.error("");
  console.error("HOW YOU HAND THESE OUT IS A PRIVACY DECISION, and it is the one this vault cannot");
  console.error("make for you or see you make. A code you give to one named person is an identity:");
  console.error("it arrives in the same request as their object, so you can name the uploader of");
  console.error("anything, with no cryptography and no correlation work.");
  console.error("");
  console.error("If you are accepting anonymous submissions, PUBLISH A BATCH OPENLY so that holding");
  console.error("one identifies nobody. That is not free: an open code is usable by anyone, so your");
  console.error("abuse control degrades to per-code rate limiting that anyone can exhaust. That is");
  console.error("the trade, and it is a real one — see claude-docs/decisions/0038.");
  process.exit(0);
}

const invites = flag("invites").split(",").filter(Boolean);
const vault = new Vault({
  invites,
  buckets: BUCKETS,
  dir: flag("dir") || undefined,
  observeReads: args.includes("--observe-reads"),
});

const mode = flag("rate-limit", "global") as RateLimitConfig["mode"];
/**
 * The limit has to allow for cover.
 *
 * A client doing the timing defence correctly sends `COVER_RATE + 1` objects per message and
 * reads a padded batch, so a budget tuned for messages refuses exactly the clients that are
 * behaving. Stated in requests per minute so the arithmetic is visible.
 */
const perMinute = Number(flag("per-minute", "600"));
const rateLimit: RateLimitConfig =
  mode === "none" ? { mode } : { mode, perMinute };

// TLS terminates HERE when a key and cert are given, rather than behind a proxy. Both choices
// disclose SNI, cipher suite and ALPN to somebody; this one discloses them to the party running
// the vault, who is the party already describing what they can see. Session tickets are off, so
// two connections from one client cannot be joined — see `http.ts`.
const tlsKey = flag("tls-key");
const tlsCert = flag("tls-cert");
if (Boolean(tlsKey) !== Boolean(tlsCert)) {
  throw new Error("--tls-key and --tls-cert go together; one without the other is not TLS");
}

/**
 * The secret a public takedown must carry. Without it `DELETE` is refused outright.
 *
 * IT WAS NOT PASSED AT ALL, and that is the defect this flag exists to end. `http.ts` refuses
 * removal when no token is configured — the correct default, since an operator who has not decided
 * who may take content down has not decided that everyone may — and this entry point never wired
 * the option through. So a vault started the real way refused EVERY public takedown while the
 * capability sat documented on the disclosure table and tested in-process.
 *
 * The class is worth naming: every previous finding in this repo was a claim stronger than the
 * code. This is a claim about a capability the code CANNOT PERFORM — the same defect with the
 * opposite sign — and nothing looked for it, because no guard checks that a documented mechanism
 * is reachable from a real entry point. See `ERRORS.md` E-UNREACHABLE.
 *
 * Read from a FILE rather than an argument, following `--tls-key`: a secret on a command line is
 * in the process table and in a shell history.
 */
const removalTokenFile = flag("removal-token-file");
const removalToken = removalTokenFile ? removalAuthorityFromFile(removalTokenFile) : undefined;

const { url } = await serve(vault, Number(flag("port", "8080")), {
  observeTransport: args.includes("--observe-transport"),
  rateLimit,
  ...(removalToken ? { removalToken } : {}),
  ...(tlsKey ? { tls: { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) } } : {}),
});

console.log(`vault on ${url}`);
console.log(`invites  ${invites.length}`
  + (invites.length ? "  (how you hand these out decides whether they are an identity —" : "")
  + (invites.length ? "\n         one per named person makes the invite an identity that arrives"
    + "\n         with the object. `--generate-invites N` explains the trade.)" : ""));
console.log(`storage  ${flag("dir") || "memory only — everything is lost on restart"}`);
console.log(`limiter  ${mode}${mode === "none" ? "" : ` at ${perMinute}/min`}`
  + `${mode === "per-peer" ? "  (adds rate.peerBucket to the table)" : ""}`);
// PRINTED BECAUSE THE ABSENCE IS THE DEFECT. Every other capability's state is announced here —
// the limiter, transport observation, read logging, TLS — and takedown was the one that was not,
// which is why a vault that could not perform it looked exactly like one that could.
console.log(removalToken
  ? "takedown  public takedown ENABLED (--removal-token-file); encrypted objects are never\n"
    + "          removable this way — they are deleted by capability, see decisions/0035"
  : "takedown  public takedown DISABLED — no --removal-token-file, so DELETE is refused. The\n"
    + "          moderation pipeline cannot remove anything from this vault.");
if (args.includes("--observe-transport")) console.log("transport observation is ON");
if (args.includes("--observe-reads")) console.log("read logging is ON");
console.log(tlsKey
  ? "transport TLS terminates here; session tickets are disabled, so every connection is a full\n         handshake and two connections cannot be linked to one client"
  : "transport PLAINTEXT — anyone on the path reads every id and every body");
