/**
 * Cover traffic, attacked from the read side instead of the write side.
 *
 * Every other I3 harness measures an operator watching UPLOADS: when they arrive, how big they
 * are, how they line up with chain events. Jitter and cover make that hard, and the published
 * floor is 0.2 — a message alone in its bucket is hidden among its own `COVER_RATE` decoys.
 *
 * That is one half of what a vault operator sees. They also serve the READS, and
 * `observations.ts` lists `read.ids` and `read.hit` for exactly that reason: seeing a request
 * is forced even though recording it is a choice.
 *
 * A real message is fetched — that is why it was sent. A decoy whose body was `randomBytes` is
 * fetched by nobody, because nobody can compute its id. So **"was this object ever asked for"
 * is one bit that separates the two perfectly**, measured below at 1.000: not a weakened
 * anonymity set, an empty one, with the storage and the invites spent buying nothing.
 *
 * `coverBody` now derives from `coverKey(channel)` and takes an index, so the recipient
 * regenerates the same ids and asks for them in the same batch as everything else. Both numbers
 * are here, because the fix is only meaningful next to what it fixes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { send, cover, openChannel } from "../../client/src/session.ts";
import { readSet } from "../../client/src/read.ts";
import { coverBody, coverId, coverIndex, COVER_RATE, anonymitySetFloor }
  from "../../channel/src/cover.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { ephemeral } from "../../handshake/src/authorship.ts";

const BLOCK = 30_000;
const N = 6;

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const channel = openChannel(derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(51), "read-pattern")))), "alice→bob");

/**
 * One conversation as the operator sees it: every object stored, and every id asked for.
 *
 * `derived: false` reproduces the old design — decoy bodies from `randomBytes`, which the
 * recipient cannot name. It is kept because the number it produces is the reason the current
 * design exists, and a fix with nothing to compare against is a fix nobody can evaluate.
 */
function session(random: () => number, derived: boolean) {
  const config = { channel, author: ephemeral(), blockMs: BLOCK };
  const messages = Array.from({ length: N }, (_, seq) =>
    send(config, new TextEncoder().encode(`message ${seq}`), seq, seq * BLOCK, random));

  const uploads: { id: string; real: boolean }[] =
    messages.map((m) => ({ id: m.blobId, real: true }));
  for (const d of cover(config, messages, random)) {
    const body = derived ? coverBody(channel, d.bucket, d.index, d.salt) : new Uint8Array(randomBytes(d.bucket));
    uploads.push({ id: coverId(body), real: false });
  }

  const seen = messages.map((m) => ({ seq: m.seq, pointer: m.pointer as unknown as Uint8Array }));
  return { uploads, asked: new Set(readSet(channel, seen)) };
}

/** The attack: an object that was fetched is a message; one that never was is a decoy. */
function fetchedIsReal(s: ReturnType<typeof session>): number {
  let right = 0;
  for (const u of s.uploads) if (s.asked.has(u.id) === u.real) right++;
  return right / s.uploads.length;
}

test("THE HOLE: with random decoys, one bit per object identifies every message", () => {
  const random = lcg(7);
  let total = 0;
  const TRIALS = 100;
  for (let t = 0; t < TRIALS; t++) total += fetchedIsReal(session(random, false));
  assert.equal(total / TRIALS, 1,
    "the never-fetched signal no longer works even with random decoys — recheck this file");
  // Against the number the project publishes about the upload side alone.
  assert.ok(anonymitySetFloor({ blockMs: BLOCK }) <= 0.2);
});

test("THE FIX: derived decoys are fetched too, so the bit says nothing", () => {
  // Every stored object is asked for, real and decoy alike, so partitioning by "was it
  // fetched" produces one class and identifies nothing. The operator is back to the upload-side
  // problem the rest of I3 measures.
  const random = lcg(7);
  for (let t = 0; t < 50; t++) {
    const s = session(random, true);
    const unfetched = s.uploads.filter((u) => !s.asked.has(u.id));
    assert.deepEqual(unfetched, [],
      `${unfetched.length} stored objects were never asked for; each is identifiable as a decoy`);
    // And the classifier that used to be perfect now cannot separate them: guessing "real" for
    // everything fetched is right only for the real fraction.
    assert.equal(fetchedIsReal(s), 1 / (COVER_RATE + 1));
  }
});

