/**
 * The prune predicate failed open on the most obviously automated accounts.
 *
 * **`regularity()` RETURNED `Infinity` FOR 100 TRANSACTIONS IN ONE BLOCK** — "not evidently
 * automated" — so the account counted in the crowd. The documented gate is `times.length < 4`,
 * "too few events to say"; it was not the gate that decided. Gaps were filtered to `g > 0` and
 * gated again on `gaps.length < 3`, making the effective gate **fewer than four DISTINCT
 * timestamps**, and `chain.ts` stamps every transaction in a block with that block's time.
 *
 * **THE DIRECTION IS WHY THIS MATTERED MORE THAN THE ARITHMETIC.** Not pruned means a larger
 * crowd, a lower reported operator accuracy, and a user told they are harder to identify than they
 * are. `crowd.ts`'s own Rule 2: the pruned figure *"cannot tell a user they are safer than they
 * are."*
 *
 * And the set-theoretic argument does not cover it: "pruning only ever removes" is a claim about
 * the FILTER, and the failure was in the PREDICATE.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { regularity } from "../../channel/src/crowd.ts";

const T0 = 1_800_000_000_000;
const BLOCK = 30_000;

/** `blocks` blocks, `per` transactions in each, stamped the way `publishers()` stamps them. */
const batched = (blocks: number, per: number): number[] => {
  const t: number[] = [];
  for (let b = 0; b < blocks; b++) for (let i = 0; i < per; i++) t.push(T0 + b * BLOCK);
  return t;
};

test("MANY TRANSACTIONS IN FEW BLOCKS IS AUTOMATION, and is not kept in the crowd", () => {
  // The table as measured before the fix. Every row that says KEPT was scoring `Infinity`.
  for (const [blocks, per] of [[3, 2], [2, 50], [1, 100], [2, 2], [1, 4]] as const) {
    const score = regularity(batched(blocks, per));
    assert.notEqual(score, Infinity,
      `${blocks * per} transactions across ${blocks} block(s) scores "not evidently automated", so `
      + "the account counts in the crowd — which reports a LOWER operator accuracy and tells the "
      + "user they are harder to identify than they are");
    assert.equal(score, 0,
      `${blocks} x ${per} scores ${score}: more events than distinct times is a block carrying `
      + "several transactions from one account, which a person does not do");
  }
});

test("AND AN ACCOUNT WITH GENUINELY TOO FEW EVENTS IS STILL NOT ACCUSED", () => {
  // The other half. Scoring everything 0 would also pass the test above, and would prune the whole
  // chain — a crowd of nobody is not a conservative crowd, it is a broken one.
  for (const times of [[T0], [T0, T0 + BLOCK], [T0, T0 + BLOCK, T0 + 2 * BLOCK]]) {
    assert.equal(regularity(times), Infinity,
      `${times.length} event(s) at distinct times is not enough to call automation`);
  }
});

test("A METRONOME SCORES 0 AND AN IRREGULAR ACCOUNT DOES NOT", () => {
  // The property the metric is for, unchanged by the fix.
  const metronome = [0, 1, 2, 3, 4, 5].map((i) => T0 + i * BLOCK);
  assert.equal(regularity(metronome), 0);
  const irregular = [0, 1, 5, 6, 20, 40].map((i) => T0 + i * BLOCK);
  assert.ok(regularity(irregular) > 0.5,
    `an irregular account scores ${regularity(irregular)}, so a human is pruned as a bot`);
});

test("THE SCORE DOES NOT DEPEND ON THE ORDER IT IS HANDED", () => {
  // `regularity` required `times` ascending and said so nowhere: the same six timestamps shuffled
  // moved from 0 to `Infinity` — the same account, twice the claimed safety. Not reachable through
  // `publishers()`, which iterates blocks in order, but a precondition nobody wrote down is one
  // nobody can keep, and an exported function does not get to assume its caller.
  const times = [0, 1, 2, 3, 4, 5].map((i) => T0 + i * BLOCK);
  const shuffled = [times[3]!, times[0]!, times[5]!, times[1]!, times[4]!, times[2]!];
  assert.equal(regularity(shuffled), regularity(times),
    "shuffling the same events changes the score, so the metric depends on an ordering the "
    + "signature does not require");
});
