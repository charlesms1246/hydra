/**
 * How linkable is sending right now — the number, before anything shows it to anyone.
 *
 * `decisions/0028` measured `channel.activeAccount` and found its strength is a function of how
 * busy the chain is: 1.000 at six events per account, 0.058 at a hundred and twenty. The chain
 * is public and readable in real time, so a client cannot make it busy but it can look. That is
 * the one lever a user actually holds — choosing when — and it costs a query rather than
 * storage.
 *
 * A number in front of a user has to be right, so this file establishes what the number IS
 * before anything renders it. Three questions, in the order that matters:
 *
 *   1. What is the statistic? Not "busyness" — an anonymity set. How many other accounts could
 *      have produced uploads that look like yours.
 *   2. Does it predict the operator's accuracy? A number that does not is a decoration.
 *   3. Is the lever per-message or per-conversation? This is the one that decides what the UI
 *      may say, and the answer is not the convenient one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { COVER_RATE } from "../../channel/src/cover.ts";
import { jitterWindowMs, MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";

const BLOCK = 30_000;
const W = jitterWindowMs({ blockMs: BLOCK, jitterBlocks: MIN_JITTER_BLOCKS });
const MESSAGES = 6;
const GAP = 8 * 60_000;
const SPAN = MESSAGES * GAP;
const ACCOUNTS = 40;
const SESSIONS = 400;

/** splitmix32 — see the note in `resident-flush.test.ts`. */
const prng = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 2 ** 32;
  };
};

const covers = (uploads: readonly number[], events: readonly number[]): number =>
  uploads.filter((u) => events.some((e) => u >= e && u < e + W)).length;

type World = { uploads: number[]; events: number[]; others: number[][]; rnd: () => number };

/** A conversation, and the chain it happened on. `perAccount` is the busyness being swept. */
function world(seed: number, perAccount: number, at: (i: number) => number): World {
  const rnd = prng(seed);
  const events = Array.from({ length: MESSAGES }, (_, i) => at(i));
  const uploads: number[] = [];
  for (const e of events) for (let k = 0; k <= COVER_RATE; k++) uploads.push(e + rnd() * W);
  const others = Array.from({ length: ACCOUNTS - 1 }, () =>
    Array.from({ length: perAccount }, () => rnd() * SPAN).sort((a, b) => a - b));
  return { uploads, events, others, rnd };
}

/**
 * THE STATISTIC, and it is a count rather than a score.
 *
 * How many other accounts' windows cover EVERY one of this channel's uploads. The account that
 * sent them always does — that is the whole of `channel.activeAccount` — so the operator's
 * candidate set is this crowd plus you, and the question a user is really asking is how big it
 * is.
 */
const crowd = (w: World): number =>
  w.others.filter((o) => covers(w.uploads, o) === w.uploads.length).length;

/** The operator: argmax over accounts, ties broken by a coin, because a tie is not an answer. */
function identifies(w: World): boolean {
  const mine = covers(w.uploads, w.events);
  const tied = w.others.filter((o) => covers(w.uploads, o) >= mine).length;
  return w.rnd() < 1 / (tied + 1);
}

const sweep = (perAccount: number, at: (i: number) => number = (i) => i * GAP) => {
  const worlds = Array.from({ length: SESSIONS }, (_, i) => world(i + 1, perAccount, at));
  return {
    crowd: worlds.reduce((a, x) => a + crowd(x), 0) / SESSIONS,
    accuracy: worlds.filter(identifies).length / SESSIONS,
  };
};

// ---------------------------------------------------------------------------

test("MEASURED: the crowd, and what the operator does against it", () => {
  const rows = [3, 6, 12, 30, 60, 120, 240].map((n) => {
    const s = sweep(n);
    return `    ${String(n).padStart(4)}   ${s.crowd.toFixed(2).padStart(6)}   `
      + `${s.accuracy.toFixed(3)}   ${(1 / (1 + s.crowd)).toFixed(3)}`;
  });
  console.log(`\n    events/acct  crowd  identified  1/(1+crowd)\n${rows.join("\n")}\n`);
  assert.ok(rows.length === 7);
});