test("the recipient asks for every bucket, because it cannot know the size in advance", () => {
  // A reader learns a message's size band by reading it, so a decoy id must be requested for
  // every band. The surplus misses, and a miss is indistinguishable from a message not yet
  // sent — the same property that makes the random padding free.
  const s = session(lcg(9), true);
  const stored = new Set(s.uploads.map((u) => u.id));
  const misses = [...s.asked].filter((id) => !stored.has(id));
  assert.ok(misses.length >= N * COVER_RATE * (BUCKETS.length - 1),
    "the read set does not cover every bucket for every decoy index");
  // The batch is much wider than the conversation, which is the cost of this defence.
  assert.ok(s.asked.size > s.uploads.length * 2);
});

test("the two sides agree on a decoy through one derivation, not two", () => {
  // The sender mints a decoy and the recipient asks for one; two copies of the arithmetic would
  // drift, the recipient would stop fetching some decoys, and those would go back to being
  // identifiable with nothing failing.
  //
  // A decoy is named by a PAIR now — a per-message salt and an index within the message — where
  // it used to be one folded index. The salt is what a second device on the same identity cannot
  // reproduce; see `decisions/0023` and `channel/src/cover.ts`.
  const config = { channel, author: ephemeral(), blockMs: BLOCK };
  const messages = Array.from({ length: 3 }, (_, seq) =>
    send(config, new TextEncoder().encode("x"), seq, seq * BLOCK, () => 0.5));
  const minted = cover(config, messages, () => 0.5)
    .map((d) => `${d.salt}:${d.index}`).sort();

  // What the recipient enumerates, from what it read off the chain and nothing else.
  const asked: string[] = [];
  for (const m of messages) {
    for (let k = 0; k < COVER_RATE; k++) asked.push(`${BigInt(m.seq)}:${k}`);
  }
  assert.deepEqual(minted, asked.sort(),
    "the sender minted decoys the recipient does not ask for");
  // Every index is within one message rather than folded across the session.
  assert.ok(cover(config, messages, () => 0.5).every((d) => d.index < COVER_RATE));
});

test("a sender handing `cover` a SUBSET of its messages still mints what the recipient asks for", () => {
  // The specific way this goes wrong later, and it survives the move from a folded index to a
  // salt: a caller that passes only the messages it has not yet flushed must not renumber from
  // array position, or it mints decoys nobody ever asks for — which is the never-fetched signal
  // this derivation exists to remove.
  //
  // The salt comes from the MESSAGE, so a subset is numbered exactly as the whole set would be.
  const config = { channel, author: ephemeral(), blockMs: BLOCK };
  const all = Array.from({ length: 4 }, (_, seq) =>
    send(config, new TextEncoder().encode("x"), seq, seq * BLOCK, () => 0.5));
  const tail = all.slice(2);
  const minted = cover(config, tail, () => 0.5).map((d) => `${d.salt}:${d.index}`);

  // Message 2's decoys carry message 2's salt, not the first salt in the array it was handed.
  assert.ok(minted.every((m) => m.startsWith("2:") || m.startsWith("3:")),
    `a subset was renumbered from array position: ${minted.join(", ")}`);
  const recipientAsksFor = new Set<string>();
  for (const m of all) {
    for (let k = 0; k < COVER_RATE; k++) recipientAsksFor.add(`${BigInt(m.seq)}:${k}`);
  }
  for (const m of minted) {
    assert.ok(recipientAsksFor.has(m), `decoy ${m} is one the recipient never asks for`);
  }
});

test("the cost is unchanged: the fix is free in storage and paid in request size", () => {
  const s = session(lcg(17), true);
  assert.equal(s.uploads.filter((u) => !u.real).length, N * COVER_RATE);
  assert.equal(s.uploads.length, N * (COVER_RATE + 1));
  // What it costs is a wider request. Stated rather than hidden: the ids are 31 bytes of hex
  // each, so a conversation of N messages asks for N * rate * buckets + N of them.
  assert.equal(s.asked.size, N + N * COVER_RATE * BUCKETS.length);
});
