/**
 * I3 — the on-chain pointer is never the raw content hash.
 *
 * `claude-docs/HYDRA_HANDOFF.md` I3: "given a chain event log and a vault upload log for the
 * same session, an adversary harness must fail to match any pair. Write this test first."
 * This is that test, and it was written before `channel/src/pointer.ts` existed.
 *
 * THE ADVERSARY. A vault operator. It sees every upload: the blob id it was given, the byte
 * count, and the wall-clock time it arrived. It also reads the chain, like everyone else, so
 * it sees every pointer event and its block timestamp. It holds no key. Its goal is not to
 * decrypt anything — it is to say "blob X is the message behind pointer Y", because that
 * alone rebuilds the channel graph over blobs it is already storing.
 *
 * It gets two independent attacks, and they fail for different reasons:
 *
 *   value join    is the pointer a function of the blob id? Equality, prefix, suffix, and
 *                 the specific mistake I3 names — publishing the content hash directly.
 *   timing join   ignore the values entirely and match each pointer to the upload nearest it
 *                 in time. Needs no cryptanalysis and no keys.
 *
 * The result this file records is not the comfortable one. Pointer construction closes the
 * value join completely and does **nothing** to the timing join — with uploads sent as the
 * chain event fires, the operator matches every pair at 100%. What closes it is jitter, which
 * `HYDRA_HANDOFF.md` parks in Phase 3 while claiming I3's acceptance in Phase 2. So the
 * acceptance clause is not satisfiable by the pointer alone, and this test says so by
 * asserting the undefended case succeeds rather than quietly testing only the defended one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { rootSeed, entropyFrom, derive, VAULT_DOMAIN } from "../../identity/src/domains.ts";
import { channelSecret, pointerFor, blobIdFrom, recoverBlobId } from "../../channel/src/pointer.ts";

// A session is deterministic: same seed, same schedule, every run. A flaky privacy test is
// worse than none, because the failure gets re-run until it passes.
const seed = rootSeed(entropyFrom(new Uint8Array(32).fill(3), "i3 test vector"));
const vaultRoot = derive(VAULT_DOMAIN, seed);

/** What the vault operator records when a blob arrives. */
type Upload = { at: number; blobId: Uint8Array; bytes: number };
/** What anyone reading the chain records when a pointer event lands. */
type ChainEvent = { at: number; pointer: Uint8Array };

/**
 * One session of `count` messages.
 *
 * `jitterMs` is the delay between the chain event and the upload. Zero is the naive client:
 * publish and upload together. The handoff's Phase 3 calls for "upload jitter relative to the
 * chain event" and this is the parameter that models it.
 */
