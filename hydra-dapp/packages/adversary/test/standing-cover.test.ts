/**
 * Cover that does not wait for a message — measured before it is built.
 *
 * `claude-docs/decisions/0022` left this open in one sentence: real cover would upload decoys on
 * the client's own schedule, so a message's window is populated before the message exists. The
 * reason to want it was never stated as an attack, and `channel/src/cover.ts` argues against it
 * on cost — per-session cover for an eleven-day conversation is 15,848 decoys to carry twelve
 * messages. A defence with a measured cost and an unmeasured benefit is not a decision yet.
 *
 * SO WHAT IS THE ATTACK. Not the anonymity set: the redraw already gives `coverRate + 1` objects
 * in every window, and a bigger set is what a higher rate buys, standing cover or not. It is
 * that TODAY EVERY UPLOAD IS CAUSED BY A MESSAGE. `commands.ts` queues objects only inside
 * `sendMessage`, so every one of a channel's uploads lands in `[event, event + window)` for some
 * event of the account that sent it. An operator holding the vault's grouping (`read.channelSet`)
 * and the public chain does not have to match an upload to an event, or count anything: they ask
 * which account's windows cover this channel's uploads, and the true account covers ALL of them
 * while a stranger's cover only what coincides.
 *
 * That is a sharper join than the `channel.author` row on the disclosure table, which needs the
 * counts to be distinct. This needs one channel and no arithmetic.
 *
 * The four policies below are the ones worth having numbers for, and the cost column is why the
 * first is not simply the answer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { COVER_RATE } from "../../channel/src/cover.ts";
import { jitterWindowMs, MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";

const BLOCK = 30_000;
const CONFIG = { blockMs: BLOCK, jitterBlocks: MIN_JITTER_BLOCKS };
const W = jitterWindowMs(CONFIG);
const MESSAGES = 6;
/** Conversational: a reply every few minutes, which is the case cover is cheapest for. */
const GAP = 8 * 60_000;
const SPAN = MESSAGES * GAP;
const SESSIONS = 400;
/** How many accounts published on the chain in the same span. The operator picks among them. */
const ACCOUNTS = 40;

/** splitmix32 — see the note in `resident-flush.test.ts` for what an LCG did to a harness here. */
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

/** Decoys at a Poisson rate over a span, as a resident client with its own clock would. */
const poisson = (from: number, to: number, perWindow: number, rnd: () => number): number[] => {
  const out: number[] = [];
  const mean = ((to - from) / W) * perWindow;
  // Inverse-transform on the exponential gaps, so the COUNT is random too. A fixed count at
  // random times is a number the operator subtracts; a random count is one they estimate.
  for (let t = from; t < to;) {
    t += -Math.log(1 - rnd()) * ((to - from) / Math.max(mean, 1e-9));
    if (t < to) out.push(t);
  }
  return out;
};

type Policy = {
  readonly name: string;
  readonly idle: (events: readonly number[], rnd: () => number) => number[];
};

/** Today. Nothing is uploaded that a message did not cause. */
const perMessage: Policy = { name: "per-message only", idle: () => [] };

/** A low standing rate for as long as the client runs, with the count random rather than fixed. */
const bounded: Policy = {
  name: "bounded idle budget",
  idle: (events, rnd) => poisson(events[0] - W, events[events.length - 1] + W, 0.5, rnd),
};

/** Standing cover only while a conversation is live, then silence. */
const decaying: Policy = {
  name: "after recent activity",
  idle: (events, rnd) => events.flatMap((e) => poisson(e, e + 4 * W, 0.5, rnd)),
};

/** The design `cover.ts` measured at 1,320x for a long conversation. */
const full: Policy = {
  name: "full session duration",
  idle: (events, rnd) =>
    poisson(events[0] - W, events[events.length - 1] + W, COVER_RATE, rnd),
};

const POLICIES = [perMessage, bounded, decaying, full];

type Run = { readonly uploads: number[]; readonly windows: number[][]; readonly truth: number };

