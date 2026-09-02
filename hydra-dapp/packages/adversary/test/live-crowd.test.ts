/**
 * The crowd, measured on a real chain rather than on a model of one.
 *
 * `decisions/0029` proposes telling a user how linkable sending is right now, and its first
 * precondition is this file: the strength of `channel.activeAccount` is a function of how busy
 * the chain is, and measuring that in a simulator would be a harness measuring its own
 * assumptions — the failure `ERRORS.md` E-SEED records. So this reads Starknet.
 *
 * IT FOUND A BUG BEFORE IT MEASURED A FORECAST. The model in `chain-busyness.test.ts` assumed
 * forty accounts publishing independently. Real Starknet is nothing like that: over 1200
 * mainnet blocks, 447 accounts sent 4529 transactions and **one** of them sent 1950 of those —
 * 43% — appearing in 960 blocks with a longest absence of two. Everything else is a long tail.
 *
 * With a crowd that concentrated, the answer depends almost entirely on the width of the jitter
 * window, and that width is `blockMs * jitterBlocks` where `blockMs` is a `--block-ms` flag.
 * Two runs, different ranges and different public nodes:
 *
 *     blockMs   window   crowd  right     crowd  right
 *       2000      16s     1.0   0.500      1.0   0.500
 *       5000      40s     1.0   0.500      1.0   0.500
 *      10000      80s     1.4   0.437      1.3   0.458
 *      30000     240s    12.6   0.076      5.5   0.184   <- the default
 *      60000     480s    65.9   0.015     31.3   0.061
 *
 * The magnitude moves by a factor of two between runs and the shape does not. That is why the
 * assertions below are on RATIOS rather than on any figure: a test pinning 12.6 would fail on
 * a quiet afternoon and teach whoever saw it that the suite is flaky.
 *
 * Setting `--block-ms` to the chain's real block interval — which is what the flag sounds like
 * it wants, and Starknet mainnet is about two seconds now — costs a factor of six and passed
 * every check `schedule.ts` had. That is `MIN_JITTER_MS`, and it exists because of this file.
 *
 * Opt-in and NOT part of `npm test`, like every other `live-` suite:
 *
 *     HYDRA_RPC=https://rpc.starknet.lava.build \
 *     HYDRA_BLOCKS=600 npm run test:live
 *
 * A missing variable fails rather than skips: the run that silently does nothing is the run
 * that gets counted as a pass.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { MIN_JITTER_BLOCKS, MIN_JITTER_MS, jitterWindowMs, assertSafeSchedule }
  from "../../channel/src/schedule.ts";
import { COVER_RATE } from "../../channel/src/cover.ts";

const RPC = process.env.HYDRA_RPC;
/** Blocks to read back from the head. 600 is about twenty minutes of mainnet. */
const COUNT = Number(process.env.HYDRA_BLOCKS ?? 600);

const MESSAGES = 6;
/** Seconds between messages — a live back-and-forth, the case cover is cheapest for. */
const GAP = 120;

type Block = { n: number; t: number; senders: string[] };
let blocks: Block[] = [];

/**
 * Retried, and it parses the TEXT rather than trusting the response to be JSON.
 *
 * A public node answers "Rate limit exceeded" as plain text with a 200, so `res.json()` throws
 * a SyntaxError that reads like a bug in this file. Backing off is the correct response to a
 * limiter and treating it as a parse failure is how a run gets abandoned for the wrong reason.
 */
const rpc = async (method: string, params: unknown, tries = 6): Promise<any> => {
  let last = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(RPC!, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const text = await res.text();
      try {
        const body = JSON.parse(text) as { result?: any; error?: { message: string } };
        if (body.error) throw new Error(`${method}: ${body.error.message}`);
        return body.result;
      } catch (e) {
        last = text.slice(0, 80);
      }
    } catch (e) {
      last = String(e).slice(0, 80);
    }
    await new Promise((s) => setTimeout(s, 400 * 2 ** attempt));
  }
  throw new Error(`${method} failed after ${tries} tries: ${last}`);
};

before(async () => {
  assert.ok(RPC, "HYDRA_RPC is required — see the header");
  const head = await rpc("starknet_blockNumber", []) as number;
  const want = Array.from({ length: COUNT }, (_, i) => head - COUNT + 1 + i);
  const got: Block[] = [];
  // Deliberately low, and pauses between requests. A public node's rate limiter is a shared
  // resource; hammering it gets the run refused and the answer is to be slower, not to retry
  // harder. Raise HYDRA_CONC against a node you pay for.
  const CONC = Number(process.env.HYDRA_CONC ?? 2);
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const n = want.shift();
      if (n === undefined) return;
      const b = await rpc("starknet_getBlockWithTxs", [{ block_number: n }]);
      got.push({ n: b.block_number, t: b.timestamp,
        senders: b.transactions.map((t: any) => t.sender_address).filter(Boolean) });
      await new Promise((s) => setTimeout(s, Number(process.env.HYDRA_PACE ?? 60)));
    }
  }));
  got.sort((a, b) => a.n - b.n);
  // A GAP IN THE DATA READS AS A QUIET CHAIN, which would make every number here flatter the
  // defence. Refusing is the only safe response to a partial read.
  assert.equal(got.length, COUNT,
    `read ${got.length} of ${COUNT} blocks — missing blocks look like a quiet chain, and a `
    + "quiet chain is exactly what these figures are measuring");
  blocks = got;
});

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

