/**
 * I3, second half — the upload schedule, run against the real scheduler.
 *
 * `i3-timeline-join.test.ts` computes what jitter is needed and models it inline. This file
 * takes the operator from that harness and points it at `channel/src/schedule.ts`, over many
 * randomised sessions, so the number stops being a note in a decision record and becomes
 * something the code enforces.
 *
 * The two are different kinds of evidence and they disagree, which is the point. The
 * deterministic sweep spreads jitter evenly and finds chance at four block intervals. A real
 * uniform source clusters, and sampling it shows the accuracy is asymptotic ABOVE chance and
 * never arrives — so the deterministic number was the best case, and taking it for the real
 * one would have shipped a defence that does not hold.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_JITTER_BLOCKS, jitterWindowMs, scheduleUpload, assertSafeSchedule,
} from "../../channel/src/schedule.ts";

/**
 * A seeded LCG. Not for cryptography — this is the *test's* randomness, and it has to be
 * reproducible: a privacy check that fails one run in twenty gets re-run until it passes.
 * The scheduler's own default is `crypto.randomInt`, which is the one that matters.
 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const BLOCK = 30_000;
const MESSAGES = 12;

/** One session: chain events one block apart, uploads placed by the real scheduler. */
function run(random: () => number, cfg: { blockMs: number; jitterBlocks?: number }) {
  const events = Array.from({ length: MESSAGES }, (_, i) => i * cfg.blockMs);
  const uploads = events.map((at) => scheduleUpload(at, cfg, random));
  let correct = 0;
  for (let i = 0; i < events.length; i++) {
    let best = -1;
    let gap = Infinity;
    for (let j = 0; j < uploads.length; j++) {
      const d = Math.abs(uploads[j] - events[i]);
      if (d < gap) { gap = d; best = j; }
    }
    if (best === i) correct++;
  }
  return { correct, events, uploads };
}

test("a schedule below the measured threshold is refused, not quietly accepted", () => {
  // The failure this prevents: "upload jitter relative to the chain event" implemented as a
  // few seconds, which i3-timeline-join measures as identical to no jitter at all. A config
  // that buys nothing must be an error, because it reads like a defence.
  for (const jitterBlocks of [0, 0.5, 1, 2, MIN_JITTER_BLOCKS - 0.01]) {
    assert.throws(() => assertSafeSchedule({ blockMs: BLOCK, jitterBlocks }), /jitter/i,
      `jitterBlocks=${jitterBlocks} was accepted`);
  }
  assert.doesNotThrow(() => assertSafeSchedule({ blockMs: BLOCK }));
  assert.doesNotThrow(() => assertSafeSchedule({ blockMs: BLOCK, jitterBlocks: 8 }));
  // And scheduling refuses too — the guard is not something a caller can forget to call.
  assert.throws(() => scheduleUpload(0, { blockMs: BLOCK, jitterBlocks: 1 }), /jitter/i);
});

test("the default window is where the measured curve flattens", () => {
  assert.equal(MIN_JITTER_BLOCKS, 8);
  assert.equal(jitterWindowMs({ blockMs: BLOCK }), 8 * BLOCK);
  assert.equal(jitterWindowMs({ blockMs: BLOCK, jitterBlocks: 10 }), 10 * BLOCK);
});

test("an upload never precedes the event that announced it", () => {
  // The pointer is on chain before the blob exists to fetch. A negative delay would mean the
  // vault held the message before anyone could have asked for it, which is both wrong and a
  // far worse correlation than the one being defended against.
  const random = lcg(11);
  for (let trial = 0; trial < 200; trial++) {
    const { events, uploads } = run(random, { blockMs: BLOCK });
    for (let i = 0; i < events.length; i++) {
      assert.ok(uploads[i] >= events[i]);
      assert.ok(uploads[i] < events[i] + jitterWindowMs({ blockMs: BLOCK }));
    }
  }
});

