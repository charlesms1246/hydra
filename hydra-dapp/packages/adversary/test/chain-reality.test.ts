/**
 * What the client does when the chain behaves like a chain.
 *
 * **A LIVE TEST PROVES THE CLIENT SPEAKS CORRECTLY; A HARDER FAKE PROVES IT SURVIVES WHAT THE
 * NETWORK CAN THROW.** Neither substitutes for the other, and the second had never been attempted
 * here: `memoryChain` returned only this client's events, ignored the block range it was handed,
 * numbered blocks `0, 1, 2…`, and could not fail.
 *
 * The audit that produced this found the rule violated in the other direction too — `starknet()`'s
 * `events()` and `publishers()` are exercised by nothing but a double — which `live-chain-client`
 * covers separately.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { memoryChain } from "../../cli/src/chain.ts";

test("A FAILED PUBLISH IS NOT SWALLOWED, and nothing is recorded as sent", async () => {
  // No test had ever seen a failed publish — no gas failure, no nonce collision, no rejection —
  // so an entire class of error handling had zero coverage. A swallowed failure plus a fixture
  // that never fails is how a bug lives forever.
  const chain = memoryChain({ failPublishOn: 2 });
  await chain.publish([1n, 2n]);
  await assert.rejects(() => chain.publish([3n, 4n]), /refused the transaction/);
  // The refused one did not land, and the ledger says so — a client that recorded it as sent would
  // wait forever for a message the chain never carried.
  assert.deepEqual(chain.published, [[1n, 2n]]);
  // And the chain keeps working afterwards: a failure is not a poisoned client.
  await chain.publish([5n, 6n]);
  assert.equal(chain.published.length, 2);
});

test("FOREIGN EVENTS ARE THE DEFAULT, because a real chain has other people on it", async () => {
  const chain = memoryChain();
  await chain.publish([0xaaan, 0xbbbn]);
  await chain.publish([0xcccn, 0xdddn]);
  const events = await chain.events();

  // Interleaved rather than appended: a reader that only looked at the tail would still pass.
  assert.ok(events.length > chain.published.length,
    "the default stream carries only this client's events, which no real chain does");
  const mine = events.filter((e) => chain.published.some(([p]) => p === e.data[0]));
  assert.equal(mine.length, 2);
  assert.notDeepEqual(events.slice(-2).map((e) => e.data[0]), [0xaaan, 0xcccn]);

  // And the clean stream is available for a test that genuinely measures something else.
  const alone = memoryChain({ own: true });
  await alone.publish([1n, 2n]);
  assert.equal((await alone.events()).length, 1);
});

test("BLOCK NUMBERS LOOK LIKE BLOCK NUMBERS, so wrong arithmetic is visibly wrong", async () => {
  // Sequential-from-zero is what let `blockNumber * blockMs` pass for a wall clock — about 4.2e11
  // against uploads at 1.8e12 — so the crowd was always empty and the emptiness read as the honest
  // common case rather than as a bug. That cost four bugs in one feature.
  const chain = memoryChain({ own: true });
  await chain.publish([1n, 2n]);
  const [event] = await chain.events();
  assert.ok((event.blockNumber ?? 0) > 1_000_000, "block numbers start near zero again");
  assert.match(String(event.txHash), /^0x[0-9a-f]+$/);
});

test("PUBLISHERS IS ASKED FOR A RANGE, and the range it is asked for is inspectable", async () => {
  // The fake took NO arguments while the signature declared two, so `narrowCrowd`'s block-range
  // computation was handed to something that discarded it — making any error in that computation
  // structurally invisible, on the feature that has already produced five bugs.
  //
  // Recording rather than filtering is the honest check: filtering strictly would force every
  // crowd fixture to model block placement, which is brittle and proves less than being able to
  // assert the range the caller actually computed.
  const chain = memoryChain({ crowd: [{ account: "0xaaa", at: [1_000, 2_000] }] });
  await chain.publishers!(100, 200);
  assert.deepEqual(chain.asked, [{ from: 100, to: 200 }]);

  // A range that is not a range is refused rather than quietly returning everything — which is
  // what a caller computing `Math.min` over an empty list would produce.
  await assert.rejects(() => chain.publishers!(NaN, 5), /which is not a range/);
  await assert.rejects(() => chain.publishers!(9, 2), /which is not a range/);
});

test("a chain with no crowd still cannot answer publishers, so unmeasured stays reachable", async () => {
  // `linkabilityOf` distinguishes "measured zero" from "cannot answer", and the second is a real
  // state a client is in. A fake that always answered would make it unreachable.
  const chain = memoryChain();
  assert.equal(chain.publishers, undefined);
});
