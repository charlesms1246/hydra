/**
 * Polling is constant, and nothing may make it adaptive.
 *
 * **THIS TEST IS THE THING STANDING BETWEEN THE DESIGN AND AN OBVIOUS OPTIMISATION.** `0042` §2c
 * replaces chain-event-driven reads with a fixed-rate poll, and the measurement is the whole
 * argument: an event-triggered read gives an operator **100%** precision guessing that a message
 * arrived, and a constant poll gives **the prior** — 63.6% against 63.6% in the measured fixture.
 *
 * "Poll more often when the conversation is busy" is the natural next change, it looks like a
 * latency improvement, and it would take that row from the prior back to certainty **without
 * changing a single disclosure row**. A comment asking nicely does not survive that. This does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { POLL_INTERVAL_MS } from "../../channel/src/constants.ts";
import { codeOf } from "../src/prose.ts";

const PACKAGES = join(import.meta.dirname, "..", "..");
const CLIENTS = ["cli", "tui", "client"];

const sources = () => CLIENTS.flatMap((pkg) => {
  const dir = join(PACKAGES, pkg, "src");
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => ({ path: `${pkg}/src/${f}`, code: codeOf(readFileSync(join(dir, f), "utf8")) }));
});

test("THE POLL INTERVAL IS A CONSTANT, not a function of anything", () => {
  // The property, stated so that the failure mode is named: an interval computed from traffic,
  // backlog, recency or a user setting is an adaptive poll wearing a constant's clothes.
  assert.equal(typeof POLL_INTERVAL_MS, "number");
  assert.ok(POLL_INTERVAL_MS >= 1_000,
    "a sub-second poll is a busy-wait, and its collection-time bound is no bound at all");

  const src = codeOf(readFileSync(
    join(PACKAGES, "channel", "src", "constants.ts"), "utf8"));
  assert.match(src, /export const POLL_INTERVAL_MS = [\d_]+;/,
    "the poll interval is no longer a literal — if it is now computed, it is adaptive by "
    + "definition and decisions/0042 §2c's measurement no longer describes this client");
});

test("NO CLIENT SCALES ITS POLL BY ANYTHING IT KNOWS", () => {
  // The mechanical half. An adaptive poll has to multiply, divide or branch the interval, so that
  // is what this looks for — near the interval, in code, with comments stripped so an explanation
  // of why we do not do this cannot be mistaken for doing it.
  const offenders: string[] = [];
  for (const file of sources()) {
    for (const line of file.code.split("\n")) {
      if (!line.includes("POLL_INTERVAL_MS")) continue;
      // Reading it, passing it, comparing against it: fine. Arithmetic on it: not.
      if (/POLL_INTERVAL_MS\s*[*/+-]|[*/+-]\s*POLL_INTERVAL_MS/.test(line)) {
        offenders.push(`${file.path}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    "a client is doing arithmetic on the poll interval. A poll that speeds up when a conversation "
    + "is busy correlates with arrivals, which is exactly what the constant rate exists to break — "
    + "see decisions/0042 §2c, where the difference is 63.6% against 100%.");
});

test("THE INTERVAL IS PUBLISHED, because it is the granularity of a disclosure", () => {
  // The collection-time row is bounded by the interval, so the interval is not a tuning knob that
  // can move quietly — it is the number the row's meaning depends on. Same shape as the key-at-rest
  // window: a stated number rather than a property nobody can quote.
  const constants = codeOf(readFileSync(
    join(PACKAGES, "channel", "src", "constants.ts"), "utf8"));
  assert.match(constants, /POLL_INTERVAL_MS/);
  const doc = readFileSync(join(PACKAGES, "channel", "src", "constants.ts"), "utf8");
  assert.match(doc, /collection time/i,
    "the interval no longer explains that it bounds when a reader collected a message");
  assert.match(doc, /presence/i, "the interval no longer names the presence row it creates");
});