test("jitter never reaches chance, and the curve says where to stop paying for it", () => {
  // The correction this file exists to record. `i3-timeline-join` sweeps a DETERMINISTIC,
  // evenly-spread jitter and finds chance at four block intervals. That is the best case, not
  // the real one: a real uniform source clusters, and the accuracy is asymptotic above chance.
  //
  //     4 -> 0.182    8 -> 0.135    16 -> 0.115    32 -> 0.101    48 -> 0.095   (chance 0.083)
  //
  // Twenty-four minutes of latency still leaves the operator above chance. So no configuration
  // satisfies I3's "cannot match a single pair", and widening the window past the default buys
  // roughly 0.02 for four times the delay.
  const rate = (jitterBlocks: number) => {
    const random = lcg(7);
    let total = 0;
    for (let t = 0; t < 400; t++) total += run(random, { blockMs: BLOCK, jitterBlocks }).correct;
    return total / (400 * MESSAGES);
  };
  const at8 = rate(8);
  const at32 = rate(32);
  assert.ok(at8 < 0.16, `accuracy ${at8.toFixed(3)} at the default is worse than measured`);
  assert.ok(at32 > 0.083, `accuracy ${at32.toFixed(3)} claims to beat chance — recheck the matcher`);
  assert.ok(at8 - at32 < 0.06,
    "quadrupling the window should buy very little; if it buys a lot the curve moved");
});

test("the residual is the first message, and more jitter does not fix it", () => {
  // The structural leak: an upload cannot precede its own event, so the earliest upload of a
  // session is almost always the first message's. Per-message accuracy at four blocks runs
  // 0.65 for message one and ~0.11 for the rest; at sixteen the first is still 0.32.
  //
  // This is the finding that tells Phase 3 what to build. The fix is not a wider window — it
  // is that the first real upload must not be the earliest thing the operator sees, which
  // means cover traffic before a session opens, and that needs the vault server.
  const perMessage = (jitterBlocks: number) => {
    const random = lcg(7);
    const hits = new Array(MESSAGES).fill(0);
    const trials = 1000;
    for (let t = 0; t < trials; t++) {
      const { events, uploads } = run(random, { blockMs: BLOCK, jitterBlocks });
      for (let i = 0; i < MESSAGES; i++) {
        let best = -1;
        let gap = Infinity;
        for (let j = 0; j < uploads.length; j++) {
          const d = Math.abs(uploads[j] - events[i]);
          if (d < gap) { gap = d; best = j; }
        }
        if (best === i) hits[i]++;
      }
    }
    return hits.map((h) => h / trials);
  };
  const wide = perMessage(16);
  const interior = wide.slice(3).reduce((a, b) => a + b, 0) / (MESSAGES - 3);
  assert.ok(wide[0] > 2 * interior,
    `the first message is at ${wide[0].toFixed(2)} against ${interior.toFixed(2)} interior — ` +
    "if this stops holding, the structural leak was fixed and the docs need updating");
  assert.ok(wide[0] > 0.2, `first-message accuracy ${wide[0].toFixed(2)} — recheck before relaxing`);
});

test("the schedule reorders uploads relative to events", () => {
  // Jitter that preserves order leaves the operator a rank correlation even when nearest-in-
  // time fails: the k-th upload is still the k-th message. Wide jitter has to shuffle.
  const random = lcg(3);
  let inverted = 0;
  const trials = 200;
  for (let t = 0; t < trials; t++) {
    const { uploads } = run(random, { blockMs: BLOCK });
    for (let i = 1; i < uploads.length; i++) if (uploads[i] < uploads[i - 1]) inverted++;
  }
  const perSession = inverted / trials;
  assert.ok(perSession > 2, `only ${perSession.toFixed(1)} order inversions per session`);
});

test("the scheduler defaults to a real random source, not the test's", () => {
  // The argument exists so this file can be deterministic. If the default were ever left as
  // something predictable, every schedule above would be reconstructible by the operator.
  const a = Array.from({ length: 32 }, () => scheduleUpload(0, { blockMs: BLOCK }));
  assert.ok(new Set(a).size > 24, "the default source repeats far too often to be random");
});