/** One session, plus the chain the operator reads it against. */
function run(policy: Policy, seed: number): Run {
  const rnd = prng(seed);
  const events = Array.from({ length: MESSAGES }, (_, i) => i * GAP);
  const uploads: number[] = [];
  for (const e of events) {
    // The real message and its cover, all drawn from the same window — the redraw of 0022.
    for (let k = 0; k <= COVER_RATE; k++) uploads.push(e + rnd() * W);
  }
  uploads.push(...policy.idle(events, rnd));

  // The chain: the true account published at `events`, and everyone else published at their own
  // times over the same span at the same rate. A quiet chain would flatter the defence.
  const truth = Math.floor(rnd() * ACCOUNTS);
  const windows = Array.from({ length: ACCOUNTS }, (_, a) =>
    a === truth ? [...events]
      : Array.from({ length: MESSAGES }, () => rnd() * SPAN).sort((x, y) => x - y));
  return { uploads, windows, truth };
}

/** The fraction of a channel's uploads that fall inside one of this account's windows. */
const covered = (uploads: readonly number[], events: readonly number[]): number =>
  uploads.filter((u) => events.some((e) => u >= e && u < e + W)).length / uploads.length;

/** The operator's whole method: score every account, name the best. */
const identify = (r: Run): { hit: boolean; score: number } => {
  const scores = r.windows.map((w) => covered(r.uploads, w));
  const best = scores.indexOf(Math.max(...scores));
  return { hit: best === r.truth, score: scores[r.truth] };
};

const measure = (policy: Policy) => {
  const runs = Array.from({ length: SESSIONS }, (_, i) => run(policy, i + 1));
  const results = runs.map(identify);
  return {
    name: policy.name,
    accuracy: results.filter((x) => x.hit).length / SESSIONS,
    coverage: results.reduce((a, x) => a + x.score, 0) / SESSIONS,
    objects: runs.reduce((a, r) => a + r.uploads.length, 0) / SESSIONS / MESSAGES,
  };
};

/**
 * The count derivation, which is the `channel.author` row already on the disclosure table.
 *
 * The operator divides the object count by the published cover rate and reads the message count
 * back. Standing cover adds objects no message caused — so the estimate needs the idle mean
 * subtracted first, and what defeats it is not the SIZE of the idle stream but that its count is
 * random. A fixed number of idle decoys is a constant the operator subtracts exactly.
 */
const counted = (policy: Policy): number => {
  const runs = Array.from({ length: SESSIONS }, (_, i) => run(policy, i + 1));
  const idle = runs.reduce((a, r) => a + r.uploads.length, 0) / SESSIONS - MESSAGES * (COVER_RATE + 1);
  const right = runs.filter((r) =>
    Math.round((r.uploads.length - idle) / (COVER_RATE + 1)) === MESSAGES).length;
  return right / SESSIONS;
};

const TABLE = POLICIES.map((p) => ({ ...measure(p), counted: counted(p) }));
const of = (name: string) => TABLE.find((t) => t.name === name)!;

test("MEASURED: what each policy costs and what it buys", () => {
  // Printed rather than only asserted, because this table is the decision. A test that asserts
  // a threshold and shows no number is a test whose reasoning has to be reconstructed.
  const rows = TABLE.map((t) =>
    `    ${t.name.padEnd(22)} ${t.accuracy.toFixed(3)}      ${t.coverage.toFixed(3)}    `
    + `${t.counted.toFixed(3)}    ${t.objects.toFixed(1)}`);
  console.log(`\n    ${"policy".padEnd(22)} identified  covered  counted  objects/message\n`
    + `${rows.join("\n")}\n`);
  assert.equal(TABLE.length, 4);
});

test("THE NEGATIVE RESULT: standing cover does not break the account join", () => {
  // The measurement was built expecting it to, and it does not. The operator's statistic is the
  // ABSOLUTE number of a channel's uploads that a candidate account's windows cover, and an idle
  // decoy cannot reduce that number — it only adds an upload nobody covers. The true account
  // still covers every real message and every per-message decoy, which no stranger comes close
  // to, so the maximum is unchanged.
  //
  // Writing this down rather than reporting the coverage drop as a win: coverage falls from
  // 1.000 to 0.694 at thirteen objects a message and the operator is still right EVERY TIME.
  for (const t of TABLE) {
    assert.equal(t.accuracy, 1,
      `${t.name} moved the identification to ${t.accuracy.toFixed(3)} — if that is real it is a `
      + "much bigger result than this file claims, so check the model before believing it");
  }
});