function session(count: number, jitterMs: number, blockMs = 30_000) {
  const chan = channelSecret(vaultRoot, "alice→bob");
  const uploads: Upload[] = [];
  const chain: ChainEvent[] = [];
  for (let seq = 0; seq < count; seq++) {
    const ciphertext = new Uint8Array(64).fill(seq + 1);
    const blobId = blobIdFrom(ciphertext);
    const at = seq * blockMs;
    chain.push({ at, pointer: pointerFor(chan, blobId, seq) });
    // Deterministic pseudo-jitter in [0, jitterMs): no Math.random, so the run reproduces.
    // Knuth's multiplicative constant, not `seq * prime` — the latter is monotonic and for a
    // dozen messages spans a fraction of the range, so it models a much narrower jitter than
    // it claims. That mistake made this file's first run report leakage that was an artifact.
    uploads.push({ at: at + (jitterMs ? (seq * 2654435761) % jitterMs : 0), blobId, bytes: 1024 });
  }
  return { chan, chain, uploads };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Attack 1: is the pointer a function of the blob id that needs no key? */
function valueJoin(chain: ChainEvent[], uploads: Upload[]): number {
  let matched = 0;
  for (const e of chain) {
    const p = hex(e.pointer);
    const hit = uploads.find((u) => {
      const b = hex(u.blobId);
      return p === b || p.startsWith(b.slice(0, 16)) || b.startsWith(p.slice(0, 16))
        || p.endsWith(b.slice(-16)) || b.endsWith(p.slice(-16));
    });
    if (hit) matched++;
  }
  return matched;
}

/** Attack 2: forget the values. Match each pointer to the upload nearest it in time. */
function timingJoin(chain: ChainEvent[], uploads: Upload[]): number {
  let correct = 0;
  for (let i = 0; i < chain.length; i++) {
    let best = -1;
    let bestGap = Infinity;
    for (let j = 0; j < uploads.length; j++) {
      const gap = Math.abs(uploads[j].at - chain[i].at);
      if (gap < bestGap) { bestGap = gap; best = j; }
    }
    if (best === i) correct++;
  }
  return correct;
}

test("the pointer is not the content hash, and is not derivable from it", () => {
  const { chain, uploads } = session(12, 0);
  assert.equal(valueJoin(chain, uploads), 0, "the operator joined a pointer to a blob by value");
  // Specifically the mistake I3 names: never publish the blob id itself.
  for (const e of chain) {
    assert.ok(!uploads.some((u) => hex(u.blobId) === hex(e.pointer)));
  }
});

test("the harness can actually find a value join when one exists", () => {
  // A test that only ever reports "no match" is indistinguishable from a broken test. This
  // plants the defect I3 forbids and requires the adversary to catch every instance.
  const { chain, uploads } = session(12, 0);
  const naive = chain.map((e, i) => ({ ...e, pointer: uploads[i].blobId }));
  assert.equal(valueJoin(naive, uploads), 12, "the value join failed to catch a raw content hash");
});

test("pointers repeat neither across messages nor across channels", () => {
  const { chan, chain } = session(8, 0);
  assert.equal(new Set(chain.map((e) => hex(e.pointer))).size, 8, "a pointer repeated in a session");
  // The same blob in two channels must not produce the same pointer, or the operator learns
  // that two channels carry identical content without reading either.
  const other = channelSecret(vaultRoot, "alice→carol");
  const blobId = blobIdFrom(new Uint8Array(64).fill(1));
  assert.notDeepEqual(pointerFor(chan, blobId, 0), pointerFor(other, blobId, 0));
  // And the same blob at two sequence numbers in ONE channel must differ too, or a resend is
  // visible as a repeat.
  assert.notDeepEqual(pointerFor(chan, blobId, 0), pointerFor(chan, blobId, 1));
});

test("the recipient, holding the channel secret, recovers the blob id", () => {
  // The pointer has to be useful, not merely opaque. If it cannot be inverted by the holder,
  // the scheme is a hash and the message is unreachable.
  const { chan, chain, uploads } = session(5, 0);
  for (let seq = 0; seq < 5; seq++) {
    assert.deepEqual(recoverBlobId(chan, chain[seq].pointer, seq), uploads[seq].blobId);
  }
});

test("a wrong channel secret recovers something, and it is not the blob id", () => {
  // Masking gives no integrity, and pretending otherwise is how a scheme gets misused. The
  // wrong key yields a plausible-looking id that simply is not in the vault — the failure is
  // a 404, not an exception, and callers need to know that.
  const { chain, uploads } = session(3, 0);
  const wrong = channelSecret(vaultRoot, "mallory→bob");
  const out = recoverBlobId(wrong, chain[0].pointer, 0);
  assert.equal(out.length, uploads[0].blobId.length);
  assert.notDeepEqual(out, uploads[0].blobId);
});

test("with no jitter the operator matches every pair on timing alone", () => {
  // The uncomfortable half. No keys, no cryptanalysis, no weakness in the pointer: publish and
  // upload together and the timelines are the same timeline.
  const { chain, uploads } = session(12, 0);
  assert.equal(timingJoin(chain, uploads), 12,
    "if this drops below 12 the jitter model changed, not the risk");
});

test("jitter wider than the block interval is what actually closes I3", () => {
  // Jitter has to exceed the spacing between chain events, or nearest-in-time still wins.
  // 30s blocks with 8 minutes of jitter: the correct upload is no longer the nearest one.
  const { chain, uploads } = session(12, 8 * 60_000, 30_000);
  const hits = timingJoin(chain, uploads);
  assert.ok(hits <= 2, `the operator still matched ${hits}/12 pairs by timing`);
});

test("jitter narrower than the block interval buys nothing", () => {
  // The failure mode worth naming: a client that jitters by "a few seconds" on a 30s block
  // has not defended anything, and would pass a test that only asserted "jitter is applied".
  const { chain, uploads } = session(12, 5_000, 30_000);
  assert.equal(timingJoin(chain, uploads), 12,
    "jitter below the block interval must be reported as useless, not as mitigation");
});

test("the jitter needed is about four block intervals, and that is the number Phase 3 needs", () => {
  // Phase 3 says "upload jitter relative to the chain event" without saying how much, which
  // is the kind of instruction that gets implemented as five seconds. This is the curve, on
  // 30s blocks and 12 messages, where chance for a nearest-in-time matcher is 1/12:
  //
  //     jitter    0s  -> 12/12      jitter  120s  ->  1/12
  //     jitter    5s  -> 12/12      jitter  480s  ->  1/12
  //     jitter   30s  ->  6/12      jitter 1800s  ->  1/12
  //
  // Below the block interval it buys nothing at all. At exactly one interval it halves the
  // operator's accuracy, which is not a defence. Four intervals reaches chance, and past that
  // there is no further gain — so the cost of I3 is a couple of minutes of latency, not more.
  const block = 30_000;
  const curve = [0, 5_000, 30_000, 120_000, 480_000, 1_800_000].map((j) => {
    const { chain, uploads } = session(12, j, block);
    return [j, timingJoin(chain, uploads)] as const;
  });
  assert.deepEqual(curve.map(([, hits]) => hits), [12, 12, 6, 1, 1, 1],
    "the jitter/accuracy curve moved — re-derive the Phase 3 number before shipping");
  // The claim in prose, asserted rather than left in the comment above.
  const atChance = curve.find(([, hits]) => hits <= 1);
  assert.ok(atChance && atChance[0] <= 4 * block,
    "chance-level matching now needs more jitter than four block intervals");
});
