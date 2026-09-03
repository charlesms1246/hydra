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
  crowdOf, accuracyAgainst, regularity, prune, linkability, describe, DEFAULT_PRUNING,
} from "../../channel/src/crowd.ts";
import type { Publisher } from "../../channel/src/crowd.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { P } from "../../channel/src/commitment.ts";
import { saltFrom, isCommitment, NO_CHAIN } from "../../channel/src/cover.ts";

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

test("THE ZERO COPY IS WRITTEN FIRST, because zero is the usual answer", () => {
  // On quiet mainnet ranges every aggressive pruning rule reaches a crowd of zero. If the zero
  // case reads as an afterthought — an error state, a dash, a shorter line than the healthy one —
  // the feature is a reassurance meter with a bug, which is what `decisions/0029` decided against.
  const zero = describe({ known: true, crowd: 0 });
  const some = describe({ known: true, crowd: 11 });
  assert.ok(zero.length >= some.length - 1,
    "the zero case is told in fewer lines than the comfortable one");
  assert.match(zero.join(" "), /every time/,
    "the zero case does not say that the operator is right every time");
  assert.match(zero.join(" "), /usual answer/,
    "the zero case reads as exceptional; it is the common one");
});

test("not knowing is not the same as knowing zero", () => {
  // A client that has never asked a node has no number. Rendering that as a crowd of zero would
  // be an over-claim in the frightening direction, which is still an over-claim — and rendering
  // it as anything reassuring would be the dangerous one.
  const unknown = describe({ known: false, crowd: 0 });
  assert.match(unknown.join(" "), /not measured/);
  assert.match(unknown.join(" "), /not the same as a good one/);
  assert.notDeepEqual(unknown, describe({ known: true, crowd: 0 }));
});

test("the copy is a cost in the past tense, and never a badge", () => {
  // I7: this number is computed from public data and verified by nobody, so nothing may render
  // as a mark. And the number is about history — uploads land in the next four minutes and no
  // query returns those, so a future-tense promise is one nobody can make.
  for (const crowd of [0, 1, 5, 40]) {
    const text = describe({ known: true, crowd }).join(" ").toLowerCase();
    for (const word of ["safe", "secure", "anonymous", "protected", "good", "excellent", "strong"]) {
      assert.ok(!text.includes(word), `the crowd copy calls a state "${word}"`);
    }
    for (const promise of ["you will be", "will be one of", "guarantees", "ensures"]) {
      assert.ok(!text.includes(promise), `the crowd copy promises the future: "${promise}"`);
    }
    assert.match(text, /you have sent/, "the copy is not in the past tense");
  }
});

test("the copy says the number only goes down", () => {
  // `0029`'s ratchet finding: a crowd is set by its worst-covered message, and one message of six
  // sent into a quiet chain took a measured 34.9 to zero. A user who thinks waiting will restore
  // it has been told something false about a message already on the chain.
  assert.match(describe({ known: true, crowd: 9 }).join(" "), /only goes down/);
  assert.match(describe({ known: true, crowd: 9 }).join(" "), /nothing you\s+do later puts it back/);
});

test("the sentence quotes the identification rate, not an average of anything", () => {
  // `1/(1+crowd)` for THIS conversation. The Jensen gap between averaging crowds and averaging
  // reciprocals is 0.204 against 0.365, and it runs toward over-claiming safety.
  assert.match(describe({ known: true, crowd: 1 }).join(" "), /out of 2 — right about 50%/);
  assert.match(describe({ known: true, crowd: 3 }).join(" "), /out of 4 — right about 25%/);
  assert.match(describe({ known: true, crowd: 11 }).join(" "), /out of 12 — right about 8%/);
});

test("SALTFROM REFUSES WHAT CANNOT BE A COMMITMENT, because zero was the sentinel", () => {
  // The brand stops a bare `0n` being WRITTEN where a salt belongs. It does nothing about a
  // commitment field that is legitimately unset, defaulted, or zero-initialised arriving on the
  // honest path — and `saltFrom(0n)` was `NO_CHAIN`, indistinguishable to every layer below. That
  // would have restored the two-device collision through the correct constructor, with the correct
  // type, in code nobody edited wrongly.
  //
  // Not hypothetical here: `chain.ts` was found handing back `undefined` transaction hashes from a
  // mapping that had quietly stopped applying, one file over.
  for (const bad of [0n, 1n, 7n, 4096n, (1n << 64n) - 1n]) {
    assert.throws(() => saltFrom(bad), /too small to be one/,
      `saltFrom(${bad}) was accepted; a counter is not a commitment`);
  }
  // A real commitment is a Poseidon hash, uniform over the field.
  assert.doesNotThrow(() => saltFrom(1n << 64n));
  assert.doesNotThrow(() => saltFrom(P - 1n));
  assert.throws(() => saltFrom(P), /must be a felt/);

  // And the sentinel is now unreachable from the honest constructor, which is the property the
  // discriminated union would have bought — for one line and no call-site churn.
  assert.throws(() => saltFrom(NO_CHAIN));
});

test("THERE ARE EXACTLY TWO WAYS TO MAKE A SALT, and the guard asserts its own premise", () => {
  // The comment in `i3-cover-traffic.test.ts` said "the only ways to make one are `saltFrom` and
  // `NO_CHAIN`". That was true when written, and then a third constructor was added — a
  // sequence-based one for callers with no chain — and neither the grep nor its premise was
  // updated. The guard written to catch exactly this class was defeated by adding a door.
  //
  // A comment cannot hold a premise. This does: every `as Salt` in `cover.ts` is counted, so a
  // fourth door fails here rather than quietly widening what a `Salt` can be.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "channel", "src", "cover.ts"), "utf8");
  const casts = src.split("\n")
    .map((l, i) => [l, i + 1] as const)
    .filter(([l]) => /\bas Salt\b/.test(l) && !l.trimStart().startsWith("*"));
  assert.equal(casts.length, 2,
    "a Salt can now be made in a way this guard does not know about:\n"
    + casts.map(([l, n]) => `  cover.ts:${n} ${l.trim()}`).join("\n"));
  assert.ok(casts.some(([l]) => l.includes("saltFrom") || l.includes("commitment as Salt")));
  assert.ok(casts.some(([l]) => l.includes("NO_CHAIN")));

  // And the two are distinguishable, which is what the refusal buys.
  assert.equal(NO_CHAIN, 0n);
  assert.ok(!isCommitment(NO_CHAIN));
  assert.ok(isCommitment(1n << 200n));
});
