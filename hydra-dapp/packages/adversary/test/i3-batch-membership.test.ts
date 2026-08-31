/**
 * What a read batch groups, which is the question `channel.membership` never asked.
 *
 * `observations.ts` lists `channel.membership` — "which blobs belong to the same channel" — as
 * something the operator CANNOT see, with the mechanism `no-channel-field` and the reason
 * "nothing in an upload names a channel, and reads arrive as batches over a client's whole set".
 *
 * The first clause is true and `not-observable-mechanisms.test.ts` proves it: no upload, and no
 * stored record, contains anything channel-shaped.
 *
 * The second clause is the protection turned upside down. A batch IS the client's whole set for
 * one channel. The operator does not have to infer membership from an upload — the reader
 * hands it over, grouped, in a single request. Every id in the batch that HITS is an object of
 * that channel; the ones that miss are padding and decoy candidates for other size bands.
 *
 * This file measures that. It is the third finding from the same question — what can an
 * observer work out that the software never wrote down — and the first to falsify a row that
 * was in the published "cannot see" column.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { send, cover, openChannel } from "../../client/src/session.ts";
import { readSet } from "../../client/src/read.ts";
import { Vault, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";
import { coverBody, coverId } from "../../channel/src/cover.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { OBSERVABLE, NOT_OBSERVABLE } from "../../vault-server/src/observations.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

const BLOCK = 30_000;

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const root = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(61), "batch-membership"))));

/** One channel's traffic, uploaded to a shared vault, plus the batch its reader would send. */
function channelTraffic(vault: Vault, invites: string[], label: string, n: number, random: () => number) {
  const channel = openChannel(root, label);
  const config = { channel, nullifier: 3n, blockMs: BLOCK };
  const messages = Array.from({ length: n }, (_, seq) =>
    send(config, new TextEncoder().encode(`${label} ${seq}`), seq, seq * BLOCK, random));

  const mine = new Set<string>();
  for (const m of messages) {
    vault.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: m.blobId, body: m.body,
      invite: invites.shift(),
    });
    mine.add(m.blobId);
  }
  for (const d of cover(config, messages, random)) {
    const body = coverBody(channel, d.bucket, d.index);
    vault.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: coverId(body), body, invite: invites.shift(),
    });
    mine.add(coverId(body));
  }

  const seen = messages.map((m) => ({ seq: m.seq, pointer: m.pointer as unknown as Uint8Array }));
  return { mine, batch: readSet(channel, seen) };
}

function twoChannels(seed = 3) {
  const invites = Array.from({ length: 400 }, (_, i) => `b-${i}`);
  const vault = new Vault({ invites: [...invites], buckets: BUCKETS, observeReads: true });
  const random = lcg(seed);
  const a = channelTraffic(vault, invites, "alice→bob", 4, random);
  const b = channelTraffic(vault, invites, "alice→carol", 3, random);
  return { vault, a, b };
}

/** The operator's rule: the ids in one batch that exist are one channel's objects. */
function grouped(vault: Vault, batch: readonly string[]): Set<string> {
  const reply = vault.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: [...batch] });
  const found = (reply as { found: ReadonlyMap<string, Uint8Array> }).found;
  return new Set(found.keys());
}

test("THE ROW IS FALSE: one read batch hands the operator a whole channel", () => {
  const { vault, a, b } = twoChannels();

  const fromA = grouped(vault, a.batch);
  const fromB = grouped(vault, b.batch);

  // Exactly the channel's objects, nothing else. Not a hint, not a correlation — the set.
  assert.deepEqual([...fromA].sort(), [...a.mine].sort(),
    "the batch does not recover the channel exactly; recheck what this is measuring");
  assert.deepEqual([...fromB].sort(), [...b.mine].sort());

  // And the two channels are cleanly separated by it: no object appears in both answers.
  for (const id of fromA) assert.ok(!fromB.has(id), `${id} appears in both channels' batches`);
  assert.equal(fromA.size + fromB.size, a.mine.size + b.mine.size);
});

