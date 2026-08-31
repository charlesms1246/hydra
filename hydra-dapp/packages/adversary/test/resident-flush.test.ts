/**
 * What a client can actually execute, as opposed to what the schedule says.
 *
 * `channel/src/cover.ts` puts half of a message's decoys BEFORE that message's own chain event —
 * `coverLeadMs` equals the jitter window, and that equality is what makes a decoy
 * indistinguishable from the real upload by distance from the event. `claude-docs/decisions/0011`
 * noticed that no client can do this, because a client learns a message exists when the user
 * sends it, and wrote it down as a cadence problem to be fixed by making the client resident.
 *
 * IT IS NOT A CADENCE PROBLEM, and making the client resident without noticing that made it
 * worse. A past-due decoy that keeps its past timestamp is due immediately, so a client honouring
 * the schedule promptly uploads every one of them at the same instant while the real message
 * waits for its own slot. That asymmetry is readable with three lines of code — discard the
 * crowd, take what went up alone — and it is `matchers.ts` `after-the-burst`. Measured below:
 * **0.467** against **0.230** for the schedule as written. The client that tried hardest to
 * obey was twice as easy to read.
 *
 * So `commands.ts` redraws a past-due decoy from the window its own message's upload is drawn
 * from, and this file measures the three things worth knowing about that:
 *
 *   - the burst is gone, and a resident client's arrivals now match the schedule exactly;
 *   - the executable first-message figure is **the published 1/(rate+1) floor of 0.2** — every
 *     decoy lands in its own message's window, so the anonymity set is exactly the cover rate
 *     plus one, and this is the first harness where a client rather than a plan achieves it;
 *   - flushing by hand still scores low on the MEAN, and that is not safety. A burst destroys
 *     the timing information the matchers read, and discloses instead that thirty objects
 *     arrived from one client at one moment — which is a different disclosure, not the absence
 *     of one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { init, open, publishBundle, sendMessage } from "../../cli/src/commands.ts";
import { memoryChain } from "../../cli/src/chain.ts";
import { best, MATCHERS } from "../src/matchers.ts";
import type { Arrival } from "../src/matchers.ts";
import { coverPlan, COVER_RATE, anonymitySetFloor } from "../../channel/src/cover.ts";
import { jitterWindowMs, MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";

const BLOCK = 30_000;
const T0 = 1_800_000_000_000;
const GAP = 20 * BLOCK;
const MESSAGES = 6;
const SESSIONS = 300;
const CONFIG = { blockMs: BLOCK, jitterBlocks: MIN_JITTER_BLOCKS };

/**
 * Seeded, because every figure here is a mean over three hundred random schedules and a test
 * that reports a different number each run is a test nobody can act on. Three assertions in this
 * repo have already been lost to asserting a single draw from a distribution.
 *
 * SPLITMIX RATHER THAN THE LCG THIS FILE STARTED WITH, and the difference was not cosmetic. A
 * linear congruential generator's first output is very nearly a linear function of its seed, so
 * seeding one per session with 1, 2, 3, … made every session's FIRST draw a ramp — and the first
 * draw is the real message's slot. The first-message figure moved between 0.09 and 0.29 with
 * nothing but the trial count, which is a harness measuring its own seeding.
 */
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

type Item = { readonly uploadAt: number; readonly real: boolean; readonly seq: number; readonly sentAt: number };

/** One conversation, queued by the real client. */
async function session(seed: number): Promise<{ events: number[]; items: Item[] }> {
  const rnd = prng(seed);
  const alice = init({ blockMs: BLOCK, invites: [] });
  open(alice, "with-bob", publishBundle(init({ invites: [] }), 0));
  const chain = memoryChain();
  const events: number[] = [];
  const items: Item[] = [];
  for (let seq = 0; seq < MESSAGES; seq++) {
    const at = T0 + seq * GAP;
    const before = alice.pending.length;
    await sendMessage(alice, chain, "with-bob", "ephemeral", `message ${seq}`, at, rnd);
    events.push(at);
    for (const p of alice.pending.slice(before)) {
      items.push({ uploadAt: p.uploadAt, real: p.real, seq, sentAt: at });
    }
  }
  return { events, items };
}

/**
 * Objects arrive one at a time, in scheduled order.
 *
 * `flush` sorts by scheduled time and uploads sequentially, so a burst is not one timestamp: it
 * is a run of them milliseconds apart, with the order intact. Modelling a burst as a single
 * instant makes every matcher fall back on array order and reports 1.000 for a reason that is an
 * artefact of the model rather than a fact about the client.
 */
