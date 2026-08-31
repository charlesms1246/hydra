/**
 * The adversary is the maximum over strategies, not the first one anyone thought of.
 *
 * Every I3 harness measured one matcher — for each chain event, the nearest upload — and wrote
 * the result down as *the* result. It is not: an order-preserving matcher scores 0.227 on an
 * undefended session against greedy's 0.138, so every undefended number this project published
 * was too kind to the defence.
 *
 * That is the second time the same mistake has produced a number: the jitter curve was measured
 * with an evenly-spread model and reported as though it were a real random source. Both times
 * the error was measuring the case that came to mind and treating it as the case.
 *
 * So this file pins what each strategy achieves, requires the harnesses to take the maximum, and
 * asserts the specific inversions that make a single-strategy harness misleading.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MATCHERS, best } from "../src/matchers.ts";
import type { Arrival } from "../src/matchers.ts";
import { scheduleUpload } from "../../channel/src/schedule.ts";
import { coverPlan } from "../../channel/src/cover.ts";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const BLOCK = 30_000;
const N = 12;
const CHANCE = 1 / N;
const cfg = { blockMs: BLOCK };

function sessions(withCover: boolean, trials = 1500, seed = 23) {
  const random = lcg(seed);
  const out: { events: number[]; uploads: Arrival[] }[] = [];
  for (let t = 0; t < trials; t++) {
    const events = Array.from({ length: N }, (_, i) => i * BLOCK);
    const uploads: Arrival[] = events.map((at, seq) => ({ t: scheduleUpload(at, cfg, random), real: true, seq }));
    if (withCover) {
      for (const d of coverPlan(events.map((at) => ({ at, bucket: 1024 })), cfg, random)) {
        uploads.push({ t: d.at, real: false, seq: -1 });
      }
    }
    out.push({ events, uploads });
  }
  return out;
}

/** Per-strategy scores, so the inversions below are about measurements and not vibes. */
function perMatcher(runs: ReturnType<typeof sessions>) {
  return Object.fromEntries(MATCHERS.map((m) => {
    let first = 0;
    let mean = 0;
    for (const s of runs) {
      const hits = m.run(s.events, s.uploads);
      first += hits[0];
      mean += hits.reduce((a, b) => a + b, 0) / hits.length;
    }
    return [m.name, { first: first / runs.length, mean: mean / runs.length }];
  }));
}

test("the strategy the harnesses used is not the strongest one", () => {
  // The finding. Undefended, ordering survives jitter long after distance stops being
  // informative, so sorting beats measuring — by a lot.
  const undefended = perMatcher(sessions(false));
  assert.ok(undefended.ordered.mean > undefended.greedy.mean * 1.4,
    `ordered ${undefended.ordered.mean.toFixed(3)} should clearly beat greedy ${undefended.greedy.mean.toFixed(3)}`);
  assert.ok(undefended.ordered.mean > 0.2,
    `the strongest undefended attack scores ${undefended.ordered.mean.toFixed(3)}; it was reported as ~0.14`);
});

test("the smarter-looking strategy is worse, which is worth having measured", () => {
  // A one-to-one assignment is more disciplined and does worse: two events genuinely can be
  // nearest the same upload, and forbidding that costs more than the discipline gains.
  const undefended = perMatcher(sessions(false));
  assert.ok(undefended.unique.mean < undefended.greedy.mean,
    "the unique assignment beat greedy — recheck which is the honest baseline");
});

test("cover defeats every strategy, and the max is what says so", () => {
  const defended = best(sessions(true));
  assert.ok(defended.mean.mean < CHANCE * 1.2,
    `the best mean against cover is ${defended.mean.mean.toFixed(3)}, chance is ${CHANCE.toFixed(3)}`);
  assert.ok(defended.first.first < 0.16,
    `the best first-message attack against cover is ${defended.first.first.toFixed(3)}`);
});

test("the max is taken per metric, and the winner can change under a new strategy", () => {
  // The max is per metric because the winners CAN differ, not because they currently do — and
  // this is now the second time the answer has moved. Greedy won both until `after-the-burst`
  // was added for the resident client, and it edges greedy on the first message here by about
  // **0.002**: cover outnumbers messages four to one, so discarding dense runs of arrivals
  // removes decoys slightly more often than it removes messages. A hair, on a model with no
  // bursts in it at all — which is exactly why the harness reports a maximum instead of a
  // strategy.
  const defended = best(sessions(true));
  const each = perMatcher(sessions(true));
  for (const metric of ["first", "mean"] as const) {
    const by = defended[metric].by;
    assert.ok(["greedy", "after-the-burst"].includes(by),
      `${by} now wins the ${metric}; if that is a new strategy, say what it exploits`);
    // And it wins by nothing. Naming a winner without the margin is how a 0.002 difference gets
    // read as a strategy being better, which is the mistake this whole file is about.
    const margin = Math.abs(each.greedy[metric] - each["after-the-burst"][metric]);
    assert.ok(margin < 0.01,
      `${by} leads by ${margin.toFixed(3)} on the ${metric} — that is a finding, not a tie`);
  }
  // What must hold regardless: the reported max is at least every individual strategy's score.
  for (const [name, score] of Object.entries(each)) {
    assert.ok(defended.first.first >= score.first - 1e-9, `${name} beat the reported first-message max`);
    assert.ok(defended.mean.mean >= score.mean - 1e-9, `${name} beat the reported mean max`);
  }
});

test("below chance is not safety, and taking the max is what prevents claiming it", () => {
  // Cover drives the order-preserving matcher to near zero — far below chance. A harness
  // reporting only that would claim a defence far stronger than the 0.12-ish an operator
  // actually achieves with a different strategy.
  const defended = perMatcher(sessions(true));
  assert.ok(defended.ordered.first < CHANCE / 4,
    "the ordered matcher should collapse under cover; if not, this comment is stale");
  const claimed = best(sessions(true)).first.first;
  assert.ok(claimed > defended.ordered.first * 10,
    "the max is not meaningfully above the weakest strategy — the max has stopped doing work");
});

test("the first-message leak survives every jitter width and only cover closes it", () => {
  // `first-is-first` answers one question and no others, which is exactly why it isolates the
  // structural leak: an upload cannot precede its own event, so the earliest upload is the
  // first message unless something else was uploaded before it.
  const undefended = perMatcher(sessions(false));
  assert.ok(undefended["first-is-first"].first > 0.4,
    "the cheapest possible attack should still find the first message undefended");
  const defended = perMatcher(sessions(true));
  assert.ok(defended["first-is-first"].first < 0.05,
    "cover should be what defeats it, since no jitter width does");
});

test("every matcher explains itself and they are distinct", () => {
  assert.equal(new Set(MATCHERS.map((m) => m.name)).size, MATCHERS.length);
  for (const m of MATCHERS) {
    assert.ok(m.why.length > 30, `${m.name} does not say what it tries`);
  }
  // And they genuinely differ: identical strategies under two names would inflate the max's
  // apparent coverage without adding any.
  const runs = sessions(false, 200);
  const shapes = new Set(MATCHERS.map((m) => JSON.stringify(m.run(runs[0].events, runs[0].uploads))));
  assert.ok(shapes.size >= 3, "the strategies are not meaningfully different from each other");
});
