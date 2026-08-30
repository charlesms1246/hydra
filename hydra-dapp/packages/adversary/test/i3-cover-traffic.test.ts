/**
 * I3, third part — cover traffic against the first-message leak.
 *
 * `i3-upload-schedule.test.ts` establishes the leak and proves jitter cannot close it: an
 * upload never precedes its own event, so the session's earliest upload is almost always the
 * first message's, and the operator identifies it about 0.46 of the time against a chance of
 * 0.083. This file measures what does close it and pins the numbers `channel/src/cover.ts`
 * documents, so the table there fails rather than rots.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { scheduleUpload, jitterWindowMs } from "../../channel/src/schedule.ts";
import { coverPlan, coverBody, coverId, coverKey, COVER_RATE, COVER_LEAD_BLOCKS }
  from "../../channel/src/cover.ts";
import { channelSecret } from "../../channel/src/pointer.ts";
import { sealForChannel, wireBytes, encryptedIdFor } from "../../vault-client/src/blobs.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { rootSeed, entropyFrom, derive, VAULT_DOMAIN } from "../../identity/src/domains.ts";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const BLOCK = 30_000;
const MESSAGES = 12;
const CHANCE = 1 / MESSAGES;
const cfg = { blockMs: BLOCK };
const chan = channelSecret(
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(new Uint8Array(32).fill(6), "cover vector"))),
  "alice→bob",
);

/** Per-message accuracy for a nearest-in-time operator, with `coverRate` decoys per window. */
function accuracy(coverRate: number, trials = 2000) {
  const random = lcg(7);
  const hits = new Array(MESSAGES).fill(0);
  for (let t = 0; t < trials; t++) {
    const events = Array.from({ length: MESSAGES }, (_, i) => i * BLOCK);
    const real = events.map((at) => scheduleUpload(at, cfg, random));
    const decoys = coverRate > 0
      ? coverPlan(events[0], events.at(-1)!, { ...cfg, coverRate }, random)
      : [];
    const uploads = [...real, ...decoys];
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
  return {
    first: hits[0] / trials,
    mean: hits.reduce((a, b) => a + b, 0) / (trials * MESSAGES),
  };
}

test("cover begins before the first message, or the leak is unchanged", () => {
  // The lead is the whole mechanism. A caller — or a future refactor — that clamped these to
  // the session start would keep the storage cost and lose the defence.
  const plan = coverPlan(0, 11 * BLOCK, cfg, lcg(1));
  assert.ok(plan[0] < 0, `cover starts at ${plan[0]}, not before the first event`);
  assert.ok(plan[0] <= -COVER_LEAD_BLOCKS * BLOCK * 0.5,
    "the lead is far shorter than configured");
  assert.ok(plan.at(-1)! > 11 * BLOCK, "cover stops before the last message");
  // Sorted, so a consumer can merge it with a real schedule without re-sorting.
  assert.deepEqual([...plan].sort((a, b) => a - b), plan);
});

test("cover traffic closes the first-message leak that jitter could not", () => {
  const without = accuracy(0);
  const with4 = accuracy(COVER_RATE);
  assert.ok(without.first > 0.4, `baseline first-message accuracy is ${without.first.toFixed(2)}`);
  assert.ok(with4.first < 0.16,
    `with cover the first message is still identified ${with4.first.toFixed(2)} of the time`);
  // Better than a threshold: the improvement has to be most of the way to chance.
  const closed = (without.first - with4.first) / (without.first - CHANCE);
  assert.ok(closed > 0.85, `cover closed only ${(closed * 100).toFixed(0)}% of the gap to chance`);
});

test("the documented rate/accuracy table still holds", () => {
  // cover.ts publishes this table and picks its default from it. If the numbers move, the
  // default is no longer justified by anything and the comment is fiction.
  const rows = [0, 1, 2, 4].map((r) => [r, accuracy(r)] as const);
  const firsts = rows.map(([, a]) => a.first);
  // Monotonically better with more cover, which is the shape the default rests on.
  for (let i = 1; i < firsts.length; i++) {
    assert.ok(firsts[i] < firsts[i - 1], `rate ${rows[i][0]} is not better than rate ${rows[i - 1][0]}`);
  }
  assert.ok(Math.abs(firsts[0] - 0.46) < 0.06, `baseline moved to ${firsts[0].toFixed(2)}`);
  assert.ok(Math.abs(firsts[3] - 0.11) < 0.05, `rate 4 moved to ${firsts[3].toFixed(2)}`);
});

test("the default does not push the operator far below chance either", () => {
  // Below chance is not better. An operator whose nearest-in-time guess is reliably WRONG has
  // learned something — avoid the nearest — and can invert it. The default is chosen to sit
  // near chance from both sides rather than to minimise one number.
  const { first, mean } = accuracy(COVER_RATE);
  assert.ok(mean < CHANCE, "the mean should sit at or just below chance at the default rate");
  assert.ok(mean > CHANCE * 0.6, `mean ${mean.toFixed(3)} is far below chance ${CHANCE.toFixed(3)}`);
  assert.ok(first < CHANCE * 1.5, `first ${first.toFixed(3)} is far above chance`);
  // And a much higher rate demonstrably overshoots, which is why the default is not 8.
  assert.ok(accuracy(8).mean < mean, "a higher rate should push further below chance");
});

test("a decoy is indistinguishable from a real upload on the wire", () => {
  // Cover only covers if it looks the same. Same bucket length, and an id minted by the very
  // same function — not a second copy of it.
  for (const bucket of BUCKETS.slice(0, 3)) {
    const body = coverBody(chan, bucket);
    assert.equal(body.length, bucket);
    assert.equal(coverId(body), encryptedIdFor(body));
    assert.ok(coverId(body).startsWith("enc:"));
  }
  // A real upload in the same bucket has the same length, so length cannot separate them.
  const real = wireBytes(sealForChannel(chan, new Uint8Array(100))) as unknown as Uint8Array;
  assert.equal(real.length, BUCKETS[0]);
  assert.equal(coverBody(chan, BUCKETS[0]).length, real.length);
  // Two decoys never repeat, or a repeated id would mark them.
  assert.notEqual(coverId(coverBody(chan, BUCKETS[0])), coverId(coverBody(chan, BUCKETS[0])));
});

test("cover is per bucket, and mixing sizes is not covered", () => {
  // The limitation, asserted so it is not forgotten: a decoy in the 1 KiB bucket does nothing
  // for a 64 KiB message. An operator filters by size first and the cover evaporates.
  const small = coverBody(chan, BUCKETS[0]);
  const large = wireBytes(sealForChannel(chan, new Uint8Array(20_000))) as unknown as Uint8Array;
  assert.notEqual(small.length, large.length,
    "if these were equal the per-bucket caveat would be unnecessary");
  assert.equal(large.length, BUCKETS[3]);
  // Which is why coverBody takes a bucket rather than choosing one.
  assert.equal(coverBody(chan, BUCKETS[3]).length, large.length);
});

test("a cover rate of zero is refused rather than silently meaning none", () => {
  assert.throws(() => coverPlan(0, BLOCK, { ...cfg, coverRate: 0 }), /no cover at all/);
  // And the schedule guard still applies: cover does not excuse an unsafe jitter window.
  assert.throws(() => coverPlan(0, BLOCK, { blockMs: BLOCK, jitterBlocks: 1 }), /jitter/i);
});

test("the cover key stays in the vault domain", () => {
  // Reserved for recognisable decoys. It must not become a second route out of the domain.
  assert.equal(coverKey(chan).domain, VAULT_DOMAIN);
  assert.notDeepEqual(coverKey(chan), chan);
  assert.equal(jitterWindowMs(cfg), 8 * BLOCK);
});
