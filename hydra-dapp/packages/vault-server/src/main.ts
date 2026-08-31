#!/usr/bin/env node
/**
 * Run the vault.
 *
 * `HYDRA_HANDOFF.md` Phase 3 wants the vault "self-hostable and documented at launch", and
 * until now it was a class with an HTTP adapter and no way to start it — which meant the
 * disclosure table described something nobody could run.
 *
 *     node packages/vault-server/src/main.ts --port 8080 --dir ./vault --invites a,b,c
 *
 * Every default here is the more private one, and each is a decision with a row on the
 * disclosure table behind it: transport observation is OFF, rate limiting is `global` (which
 * keeps no per-client state and is worse at its job), and there is no access log. Turning any
 * of them on is one flag, which is exactly why the rows are on the table whether or not it has
 * been turned on.
 */

import { Vault } from "./server.ts";
import { serve } from "./http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import type { RateLimitConfig } from "./ratelimit.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback = ""): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

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

const { url } = await serve(vault, Number(flag("port", "8080")), {
  observeTransport: args.includes("--observe-transport"),
  rateLimit,
});

console.log(`vault on ${url}`);
console.log(`invites  ${invites.length}`);
console.log(`storage  ${flag("dir") || "memory only — everything is lost on restart"}`);
console.log(`limiter  ${mode}${mode === "none" ? "" : ` at ${perMinute}/min`}`
  + `${mode === "per-peer" ? "  (adds rate.peerBucket to the table)" : ""}`);
if (args.includes("--observe-transport")) console.log("transport observation is ON");
if (args.includes("--observe-reads")) console.log("read logging is ON");
