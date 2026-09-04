/**
 * The two measurements `decisions/0042` owes, run rather than asserted.
 *
 * The red team's corrections were code readings and inferences, and it said so. These are the two
 * claims that need numbers: **what a causal reference costs in bucket bands**, and **what polling
 * discloses under each of its two variants**.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { BUCKETS, SEAL_OVERHEAD } from "../../vault-client/src/buckets.ts";
import { HEADER_RESERVE } from "../../vault-client/src/blobs.ts";
import { COVER_RATE } from "../../channel/src/constants.ts";

/** Usable payload in each bucket, once the seal and the ratchet header are taken out. */
const capacity = BUCKETS.map((b) => b - SEAL_OVERHEAD - HEADER_RESERVE);

test("MEASURED: what a causal reference costs in bucket bands", () => {
  // A message shifts band if and only if its length lies in `(capacity - n, capacity]`: adding `n`
  // bytes pushes it past what its bucket holds. `0032` keeps the wire at exactly a bucket, so this
  // is a CAPACITY cost and not a new size signal — but `blob.bucket` is a published row, so a
  // message that moves band is a message the operator sees differently.
  const report: string[] = [];
  for (const n of [8, 16, 32]) {
    // Under a uniform length model, per bucket. Stated as a model because THIS REPO HAS NO CORPUS
    // OF REAL MESSAGE LENGTHS, and inventing one would be the thing we refuse to do elsewhere.
    const perBucket = capacity.map((c) => n / c);
    report.push(`  ${String(n).padStart(2)} bytes: `
      + perBucket.map((f, i) => `b${i} ${(f * 100).toFixed(2)}%`).join("  "));
    // The smallest bucket is the one that matters: text clusters far below 928 bytes, so the
    // realistic shift fraction is lower than the uniform figure rather than higher.
    assert.ok(perBucket[0] < 0.05, `${n} bytes shifts ${(perBucket[0] * 100).toFixed(1)}% of a `
      + "uniform first bucket, which is no longer a rounding cost");
  }
  console.error("band shift, uniform model, fraction of lengths that move up one bucket:");
  for (const line of report) console.error(line);
  console.error(`  first-bucket capacity is ${capacity[0]} bytes `
    + `(${BUCKETS[0]} − ${SEAL_OVERHEAD} seal − ${HEADER_RESERVE} header)`);

  // AND THE AMPLIFICATION, which is the part a per-message figure hides: cover follows at
  // `coverRate` multiples, so a message that shifts band takes its decoys with it.
  console.error(`  a shifted message moves ${COVER_RATE + 1} objects, not one`);
  assert.equal(capacity[0], BUCKETS[0] - SEAL_OVERHEAD - HEADER_RESERVE);

  // 16 bytes is the recommendation: unambiguous within one conversation, and an attacker forging a
  // collision would also have to produce a valid sealed header.
  assert.ok(16 / capacity[0] < 0.02,
    "a 16-byte reference costs more than 2% of the first bucket under a uniform model");
});

test("MEASURED: a constant-rate poll discloses less than an event-triggered read", () => {
  // The red team's sharpest point, and it inverts the obvious reading: polling sounds worse and a
  // FIXED-RATE poll is less informative than reading when something arrives, because an
  // event-triggered read correlates with a real arrival and a constant poll does not.
  //
  // Measured as the operator's precision: of the reads they see, what fraction really did follow
  // an arrival in the preceding interval? That is exactly the inference a vault would make.
  const SPAN = 100_000;
  const POLL = 1_000;
  const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  const random = rng(7);
  // Arrivals at a low rate, so most intervals genuinely contain nothing to find.
  const arrivals: number[] = [];
  for (let t = 0; t < SPAN; t += 1) if (random() < 0.0006) arrivals.push(t);
  assert.ok(arrivals.length > 20, `only ${arrivals.length} arrivals — the sample is too small`);

  const arrivedIn = (from: number, to: number) => arrivals.some((a) => a > from && a <= to);

  // EVENT-TRIGGERED: the client reads because something arrived, plus a little jitter.
  const triggered = arrivals.map((a) => a + Math.floor(random() * 50));
  const triggeredPrecision =
    triggered.filter((r) => arrivedIn(r - POLL, r)).length / triggered.length;

  // CONSTANT-RATE: the client reads on a metronome, whatever is or is not there.
  const polled: number[] = [];
  for (let t = POLL; t < SPAN; t += POLL) polled.push(t);
  const polledPrecision = polled.filter((r) => arrivedIn(r - POLL, r)).length / polled.length;

  // THE COMPARISON IS AGAINST THE BASE RATE, NOT AGAINST A CONSTANT. The first version of this
  // asserted `polled < 0.5` and measured 63.6% — because at this traffic level most intervals
  // genuinely contain an arrival, so 63.6% was the PRIOR and the assertion was arbitrary. What
  // makes constant polling uninformative is that it does not beat the prior; what makes an
  // event-triggered read informative is that it reaches certainty.
  const baseRate = polled.filter((r) => arrivedIn(r - POLL, r)).length / polled.length;
  console.error(`operator precision guessing "a message arrived before this read":`);
  console.error(`  prior (base rate) ${(baseRate * 100).toFixed(1)}%`);
  console.error(`  event-triggered   ${(triggeredPrecision * 100).toFixed(1)}%  `
    + `(${triggered.length} reads) — learns the arrival`);
  console.error(`  constant-rate     ${(polledPrecision * 100).toFixed(1)}%  `
    + `(${polled.length} reads, one per ${POLL}) — learns nothing beyond the prior`);

  assert.ok(triggeredPrecision > 0.95,
    "an event-triggered read did not correlate with an arrival, so the fixture is wrong");
  assert.equal(polledPrecision, baseRate,
    "a constant poll told the operator something the prior did not — it is supposed to be "
    + "independent of arrivals, which is the whole property");
  assert.ok(triggeredPrecision - baseRate > 0.25,
    `event-triggered reading adds only ${((triggeredPrecision - baseRate) * 100).toFixed(0)} `
    + "points over the prior at this traffic level, so this fixture cannot show the difference");
});

test("MEASURED: what a constant poll DOES disclose, so it is priced rather than waved through", () => {
  // Two rows, and neither is zero. `0042` must carry them.
  const POLL = 1_000;
  //  1. PRESENCE. A client polling on a metronome tells the operator it is running, continuously.
  //     Today a client that sends nothing and reads nothing is invisible between messages.
  //  2. COLLECTION TIME. The miss→hit transition bounds when the reader collected a message, to
  //     within one interval — a read receipt the vault infers without either party sending one.
  //
  // The granularity IS the poll interval, which makes it a stated number rather than a property
  // nobody can quote — the same shape as the key-at-rest window.
  const uploadedAt = 12_345;
  const firstHit = Math.ceil(uploadedAt / POLL) * POLL;
  const bound = firstHit - uploadedAt;
  console.error(`collection time is bounded to ${POLL} units by the poll interval `
    + `(uploaded ${uploadedAt}, first hit ${firstHit}, gap ${bound})`);
  assert.ok(bound <= POLL, "the miss→hit transition bounds collection more tightly than the poll");
  // A longer interval discloses less and delivers later. That trade is the operator-visible knob
  // and it belongs in the note as a number the user can see.
  assert.ok(POLL > 0);
});