/** account -> the times it published, in seconds. */
const byAccount = (): Map<string, number[]> => {
  const m = new Map<string, number[]>();
  for (const b of blocks) for (const s of b.senders) {
    let a = m.get(s); if (!a) m.set(s, a = []); a.push(b.t);
  }
  for (const a of m.values()) a.sort((x, y) => x - y);
  return m;
};

/** A conversation's uploads, in seconds: each message plus its cover, in the message's window. */
const uploadsAt = (start: number, W: number, rnd: () => number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < MESSAGES; i++) {
    const e = start + i * GAP;
    for (let k = 0; k <= COVER_RATE; k++) out.push(e + rnd() * W);
  }
  return out;
};

/** How many accounts have a window covering EVERY one of those uploads. */
const crowdFor = (ups: readonly number[], W: number, accounts: Map<string, number[]>): number => {
  let n = 0;
  for (const [, ts] of accounts) {
    if (ups.every((u) => ts.some((t) => u >= t && u < t + W))) n++;
  }
  return n;
};

/** Mean crowd and mean per-conversation accuracy over every start time in the data. */
function sweep(W: number) {
  const accounts = byAccount();
  const T0 = blocks[0].t, T1 = blocks[blocks.length - 1].t;
  const rnd = prng(4242);
  const span = MESSAGES * GAP;
  const crowds: number[] = [];
  for (let t = T0; t + span <= T1; t += 30) crowds.push(crowdFor(uploadsAt(t, W, rnd), W, accounts));
  assert.ok(crowds.length > 0,
    `${COUNT} blocks is under ${span}s of chain — raise HYDRA_BLOCKS`);
  return {
    crowd: crowds.reduce((a, b) => a + b, 0) / crowds.length,
    // NEVER `1/(1+mean)`: `E[1/(1+X)]` is not `1/(1+E[X])` and the difference over-claims
    // safety. `chain-busyness.test.ts` has the measurement that established it.
    accuracy: crowds.reduce((a, c) => a + 1 / (1 + c), 0) / crowds.length,
    samples: crowds.length,
  };
}

// ---------------------------------------------------------------------------

test("the real chain's activity is concentrated in a handful of accounts", () => {
  const accounts = byAccount();
  const counts = [...accounts].map(([a, t]) => [a, t.length] as const)
    .sort((x, y) => y[1] - x[1]);
  const total = counts.reduce((a, b) => a + b[1], 0);
  console.log(`\n    ${blocks.length} blocks, ${accounts.size} accounts, ${total} transactions`);
  console.log(`    busiest: ${counts.slice(0, 5).map(([a, k]) =>
    `${a.slice(0, 10)}…=${k}`).join("  ")}\n`);
  // The model in `chain-busyness.test.ts` assumed independent accounts at a similar rate. This
  // is the assertion that says the real chain is not that, so nobody reads the model's forty
  // accounts as a description of anything.
  assert.ok(counts[0][1] > total * 0.1,
    `the busiest account sent ${counts[0][1]} of ${total} — if the chain has become evenly `
    + "spread, the concentration warning in this file and in 0029 is stale");
});

test("THE WINDOW IS THE WHOLE ANSWER, and --block-ms silently sets it", () => {
  const rows: string[] = [];
  const at: Record<number, { crowd: number; accuracy: number }> = {};
  for (const blockMs of [2000, 5000, 10_000, 30_000, 60_000]) {
    const W = (blockMs * MIN_JITTER_BLOCKS) / 1000;
    const s = sweep(W);
    at[blockMs] = s;
    rows.push(`    ${String(blockMs).padStart(6)}  ${String(W).padStart(4)}s  `
      + `crowd ${s.crowd.toFixed(2).padStart(6)}   right ${s.accuracy.toFixed(3)}`);
  }
  console.log(`\n    blockMs  window  crowd            operator\n${rows.join("\n")}\n`);

  // The default has to be materially better than the chain's own block interval, or the flag is
  // not a footgun and `MIN_JITTER_MS` is unnecessary.
  assert.ok(at[30_000].accuracy < at[2000].accuracy / 2,
    `a 240s window scores ${at[30_000].accuracy.toFixed(3)} against a 16s window's `
    + `${at[2000].accuracy.toFixed(3)} — the six-fold gap MIN_JITTER_MS exists for has closed`);
  // And wider still keeps paying, which is why the floor is a floor and not a target.
  assert.ok(at[60_000].accuracy < at[30_000].accuracy,
    "a wider window stopped helping; the curve in schedule.ts is stale");
});

test("the floor refuses exactly the configurations that measured badly", () => {
  // The guard, checked against the thing it was derived from rather than against itself.
  for (const blockMs of [2000, 5000, 10_000]) {
    assert.throws(() => assertSafeSchedule({ blockMs }), /window/,
      `--block-ms ${blockMs} is accepted and it measures at half the protection`);
  }
  assert.doesNotThrow(() => assertSafeSchedule({ blockMs: 30_000 }));
  assert.equal(jitterWindowMs({ blockMs: 30_000 }), MIN_JITTER_MS);
});