test("the padding does not blur it, because padding misses", () => {
  // `readSet` pads with random ids and with decoy candidates for every size band. Those are the
  // ids that do not exist, so the operator drops them for free — the batch is wide and the
  // ANSWER is exact.
  const { vault, a } = twoChannels(5);
  const asked = a.batch.length;
  const hit = grouped(vault, a.batch).size;
  assert.ok(asked > hit * 2, "the batch is not padded much beyond what exists");
  assert.equal(hit, a.mine.size, "padding changed the answer, rather than only the question");
});

test("it is not the shared root: two unrelated readers separate just as cleanly", () => {
  // Both channels above descend from one vault root, which is how one person's two
  // conversations look. A batch from a genuinely different identity groups just as exactly, so
  // this is a property of batching and not of the fixture.
  const invites = Array.from({ length: 400 }, (_, i) => `c-${i}`);
  const vault = new Vault({ invites: [...invites], buckets: BUCKETS });
  const random = lcg(9);
  const mine = channelTraffic(vault, invites, "mine", 3, random);

  const otherRoot = derive(VAULT_DOMAIN,
    rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(62), "someone else"))));
  const otherChannel = openChannel(otherRoot, "theirs");
  const config = { channel: otherChannel, nullifier: 4n, blockMs: BLOCK };
  const messages = Array.from({ length: 3 }, (_, seq) =>
    send(config, new TextEncoder().encode(`theirs ${seq}`), seq, seq * BLOCK, random));
  const theirs = new Set<string>();
  for (const m of messages) {
    vault.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: m.blobId, body: m.body, invite: invites.shift(),
    });
    theirs.add(m.blobId);
  }
  const theirBatch = readSet(otherChannel,
    messages.map((m) => ({ seq: m.seq, pointer: m.pointer as unknown as Uint8Array })));

  const recovered = grouped(vault, theirBatch);
  for (const id of theirs) assert.ok(recovered.has(id));
  for (const id of mine.mine) assert.ok(!recovered.has(id), "the two readers' sets ran together");
});

test("the table says it, and no longer says the opposite", () => {
  // Why the guard did not catch this for so long. `no-channel-field` checks that no upload and
  // no stored record contains anything channel-shaped — true, and never the whole question. The
  // row's own reason went on to say "reads arrive as batches over a client's whole set" as
  // though that were the protection, and it is the disclosure.
  assert.ok(!NOT_OBSERVABLE.some((g) => g.id === "channel.membership"),
    "the vault still claims channel membership is not observable");
  const narrowed = NOT_OBSERVABLE.find((g) => g.id === "upload.channel");
  assert.ok(narrowed, "the true half of the old claim is gone too — it should survive");
  assert.deepEqual(narrowed!.because.map((b) => b.mechanism), ["no-channel-field"]);
  assert.equal(narrowed!.because.length, 1,
    "the narrowed row states more than one claim again — each needs its own mechanism");
  assert.match(narrowed!.what, /at the moment it is uploaded/,
    "the narrowed row does not say what it is narrowed to");

  const stated = OBSERVABLE.find((o) => o.id === "read.channelSet");
  assert.ok(stated, "the disclosure this file measures is not on the observable table");
  assert.match(stated!.what, /one conversation|one channel/);
});

test("reads are what leak it, so a client that never reads leaks nothing", () => {
  // Stated so the boundary is clear rather than implied: the objects on their own do not group.
  // An operator holding the whole store and no request log learns nothing about membership —
  // which is exactly what `operator-view.test.ts` captures, and why it passed.
  const { vault, a, b } = twoChannels(11);
  const store = vault.observe().rows.map((r) => r["blob.id"] as string);
  assert.equal(store.length, a.mine.size + b.mine.size);
  // Nothing in the stored record separates them.
  const view = JSON.stringify(vault.observe());
  for (const needle of ["alice", "bob", "carol", "channel"]) {
    assert.ok(!view.includes(needle), `the store itself names ${needle}`);
  }
});