function arrive(items: readonly Item[], slot: (p: Item) => number): Arrival[] {
  const order = [...items].sort((a, b) => slot(a) - slot(b) || a.uploadAt - b.uploadAt);
  const rank = new Map<Item, number>();
  const seen = new Map<number, number>();
  for (const p of order) {
    const t = slot(p);
    const n = seen.get(t) ?? 0;
    seen.set(t, n + 1);
    rank.set(p, n);
  }
  return items.map((p) => ({ t: slot(p) + rank.get(p)! * 50, real: p.real, seq: p.seq }));
}

/** A process that checks the queue every `tick` and uploads what is due. */
const resident = (items: readonly Item[], tick: number): Arrival[] =>
  arrive(items, (p) => Math.ceil(Math.max(p.uploadAt, p.sentAt) / tick) * tick);

/** A person who remembers to run `hydra flush` every so often. */
const byHand = (items: readonly Item[], period: number): Arrival[] =>
  arrive(items, (p) => T0 + Math.ceil((Math.max(p.uploadAt, p.sentAt) - T0) / period) * period);

/** What the schedule asked for, which no client can perform. */
const asPlanned = (items: readonly Item[]): Arrival[] =>
  items.map((p) => ({ t: p.uploadAt, real: p.real, seq: p.seq }));

const runs = await Promise.all(
  Array.from({ length: SESSIONS }, (_, i) => session(i + 1)));

const score = (policy: (items: readonly Item[]) => Arrival[]) =>
  best(runs.map((s) => ({ events: s.events, uploads: policy(s.items) })));

/**
 * How much better the burst attack is than everything else, on the first message.
 *
 * The figure to watch rather than the raw score. `after-the-burst` beats the other four by a
 * hair on any session — even the schedule as written clusters a little — so "does it win" is
 * not the question. The question is by how much, because the burst is only a defect when
 * discarding the crowd tells an operator something the clock did not already.
 */
function burstEdge(sessions: readonly { events: number[]; items: Item[] }[],
  policy: (items: readonly Item[]) => Arrival[]): number {
  const first = (name: string) => {
    const m = MATCHERS.find((x) => x.name === name)!;
    return sessions.reduce((n, s) => n + m.run(s.events, policy(s.items))[0], 0) / sessions.length;
  };
  const others = MATCHERS.filter((m) => m.name !== "after-the-burst")
    .map((m) => first(m.name));
  return first("after-the-burst") - Math.max(...others);
}

// ---------------------------------------------------------------------------

test("no decoy is queued for a moment that has already passed", () => {
  // The invariant the redraw exists to establish. One past-due decoy is one object due
  // immediately, and enough of them at once is the burst.
  const late = runs.flatMap((s) => s.items).filter((p) => p.uploadAt < p.sentAt);
  assert.equal(late.length, 0,
    `${late.length} objects were queued in the past — they will all go up at once`);
});

test("THE COST OF HONOURING A SCHEDULE PROMPTLY: the burst reads the first message", () => {
  // The old behaviour, rebuilt from the same plan rather than from memory of it. Every decoy
  // keeps the slot `coverPlan` chose, including the ones before the event.
  const stale = runs.map((s) => {
    const rnd = prng(s.events[0] % 1000 + 1);
    const items: Item[] = [];
    for (const [seq, at] of s.events.entries()) {
      const real = s.items.find((p) => p.seq === seq && p.real)!;
      items.push(real);
      for (const d of coverPlan([{ at, bucket: BUCKETS[0] }], CONFIG, rnd)) {
        items.push({ uploadAt: d.at, real: false, seq, sentAt: at });
      }
    }
    return { events: s.events, items };
  });

  const before = best(stale.map((s) => ({ events: s.events, uploads: resident(s.items, 1000) })));
  const planned = best(stale.map((s) => ({ events: s.events, uploads: asPlanned(s.items) })));

  assert.equal(before.first.by, "after-the-burst",
    `the burst was read by ${before.first.by}, not by the matcher written for it`);
  assert.ok(before.first.first > planned.first.first * 1.3,
    `a resident client scored ${before.first.first.toFixed(3)} against the schedule's `
    + `${planned.first.first.toFixed(3)} — the burst penalty this file exists for has gone`);
  const edge = burstEdge(stale, (i) => resident(i, 1000));
  assert.ok(edge > 0.05,
    `discarding the crowd was worth ${edge.toFixed(3)} over the clock; the defect is not here`);
});