test("what identification actually depends on is how busy the chain is", () => {
  // Not the defence — the CHAIN. A stranger's window covers four minutes, so once accounts
  // publish often enough for their windows to tile the span, coverage saturates for everybody
  // and the maximum stops being a name. That is the condition the join needs, and it is not one
  // the client controls, which is why it belongs in the disclosure rather than in the design.
  const busy = (perAccount: number) => {
    const runs = Array.from({ length: SESSIONS }, (_, i) => {
      const r = run(perMessage, i + 1);
      const rnd = prng(i + 9001);
      const windows = r.windows.map((w, a) => a === r.truth ? w
        : Array.from({ length: perAccount }, () => rnd() * SPAN).sort((x, y) => x - y));
      return identify({ ...r, windows });
    });
    return runs.filter((x) => x.hit).length / SESSIONS;
  };
  const quiet = busy(MESSAGES);
  const loud = busy(MESSAGES * 20);
  assert.equal(quiet, 1);
  assert.ok(loud < quiet,
    `a chain twenty times busier still identifies at ${loud.toFixed(3)} — either the windows are `
    + "not tiling or the statistic is stronger than this test assumes");
  console.log(`\n    identification, ${MESSAGES} events per account: ${quiet.toFixed(3)}`
    + `\n    identification, ${MESSAGES * 20} events per account: ${loud.toFixed(3)}\n`);
});

test("what standing cover DOES buy: an upload stops certifying a chain event", () => {
  // The disclosure that has no row. Today an upload in this channel proves the account that owns
  // it published within the last jitter window — not probably, always, because nothing uploads
  // unless a message caused it. That is a presence signal on a named account, available without
  // matching anything to anything.
  const now = of("per-message only");
  assert.equal(now.coverage, 1,
    `coverage is ${now.coverage.toFixed(3)} rather than 1 — the model has drifted from the client`);
  for (const name of ["bounded idle budget", "after recent activity", "full session duration"]) {
    assert.ok(of(name).coverage < 1,
      `${name} still covers every upload — the idle stream is not landing outside the windows`);
  }
});

test("and it turns the count derivation from an identity into an estimate", () => {
  // `channel.author` says the object count divides back to the message count EXACTLY, and the
  // row says so because it is exact. A random idle stream makes it an estimate: the operator
  // subtracts the published idle mean and is left with Poisson noise they cannot subtract.
  //
  // The degradation is real and it is not a defeat. One extra object per message takes the
  // operator from certain to right about two times in three, and buying more costs squarely —
  // the noise grows as the square root of the idle count while what it has to hide is one
  // message in `coverRate + 1` objects.
  assert.equal(of("per-message only").counted, 1,
    "the object count no longer divides back to the message count — recheck the model");
  assert.ok(of("bounded idle budget").counted < 0.8,
    `the bounded budget left the count derivation at ${of("bounded idle budget").counted.toFixed(3)}`);
  assert.ok(of("full session duration").counted > 0.2,
    `full-duration cover pushed the count derivation to `
    + `${of("full session duration").counted.toFixed(3)} for `
    + `${of("full session duration").objects.toFixed(1)} objects a message — if it really breaks `
    + "it, the cost argument in cover.ts is the only thing left standing against it");
});

test("and the anonymity set barely moves, because an idle decoy rarely lands in a window", () => {
  // The last place standing cover could have paid: a decoy that happens to fall inside a
  // message's own window enlarges the set below the published 1/(coverRate + 1). At a rate of
  // half a decoy per window it adds half an object to a set of five, and the floor is a
  // reciprocal — so this is the arithmetic, not a measurement that could have gone otherwise.
  const inWindow = (policy: Policy) => {
    const runs = Array.from({ length: SESSIONS }, (_, i) => {
      const rnd = prng(i + 4242);
      const events = Array.from({ length: MESSAGES }, (_, k) => k * GAP);
      return policy.idle(events, rnd)
        .filter((t) => events.some((e) => t >= e && t < e + W)).length / MESSAGES;
    });
    return runs.reduce((a, b) => a + b, 0) / SESSIONS;
  };
  const added = inWindow(bounded);
  const floor = 1 / (COVER_RATE + 1);
  const withIdle = 1 / (COVER_RATE + 1 + added);
  assert.ok(floor - withIdle < 0.02,
    `a bounded idle stream adds ${added.toFixed(2)} objects to a window, moving the floor from `
    + `${floor.toFixed(3)} to ${withIdle.toFixed(3)} — that is worth publishing, and this test `
    + "says it is not");
  console.log(`\n    idle objects landing in a message's own window: ${added.toFixed(2)}`
    + `\n    floor ${floor.toFixed(3)} -> ${withIdle.toFixed(3)}\n`);
});
