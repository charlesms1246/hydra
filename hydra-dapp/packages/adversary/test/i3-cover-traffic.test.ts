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
import { coverPlan, coverBody, coverId, coverKey, COVER_RATE, coverLeadMs, anonymitySetFloor }
  from "../../channel/src/cover.ts";
import { best } from "../src/matchers.ts";
import { channelSecret } from "../../channel/src/pointer.ts";
import { sealForChannel, wireBytes, encryptedIdFor } from "../../vault-client/src/blobs.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { rootSeed, entropyFrom, derive, VAULT_DOMAIN, fromTestVector} from "../../identity/src/domains.ts";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const BLOCK = 30_000;
const MESSAGES = 12;
const CHANCE = 1 / MESSAGES;
const cfg = { blockMs: BLOCK };
const vaultRoot = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(6), "cover vector"))));
const chan = channelSecret(vaultRoot, "alice→bob");

/** Per-message accuracy for a nearest-in-time operator, with `coverRate` decoys per window. */
function accuracy(coverRate: number, trials = 2000) {
  const random = lcg(7);
  const hits = new Array(MESSAGES).fill(0);
  for (let t = 0; t < trials; t++) {
    const events = Array.from({ length: MESSAGES }, (_, i) => i * BLOCK);
    const real = events.map((at) => scheduleUpload(at, cfg, random));
    const decoys = coverRate > 0
      ? coverPlan(events.map((at) => ({ at, bucket: BUCKETS[0] })), { ...cfg, coverRate }, random)
      : [];
    // Decoys carry their bucket now; the matcher only needs the time.
    const uploads = [...real, ...decoys.map((d) => d.at)];
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
  const plan = coverPlan(Array.from({ length: 12 }, (_, i) => ({ at: i * BLOCK, bucket: BUCKETS[0] })), cfg, lcg(1));
  assert.ok(plan[0].at < 0, `cover starts at ${plan[0].at}, not before the first event`);
  assert.ok(plan[0].at <= -coverLeadMs(cfg) * 0.5,
    "the lead is far shorter than configured");
  assert.ok(plan.at(-1)!.at > 11 * BLOCK, "cover stops before the last message");
  // Sorted, so a consumer can merge it with a real schedule without re-sorting.
  assert.deepEqual([...plan].sort((a, b) => a.at - b.at), plan);
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


test("a decoy is indistinguishable from a real upload on the wire", () => {
  // Cover only covers if it looks the same. Same bucket length, and an id minted by the very
  // same function — not a second copy of it.
  for (const bucket of BUCKETS.slice(0, 3)) {
    const body = coverBody(chan, bucket, 0);
    assert.equal(body.length, bucket);
    assert.equal(coverId(body), encryptedIdFor(body));
    assert.ok(coverId(body).startsWith("enc:"));
  }
  // A real upload in the same bucket has the same length, so length cannot separate them.
  const real = wireBytes(sealForChannel(chan, new Uint8Array(100))) as unknown as Uint8Array;
  assert.equal(real.length, BUCKETS[0]);
  assert.equal(coverBody(chan, BUCKETS[0], 0).length, real.length);
  // Two decoys never repeat, or a repeated id would mark them — but they are DERIVED now, so
  // "never repeat" is a property of the index rather than of randomness. The same index gives
  // the same body deliberately: that is what lets the recipient ask for it, which is what stops
  // an operator identifying every decoy by the fact that nobody ever does.
  assert.deepEqual(coverBody(chan, BUCKETS[0], 3), coverBody(chan, BUCKETS[0], 3));
  const ids = new Set(Array.from({ length: 64 }, (_, i) => coverId(coverBody(chan, BUCKETS[0], i))));
  assert.equal(ids.size, 64, "two decoy indices collided");
  // And a different channel's decoys are unrelated, or one conversation's cover would mark
  // another's — the bodies come from the channel's own cover key.
  const other = channelSecret(vaultRoot, "alice→carol");
  assert.notDeepEqual(coverBody(other, BUCKETS[0], 3), coverBody(chan, BUCKETS[0], 3));
});

test("cover is per bucket, and mixing sizes is not covered", () => {
  // The limitation, asserted so it is not forgotten: a decoy in the 1 KiB bucket does nothing
  // for a 64 KiB message. An operator filters by size first and the cover evaporates.
  const small = coverBody(chan, BUCKETS[0], 0);
  const large = wireBytes(sealForChannel(chan, new Uint8Array(20_000))) as unknown as Uint8Array;
  assert.notEqual(small.length, large.length,
    "if these were equal the per-bucket caveat would be unnecessary");
  assert.equal(large.length, BUCKETS[3]);
  // Which is why coverBody takes a bucket rather than choosing one.
  assert.equal(coverBody(chan, BUCKETS[3], 0).length, large.length);
});

test("a cover rate of zero is refused rather than silently meaning none", () => {
  assert.throws(() => coverPlan([{ at: 0, bucket: BUCKETS[0] }], { ...cfg, coverRate: 0 }), /no cover at all/);
  // And the schedule guard still applies: cover does not excuse an unsafe jitter window.
  assert.throws(() => coverPlan([{ at: 0, bucket: BUCKETS[0] }], { blockMs: BLOCK, jitterBlocks: 1 }), /jitter/i);
});

test("the cover key stays in the vault domain", () => {
  // Reserved for recognisable decoys. It must not become a second route out of the domain.
  assert.equal(coverKey(chan).domain, VAULT_DOMAIN);
  assert.notDeepEqual(coverKey(chan), chan);
  assert.equal(jitterWindowMs(cfg), 8 * BLOCK);
});

test("the cost is bounded by messages, not by how long the conversation runs", () => {
  // The defect this design replaced. Spreading decoys across the session span made the count a
  // function of DURATION: twelve messages a day apart cost 15,848 decoys and 15 MiB, against 14
  // for the same twelve messages five minutes apart. Every published number came from the short
  // session, so the cost never appeared in a measurement.
  const twelve = (gap: number) => Array.from({ length: 12 }, (_, i) => ({ at: i * gap, bucket: BUCKETS[0] }));
  const short = coverPlan(twelve(BLOCK), cfg, lcg(1)).length;
  const long = coverPlan(twelve(86_400_000), cfg, lcg(1)).length;
  assert.equal(short, long, "the decoy count still depends on how long the conversation ran");
  assert.equal(short, 12 * COVER_RATE, "cover is not exactly rate-per-message");
});

test("an isolated message gets the floor the rate buys, and no more", () => {
  // The guarantee, stated as a floor rather than a hope: an event's window holds its own upload
  // and `coverRate` decoys, so an operator picking among them is right 1/(rate+1) of the time.
  // Messages a day apart are the isolated case — nothing overlaps, so nothing helps.
  const isolated = Array.from({ length: 12 }, (_, i) => i * 86_400_000);
  const random = lcg(31);
  const runs = Array.from({ length: 800 }, () => {
    const uploads = isolated.map((at, seq) => ({ t: scheduleUpload(at, cfg, random), real: true, seq }));
    for (const d of coverPlan(isolated.map((at) => ({ at, bucket: BUCKETS[0] })), cfg, random)) uploads.push({ t: d.at, real: false, seq: -1 });
    return { events: isolated, uploads };
  });
  const floor = anonymitySetFloor(cfg);
  assert.equal(floor, 1 / (COVER_RATE + 1));
  const scored = best(runs).mean.mean;
  assert.ok(Math.abs(scored - floor) < 0.05,
    `an isolated message scored ${scored.toFixed(3)} against a floor of ${floor.toFixed(3)}`);
});

test("messages that cluster do better than the floor, which is a bonus not the guarantee", () => {
  // Overlapping windows merge anonymity sets. Worth measuring because it is the common case and
  // worth NOT promising, because a conversation is entitled to be slow.
  const random = lcg(31);
  const clustered = Array.from({ length: 12 }, (_, i) => i * BLOCK);
  const runs = Array.from({ length: 800 }, () => {
    const uploads = clustered.map((at, seq) => ({ t: scheduleUpload(at, cfg, random), real: true, seq }));
    for (const d of coverPlan(clustered.map((at) => ({ at, bucket: BUCKETS[0] })), cfg, random)) uploads.push({ t: d.at, real: false, seq: -1 });
    return { events: clustered, uploads };
  });
  assert.ok(best(runs).mean.mean < anonymitySetFloor(cfg) / 2,
    "clustered messages should comfortably beat the isolated floor");
});

test("a message in a bucket with no decoys has no cover at all", () => {
  // The hole the plan's shape now prevents. Cover was bare times and `coverBody` took whatever
  // bucket a caller passed, so the obvious thing to pass was the smallest one — and any larger
  // message was naked. Measured before the fix: 1.000, an operator right every single time,
  // because filtering by size left exactly one candidate.
  const events = Array.from({ length: 8 }, (_, i) => ({ at: i * BLOCK, bucket: BUCKETS[0] }));
  const plan = coverPlan(events, cfg, lcg(11));
  const covered = new Set(plan.map((d) => d.bucket));
  assert.deepEqual([...covered], [BUCKETS[0]]);
  // A message in a bucket the plan never mentions is alone in its size class.
  assert.ok(!covered.has(BUCKETS[3]), "the fixture is not exercising an uncovered bucket");

  // With the buckets carried, a mixed-size session covers each size it actually uses.
  const mixed = [
    { at: 0, bucket: BUCKETS[0] },
    { at: BLOCK, bucket: BUCKETS[3] },
    { at: 2 * BLOCK, bucket: BUCKETS[0] },
  ];
  const mixedPlan = coverPlan(mixed, cfg, lcg(12));
  for (const bucket of new Set(mixed.map((m) => m.bucket))) {
    const n = mixedPlan.filter((d) => d.bucket === bucket).length;
    assert.equal(n, COVER_RATE * mixed.filter((m) => m.bucket === bucket).length,
      `bucket ${bucket} got ${n} decoys, not rate-per-message-in-that-bucket`);
  }
});

test("the floor does not depend on how many messages a conversation has", () => {
  // A virtue of covering per event rather than per session: a two-message conversation gets the
  // same guarantee as a fifty-message one. The span-based design did not have this — its
  // protection came from the crowd, so a short conversation had a small crowd.
  for (const n of [2, 5, 25]) {
    const random = lcg(31);
    const isolated = Array.from({ length: n }, (_, i) => i * 86_400_000);
    const runs = Array.from({ length: 400 }, () => {
      const uploads = isolated.map((at, seq) => ({ t: scheduleUpload(at, cfg, random), real: true, seq }));
      for (const d of coverPlan(isolated.map((at) => ({ at, bucket: BUCKETS[0] })), cfg, random)) {
        uploads.push({ t: d.at, real: false, seq: -1 });
      }
      return { events: isolated, uploads };
    });
    const scored = best(runs).mean.mean;
    assert.ok(Math.abs(scored - anonymitySetFloor(cfg)) < 0.06,
      `${n} messages scored ${scored.toFixed(3)} against a floor of ${anonymitySetFloor(cfg).toFixed(3)}`);
  }
});

test("the lead is the jitter window exactly, and that is what makes the floor a floor", () => {
  // Not a tunable, and the reason is a distribution argument rather than a preference. The real
  // upload lands uniformly in [event, event+W). A decoy lands uniformly in [event-lead,
  // event+W), and |uniform(-W, W)| is uniform on [0, W) — so at lead == W, and only there, a
  // decoy is indistinguishable from the real upload by distance.
  assert.equal(coverLeadMs(cfg), jitterWindowMs(cfg));

  // Measured across leads, one isolated message, nearest-to-event. A LONGER lead sounds prudent
  // and is catastrophic: decoys spread wider than the real upload, so the nearest candidate is
  // usually the real one.
  const attack = (leadMs: number) => {
    const random = lcg(53);
    let hit = 0;
    const trials = 4000;
    for (let t = 0; t < trials; t++) {
      const candidates = [{ at: scheduleUpload(0, cfg, random), real: true }];
      for (let k = 0; k < COVER_RATE; k++) {
        candidates.push({ at: -leadMs + random() * (leadMs + jitterWindowMs(cfg)), real: false });
      }
      let best: { at: number; real: boolean } | null = null;
      let gap = Infinity;
      for (const c of candidates) {
        const d = Math.abs(c.at);
        if (d < gap) { gap = d; best = c; }
      }
      if (best?.real) hit++;
    }
    return hit / trials;
  };

  const W = jitterWindowMs(cfg);
  const atWindow = attack(W);
  assert.ok(Math.abs(atWindow - anonymitySetFloor(cfg)) < 0.02,
    `lead == window scored ${atWindow.toFixed(3)}, floor is ${anonymitySetFloor(cfg).toFixed(3)}`);
  // Four times the window roughly doubles what the operator gets.
  assert.ok(attack(4 * W) > atWindow * 1.8,
    "a much longer lead should be much worse; if not, the distribution argument has changed");
  // And a much shorter one pushes below the floor, which is its own exploitable signal.
  assert.ok(attack(W / 8) < atWindow * 0.85,
    "a much shorter lead should fall below the floor");
});
