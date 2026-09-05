/**
 * The prune threshold and the window it is applied to, held together.
 *
 * **THEY WERE INCOMPATIBLE AND BOTH SENTENCES WERE IN THE SAME FILE.** `regularity` scores nothing
 * until an account shows **4 distinct block timestamps**; `commands.ts` asks the chain for
 * `ceil(jitterWindow / blockMs) + 1` = **9 blocks**. That is 44% of the blocks in the window — and
 * `crowd.ts`'s own `Pruning` note says *"most crowd members appear in under 5% of blocks"*.
 *
 * Measured on the shipped code across 20 Sepolia and 15 mainnet windows: the coefficient-of-
 * variation rule fired **once in 276 account-appearances on Sepolia and zero times in 216 on
 * mainnet.** Every prune on both chains came from the duplicate-timestamp rule.
 *
 * **THE DIRECTION IS WHAT MAKES IT A DEFECT RATHER THAN A TUNING QUESTION.** Rule 2 rests on the
 * pruned crowd being a lower bound that "cannot tell a user they are safer than they are". When
 * pruning is inert the pruned crowd IS the crowd — the property holds trivially and delivers none
 * of the conservatism it exists for.
 *
 * **THIS FILE DOES NOT ASSERT A FIX.** Widening the span is a disclosure decision, not a
 * parameter: the span is what bounds what the node learns from the request shape. What it asserts
 * is that the two numbers cannot drift apart again without somebody being told.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { regularity, DEFAULT_PRUNING } from "../../channel/src/crowd.ts";
import { MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";

/** The span `commands.ts` asks for, recomputed here from the same constants it uses. */
const BLOCK_MS = 30_000;
const SPAN = Math.ceil((MIN_JITTER_BLOCKS * BLOCK_MS) / BLOCK_MS) + 1;

/** The smallest number of distinct timestamps `regularity` will score. Derived, not typed in. */
function scoringFloor(): number {
  for (let n = 1; n <= 64; n++) {
    const times = Array.from({ length: n }, (_, i) => 1_800_000_000_000 + i * BLOCK_MS * 7);
    if (regularity(times) !== Infinity) return n;
  }
  throw new Error("regularity scores nothing at any size, which cannot be right");
}

test("THE SCORING FLOOR AND THE WINDOW ARE STILL WHAT THE COMMENTS SAY", () => {
  const floor = scoringFloor();
  assert.equal(SPAN, 9, `the window is ${SPAN} blocks; the note in crowd.ts is written for 9`);
  assert.equal(floor, 4, `regularity starts scoring at ${floor} distinct times; the note says 4`);

  // The arithmetic the two numbers imply, stated so a reader of the failure sees it.
  const needed = (floor / SPAN) * 100;
  assert.ok(needed > 40,
    `an account now needs only ${needed.toFixed(0)}% of blocks in the window to be scored, so the `
    + "note in crowd.ts saying the CV rule is effectively inert may no longer be true — check it "
    + "before trusting either sentence");
});

test("AN ACCOUNT MATCHING THE STATED POPULATION IS NEVER SCORED AT THIS WINDOW", () => {
  // "Most crowd members appear in under 5% of blocks." At 9 blocks that is at most one appearance,
  // and one appearance can never reach a floor of four. This is the incompatibility, as a test.
  const oneAppearance = [1_800_000_000_000];
  assert.equal(regularity(oneAppearance), Infinity,
    "a member appearing once in the window is being scored, which the population note says is "
    + "the common case");

  // Even a member appearing three times — three times the stated rate — is not scored.
  const three = [0, 3, 6].map((i) => 1_800_000_000_000 + i * BLOCK_MS);
  assert.equal(regularity(three), Infinity);
  assert.ok(3 < SPAN, "the window is smaller than the events this test assumes");
});

test("AND THE THRESHOLD IT CANNOT REACH IS STILL THE DOCUMENTED ONE", () => {
  // If someone changes `maxRegularity` they should see this file, because the number is only
  // meaningful together with a window an account can actually accumulate events in.
  assert.equal(DEFAULT_PRUNING.maxRegularity, 1,
    "maxRegularity changed; the inertness note in crowd.ts is written against 1 and needs "
    + "re-deriving against the new value");
});
