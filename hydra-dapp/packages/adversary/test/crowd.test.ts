/**
 * The crowd, as a computation.
 *
 * `live-crowd.test.ts` measures this against real mainnet and is opt-in. This checks the rules
 * that make the number safe to show, hermetically — the three from `decisions/0029` that a
 * natural implementation gets wrong, plus the guards that keep them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  crowdOf, accuracyAgainst, regularity, prune, linkability, DEFAULT_PRUNING,
} from "../../channel/src/crowd.ts";
import type { Publisher } from "../../channel/src/crowd.ts";

const W = 240_000;
/** An account that published at these times, irregularly enough to survive pruning. */
const at = (account: string, ...times: number[]): Publisher => ({ account, times });

/** Irregular by construction: gaps that vary widely, so `regularity` exceeds 1. */
const bursty = (account: string, base: number): Publisher =>
  ({ account, times: [base, base + 5_000, base + 700_000, base + 705_000, base + 2_000_000] });

test("a candidate counts only if it covers EVERY upload", () => {
  const uploads = [1_000, 500_000];
  // Covers both windows.
  const both = at("both", 0, 400_000);
  // Covers the first only — and "most" is not a crowd.
  const one = at("one", 0);
  assert.equal(crowdOf(uploads, [both], W), 1);
  assert.equal(crowdOf(uploads, [one], W), 0);
  assert.equal(crowdOf(uploads, [both, one], W), 1);
});

test("an upload exactly on a window's edge is inside it, and one past it is not", () => {
  // Half-open `[t, t + W)`, matching `scheduleUpload`, which draws from the same interval. An
  // off-by-one here would count an account that could not have produced the upload.
  assert.equal(crowdOf([0], [at("x", 0)], W), 1);
  assert.equal(crowdOf([W - 1], [at("x", 0)], W), 1);
  assert.equal(crowdOf([W], [at("x", 0)], W), 0);
});

test("no uploads is refused rather than answered", () => {
  // A crowd of "everyone" is the answer to a question nobody asked, and it is the answer that
  // over-claims. `every` over an empty array is true, which is exactly how it would arise.
  assert.throws(() => crowdOf([], [at("x", 0)], W), /there are none/);
});

test("THE AVERAGING TRAP, demonstrated so it is not re-introduced", () => {
  // `E[1/(1+X)]` is not `1/(1+E[X])`, and the gap runs toward over-claiming safety. This is the
  // arithmetic behind the measured 0.204-vs-0.365 discrepancy in `decisions/0029`.
  const crowds = [0, 0, 0, 0, 12];
  const mean = crowds.reduce((a, b) => a + b, 0) / crowds.length;
  const wrong = accuracyAgainst(mean);
  const right = crowds.reduce((a, c) => a + accuracyAgainst(c), 0) / crowds.length;
  assert.ok(right > wrong * 2,
    `averaging the crowd first gives ${wrong.toFixed(3)} against the true ${right.toFixed(3)} — `
    + "if these ever agree, the warning in crowd.ts is stale");
  // Four of those five conversations are named outright, and the averaged figure hides it.
  assert.equal(accuracyAgainst(0), 1);
});

test("pruning can only shrink the crowd, which is what makes it a lower bound", () => {
  const uploads = [1_000, 500_000];
  const others = [
    bursty("human-1", 0), bursty("human-2", 100),
    at("bot", ...Array.from({ length: 40 }, (_, i) => i * 60_000)),
  ];
  const raw = crowdOf(uploads, others, W);
  const pruned = crowdOf(uploads, prune(others), W);
  assert.ok(pruned <= raw, `pruning grew the crowd, ${raw} -> ${pruned}`);
  assert.ok(accuracyAgainst(pruned) >= accuracyAgainst(raw),
    "pruning made the operator worse — discounting candidates cannot help the person hidden "
    + "among them");
});

test("the metronome is pruned and the irregular publisher is not", () => {
  const bot = at("bot", ...Array.from({ length: 20 }, (_, i) => i * 60_000));
  assert.equal(regularity(bot.times), 0, "a perfectly regular account did not score zero");
  const kept = prune([bot, bursty("human", 0)]).map((p) => p.account);
  assert.deepEqual(kept, ["human"]);
});

test("too few events is 'not evidently automated', not 'automated'", () => {
  // The conservative direction for a regularity SCORE is high, because low is what gets pruned.
  // Returning 0 for an account with two events would discount most of the chain.
  assert.equal(regularity([1, 2]), Infinity);
  assert.equal(regularity([1, 2, 3]), Infinity);
  assert.deepEqual(prune([at("quiet", 0, 60_000)]).map((p) => p.account), ["quiet"]);
});

test("the default pruning is scale-free, so it means the same at any size", () => {
  // `dropBusiest` was measured and is NOT the default, because dropping a fixed fifty from a set
  // of twenty removes everyone and reports a crowd of zero for a chain nobody looked at.
  assert.equal(DEFAULT_PRUNING.dropBusiest, 0);
  assert.equal(DEFAULT_PRUNING.maxRegularity, 1);
  const twenty = Array.from({ length: 20 }, (_, i) => bursty(`a${i}`, i * 37));
  assert.equal(prune(twenty).length, 20, "the default rule emptied a set it should not have");
});

test("a rule that removes every candidate is refused, not reported as zero", () => {
  const some = [bursty("a", 0), bursty("b", 1)];
  assert.throws(() => prune(some, { dropBusiest: 2 }), /removes all 2 candidates/);
  assert.throws(() => prune(some, { dropBusiest: 99 }), /chain nobody looked at/);
  // And zero candidates to begin with is a real answer — an empty chain has an empty crowd.
  assert.deepEqual(prune([], { dropBusiest: 5 }), []);
});

test("`linkability` reports the pruned crowd and says how much it discounted", () => {
  const uploads = [1_000, 500_000];
  const others = [
    bursty("human-1", 0),
    at("bot", ...Array.from({ length: 40 }, (_, i) => i * 60_000)),
  ];
  const l = linkability(uploads, others, W);
  assert.equal(l.pruned, 1, "the bot was not discounted");
  assert.equal(l.identified, accuracyAgainst(l.crowd));
  // The number a user sees is never larger than the raw one.
  assert.ok(l.crowd <= crowdOf(uploads, others, W));
});

test("ZERO IS A NORMAL ANSWER, and it is the one that matters most", () => {
  // On quiet mainnet ranges every aggressive rule reaches it. Anything built on this has to
  // render "the operator is right every time" as its ordinary case rather than its error case.
  const l = linkability([1_000], [], W);
  assert.equal(l.crowd, 0);
  assert.equal(l.identified, 1);
  assert.equal(l.pruned, 0);
});