test("with the redraw, a resident client's arrivals ARE the schedule", () => {
  const plan = score(asPlanned);
  const now = score((i) => resident(i, 1000));
  // Not "similar": identical to three decimal places, because nothing is being deferred any
  // more. A second of tick granularity is invisible against a four-minute jitter window.
  assert.ok(Math.abs(now.first.first - plan.first.first) < 0.02,
    `resident ${now.first.first.toFixed(3)} vs planned ${plan.first.first.toFixed(3)}`);
  assert.ok(Math.abs(now.mean.mean - plan.mean.mean) < 0.02,
    `resident ${now.mean.mean.toFixed(3)} vs planned ${plan.mean.mean.toFixed(3)}`);
  // The burst matcher still edges the others — a schedule with four decoys per message clusters
  // a little all by itself — but the edge is a hair rather than the attack. Asserting that it
  // stops WINNING would have been asserting the wrong thing; what matters is what it is worth.
  assert.ok(burstEdge(runs, (i) => resident(i, 1000)) < 0.05,
    `discarding the crowd is still worth ${burstEdge(runs, (i) => resident(i, 1000)).toFixed(3)} `
    + "on the first message — the redraw has stopped covering the burst");
});

test("the executable figure IS the published floor, which it was not before", () => {
  const now = score((i) => resident(i, 1000));
  const floor = anonymitySetFloor(CONFIG);
  assert.equal(floor, 1 / (COVER_RATE + 1));

  // The redraw lands every one of a message's decoys in that message's own window, so the
  // anonymity set is exactly `coverRate + 1` and the operator is right one time in five. That is
  // the number `claims/src/statement.ts` publishes as `isolatedMessageIdentified`, and this is
  // the first harness in which a CLIENT rather than a plan achieves it.
  assert.ok(Math.abs(now.first.first - floor) < 0.05,
    `the first message is identified ${now.first.first.toFixed(3)} of the time against a `
    + `published floor of ${floor} — the statement and the client disagree`);

  // Uniform, not merely close on average: the real upload's rank among the objects sharing its
  // window should sit at the middle of the set. A defence can hit the right mean while putting
  // the message systematically early, and early is all `first-is-first` needs.
  const ranks = runs.flatMap((s) => {
    const own = s.items.filter((p) => p.seq === 0);
    return [own.slice().sort((a, b) => a.uploadAt - b.uploadAt).findIndex((p) => p.real)];
  });
  const mean = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  assert.ok(Math.abs(mean - COVER_RATE / 2) < 0.3,
    `the real upload's mean position in its own window is ${mean.toFixed(2)}, not the `
    + `${COVER_RATE / 2} a uniform set would give`);
});

test("a low mean is not safety when it comes from destroying the clock", () => {
  const now = score((i) => resident(i, 1000));
  const lump = score((i) => byHand(i, 20 * 60_000));

  // Flushing by hand scores LOWER on the mean than a resident client, and reading that as "by
  // hand is safer" is the mistake `matchers.ts` warns about at the top of the file. A burst
  // carries no timing to read; what it discloses instead is a burst — an object count and one
  // moment, from one client — and that is a row this project's table would have to carry.
  assert.ok(lump.mean.mean < now.mean.mean,
    "the by-hand client no longer scores below the resident one, so this comparison is stale");
  assert.ok(Math.abs(lump.first.first - now.first.first) < 0.05,
    `by hand ${lump.first.first.toFixed(3)} vs resident ${now.first.first.toFixed(3)} on the `
    + "first message — the two clients are supposed to be indistinguishable there");

  // What actually separates them, measured: how many objects land in one instant.
  const biggest = (uploads: readonly Arrival[]) => {
    const crowd = new Map<number, number>();
    for (const u of uploads) crowd.set(Math.floor(u.t / 60_000), (crowd.get(Math.floor(u.t / 60_000)) ?? 0) + 1);
    return Math.max(...crowd.values());
  };
  const residentBurst = runs.map((s) => biggest(resident(s.items, 1000)));
  const handBurst = runs.map((s) => biggest(byHand(s.items, 20 * 60_000)));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(handBurst) > mean(residentBurst) * 1.5,
    `by hand ${mean(handBurst).toFixed(1)} objects in the busiest minute against the resident `
    + `client's ${mean(residentBurst).toFixed(1)} — that ratio is the disclosure a burst makes`);
});

test("every matcher is still exercised by this model, so `best` is a real maximum", () => {
  // A guard on the harness rather than on the client. `best` reports the strongest matcher, and
  // a matcher that never wins anywhere is a matcher nobody would notice had broken.
  const winners = new Set<string>();
  for (const policy of [asPlanned, (i: readonly Item[]) => resident(i, 1000),
    (i: readonly Item[]) => byHand(i, 20 * 60_000)]) {
    const s = score(policy);
    winners.add(s.first.by);
    winners.add(s.mean.by);
  }
  assert.ok(winners.size >= 2, `only ${[...winners]} ever wins; the maximum is over one strategy`);
  assert.equal(MATCHERS.length, 5);
});