test("the number predicts the accuracy PER CONVERSATION, and never as an average", () => {
  // THE CORRECTION THIS FILE WAS WRITTEN TO CATCH, and it was caught: comparing the mean crowd
  // against the mean accuracy is wrong, and wrong in the direction that over-claims safety.
  // At thirty events per account the mean crowd is 3.9, which reads as 0.204 — and the operator
  // actually scores 0.365, because `E[1/(1+X)]` is not `1/(1+E[X])` and the gap is Jensen's.
  // Sessions with a crowd of zero are named outright and are averaged away by lucky ones.
  //
  // So the claim is conditional and an interface may only ever show a conversation ITS OWN
  // crowd. Grouped by the crowd a client would have computed for itself, the prediction holds.
  const byCrowd = new Map<number, { n: number; hit: number }>();
  for (const n of [12, 30, 60, 120]) {
    for (let i = 0; i < SESSIONS * 3; i++) {
      const w = world(i + 1 + n * 10_000, n, (k) => k * GAP);
      const c = crowd(w);
      if (c > 6) continue; // beyond this the buckets are too thin to say anything
      const cell = byCrowd.get(c) ?? { n: 0, hit: 0 };
      cell.n++;
      if (identifies(w)) cell.hit++;
      byCrowd.set(c, cell);
    }
  }
  const rows: string[] = [];
  for (const [c, cell] of [...byCrowd].sort((a, b) => a[0] - b[0])) {
    if (cell.n < 200) continue;
    const measured = cell.hit / cell.n;
    const predicted = 1 / (1 + c);
    rows.push(`    crowd ${c}: ${measured.toFixed(3)} measured, ${predicted.toFixed(3)} predicted`
      + ` (${cell.n} sessions)`);
    assert.ok(Math.abs(measured - predicted) < 0.05,
      `a conversation whose own crowd is ${c} was identified ${measured.toFixed(3)} of the time `
      + `against the ${predicted.toFixed(3)} the number would promise — the interface would be `
      + "telling the user something the measurement does not support");
  }
  console.log(`\n${rows.join("\n")}\n`);
  assert.ok(rows.length >= 3, "too few crowd values had enough sessions to check");
});

test("a quiet chain names you outright, and the crowd says so before it happens", () => {
  const quiet = sweep(6);
  assert.equal(quiet.crowd, 0, "a stranger tiled a whole session at six events — recheck W");
  assert.equal(quiet.accuracy, 1);
});

test("THE LEVER IS PER-CONVERSATION, NOT PER-MESSAGE, and one quiet message spends it all", () => {
  // The result that decides what an interface may say. A stranger joins the crowd only by
  // covering EVERY upload, so the crowd is set by the worst-covered message rather than by the
  // average. Sending five of six messages into a busy chain buys nothing if the sixth goes out
  // while nobody else is publishing.
  //
  // The chain is busy for the first half of the span and silent for the second.
  const busyHalf = (n: number) => (seed: number, quietOnes: number) => {
    const w = world(seed, n, (i) => i < MESSAGES - quietOnes
      ? (i / MESSAGES) * (SPAN / 2)          // inside the busy half
      : SPAN / 2 + (i / MESSAGES) * (SPAN / 2)); // out in the silence
    // Strangers publish only while the chain is busy, which is what "busy half" means.
    w.others = w.others.map((o) => o.map((t) => (t / SPAN) * (SPAN / 2)).sort((a, b) => a - b));
    return w;
  };
  const build = busyHalf(240);
  const meanCrowd = (quietOnes: number) =>
    Array.from({ length: SESSIONS }, (_, i) => crowd(build(i + 1, quietOnes)))
      .reduce((a, b) => a + b, 0) / SESSIONS;

  const allBusy = meanCrowd(0);
  const oneOutside = meanCrowd(1);
  console.log(`\n    every message sent into the busy chain:  crowd ${allBusy.toFixed(1)}`
    + `\n    one of six sent while it was quiet:      crowd ${oneOutside.toFixed(1)}\n`);

  assert.ok(allBusy > 5,
    `a busy chain gave a crowd of only ${allBusy.toFixed(1)} — the sweep above says otherwise`);
  assert.equal(oneOutside, 0,
    `one message outside the busy period left a crowd of ${oneOutside.toFixed(1)}; the claim `
    + "that the worst message sets the crowd is what an interface would be built on");
});

test("and the crowd a user is shown is about the past, which is not what they are buying", () => {
  // The honesty constraint. Uploads land in `[event, event + window)` — the FUTURE four
  // minutes — and no query returns those. A client can only report the chain it has seen, so
  // the number is a forecast, and the measurement here is of how wrong a forecast can be rather
  // than of how wrong it usually is: that depends on a real chain and is not knowable from a
  // model of one.
  //
  // Worst case, stated as a test so it cannot be forgotten: a chain that was busy and stops.
  // The conversation happens in the second half of the span, so the first half is the chain the
  // client would have queried and reported on.
  const w = world(1, 240, (i) => SPAN / 2 + (i / MESSAGES) * (SPAN / 2));
  const beforeSending = w.others.filter((o) =>
    o.some((t) => t < w.events[0])).length;
  // Everyone stops publishing the moment the first message goes out.
  w.others = w.others.map((o) => o.filter((t) => t < w.events[0]));
  assert.ok(beforeSending > 0, "nobody had published before the first message; model error");
  assert.equal(crowd(w), 0,
    "a chain that went silent at the moment of sending still left a crowd — then the forecast "
    + "is safe in the worst case and this warning is unnecessary");
});
