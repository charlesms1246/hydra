/**
 * The composition layer, attacked as a whole.
 *
 * Each package has its own invariant test. This one is about what happens *between* them,
 * because that is where an invariant gets lost without any single package failing: a caller
 * who seals but forgets to pad, or uploads before publishing, or lets a sandbox pointer reach
 * the chain, has broken something none of the other suites can see.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { send, receive, cover, openChannel, explain, PROOF_VALIDITY_BLOCKS }
  from "../../client/src/session.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { MIN_JITTER_BLOCKS, jitterWindowMs } from "../../channel/src/schedule.ts";
import { Vault, ENCRYPTED_ENDPOINT, PUBLIC_ENDPOINT } from "../../vault-server/src/server.ts";
import { MIN_READ_BATCH, readSet, select } from "../../client/src/read.ts";
import type { SeenPointer } from "../../client/src/read.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const BLOCK = 30_000;
const vaultRoot = derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(13), "client"))));
const channel = openChannel(vaultRoot, "alice→bob");
const config = { blockMs: BLOCK, channel, nullifier: 99n };

test("the upload is always scheduled after the chain event, never before", () => {
  // The ordering the whole of I3 rests on. An operator that sees a blob arrive shortly BEFORE
  // its pointer knows the two are related with no further work — worse than no jitter at all,
  // because it also reveals the upload was pre-arranged.
  const random = lcg(5);
  for (let seq = 0; seq < 200; seq++) {
    const publishedAt = seq * BLOCK;
    const out = send(config, new TextEncoder().encode(`m${seq}`), seq, publishedAt, random);
    assert.ok(out.uploadAt >= publishedAt, `upload precedes its own event at seq ${seq}`);
    assert.ok(out.uploadAt < publishedAt + jitterWindowMs(config));
  }
});

test("one send produces one bucket-sized body and exactly two felts", () => {
  // Composition check: padding happened, and nothing downstream grew the on-chain footprint.
  for (const n of [0, 1, 5_000, 200_000]) {
    const out = send(config, new Uint8Array(n), 0, 0, lcg(1));
    assert.ok(BUCKETS.includes(out.body.length), `body of ${out.body.length} is not a bucket`);
    assert.equal(out.calldata.length, 2);
    assert.ok(out.uploadPath.startsWith(ENCRYPTED_ENDPOINT));
    assert.ok(out.blobId.startsWith("enc:"));
  }
});

test("a message survives the whole round trip through a real vault", () => {
  // Send, upload at the scheduled time, then find it again from the pointer alone — which is
  // all a recipient reading the chain has.
  const vault = new Vault({ invites: ["c1", "c2", "c3"], buckets: BUCKETS });
  for (let seq = 0; seq < 3; seq++) {
    const out = send(config, new TextEncoder().encode(`message ${seq}`), seq, seq * BLOCK, lcg(seq + 1));
    const put = vault.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: out.blobId,
      body: out.body, invite: `c${seq + 1}`,
    });
    assert.equal(put.ok, true, `upload ${seq} rejected: ${JSON.stringify(put)}`);
    // The recipient holds the channel secret and the pointer; that is enough and nothing else is.
    assert.equal(receive(channel, out.pointer, seq), out.blobId);
  }
});

test("a different channel cannot resolve the pointer", () => {
  // Not merely "the id differs" — the wrong channel produces a well-formed id that is not in
  // the vault, which is a miss rather than an error. Callers need to know that is the shape.
  const vault = new Vault({ invites: ["c1"], buckets: BUCKETS });
  const out = send(config, new TextEncoder().encode("private"), 0, 0, lcg(9));
  vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: out.blobId, body: out.body, invite: "c1" });

  const other = openChannel(vaultRoot, "alice→carol");
  const wrong = receive(other, out.pointer, 0);
  assert.notEqual(wrong, out.blobId);
  const got = vault.handle({
    op: "fetch", endpoint: ENCRYPTED_ENDPOINT,
    ids: [wrong, ...Array.from({ length: 7 }, (_, i) => `enc:pad${i}`)],
  });
  assert.ok(got.ok && (got as { found: ReadonlyMap<string, unknown> }).found.size === 0);
});

test("cover traffic starts before the session's first message", () => {
  const plan = cover(config, 0, 10 * BLOCK, lcg(3));
  assert.ok(plan.length > 0);
  assert.ok(plan[0] < 0, "cover does not lead the first message");
});

test("the session refuses an unsafe schedule outright", () => {
  // The guard is not something a caller can forget to invoke: `send` calls it first.
  assert.throws(() => send({ ...config, jitterBlocks: 1 }, new Uint8Array(1), 0, 0), /jitter/i);
  assert.doesNotThrow(() => send({ ...config, jitterBlocks: MIN_JITTER_BLOCKS }, new Uint8Array(1), 0, 0));
});

test("the pool's nameless failures are given names", () => {
  // Measured against a live pool: re-registration fails during proof compilation with a string
  // that says nothing a user could act on. Translating it is the client's job.
  const raw = "simulated __execute__ emitted no server message; the pool did not compile the actions";
  const registered = explain(raw, "register");
  assert.equal(registered.kind, "already-registered");
  assert.match(registered.says, /write-once|already/i);
  assert.equal(registered.raw, raw, "the original must survive translation");

  assert.equal(explain("INVALID_BASE_BLOCK_NUMBER", "transfer").kind, "proof-too-fresh");
  assert.equal(explain("Surplus of 50 found but no surplus action", "transfer").kind,
    "no-change-destination");
});

test("an unrecognised failure is admitted, not guessed at", () => {
  // The important half. A catch-all mapping every compilation failure to "already registered"
  // would be confidently wrong, which is worse than the raw string — and the same raw string
  // means something different in another context.
  const raw = "simulated __execute__ emitted no server message; the pool did not compile the actions";
  const inTransfer = explain(raw, "transfer");
  assert.equal(inTransfer.kind, "unknown", "the same error was translated out of context");
  assert.match(inTransfer.says, /did not say why|not something you did wrong/i);
  assert.equal(inTransfer.raw, raw);
  assert.equal(explain("something nobody has seen", "deposit").kind, "unknown");
});

test("the proof window is the number the live pool reports", () => {
  // Not ten. `live-lifecycle.test.ts` reads it from a running pool and asserts the same value.
  assert.equal(PROOF_VALIDITY_BLOCKS, 450);
  assert.ok(PROOF_VALIDITY_BLOCKS > MIN_JITTER_BLOCKS,
    "a proof must outlive the jitter window, or every message expires before it uploads");
});

// ---------------------------------------------------------------------------
// Reading without saying which message you wanted
// ---------------------------------------------------------------------------

test("the vault refuses a read narrow enough to name its target", () => {
  // The row `read.target` claims the operator cannot tell which blob a reader wanted, and that
  // is only true of a batch. Enforced at the server, not left to clients: a disclosure property
  // that depends on every caller behaving holds until the first caller does not.
  const vault = new Vault({ buckets: BUCKETS });
  for (const n of [1, 2, MIN_READ_BATCH - 1]) {
    const res = vault.handle({
      op: "fetch", endpoint: ENCRYPTED_ENDPOINT,
      ids: Array.from({ length: n }, (_, i) => `enc:${i}`),
    });
    assert.equal(res.ok, false, `a read of ${n} ids was served`);
    assert.match(String((res as { error: string }).error), /which one you wanted/);
  }
  const wide = vault.handle({
    op: "fetch", endpoint: ENCRYPTED_ENDPOINT,
    ids: Array.from({ length: MIN_READ_BATCH }, (_, i) => `enc:${i}`),
  });
  assert.equal(wide.ok, true);
});

test("the public endpoint is exempt, because there the id IS the capability", () => {
  // Not an oversight. A world-readable object fetched by its id is the entire point of the
  // public class, and batching it would protect nothing.
  const vault = new Vault({ buckets: BUCKETS });
  assert.equal(vault.handle({ op: "fetch", endpoint: PUBLIC_ENDPOINT, ids: ["pub:one"] }).ok, true);
});

test("a client's read set reaches the floor by padding, not by waiting", () => {
  // A client with one message must still be able to read it. Decoys are random ids shaped
  // exactly like real ones, and a miss is indistinguishable from a message not yet sent.
  const one: SeenPointer[] = [{ seq: 0, pointer: send(config, new Uint8Array(1), 0, 0, lcg(2)).pointer }];
  const ids = readSet(channel, one);
  assert.ok(ids.length >= MIN_READ_BATCH, `a one-message channel produced a batch of ${ids.length}`);
  for (const id of ids) assert.match(id, /^enc:[0-9a-f]{62}$/, `${id} is not shaped like a real id`);
  assert.equal(new Set(ids).size, ids.length, "a decoy collided with a real id");
});

test("the batch does not encode which message is being read", () => {
  // Two reads for different targets must be indistinguishable. If the batch varied with what
  // the reader wanted, the difference between two batches would leak the same thing the batch
  // was supposed to hide.
  const seen: SeenPointer[] = [0, 1, 2].map((seq) => ({
    seq, pointer: send(config, new TextEncoder().encode(`m${seq}`), seq, seq * BLOCK, lcg(seq + 1)).pointer,
  }));
  const fixed = (n: number) => new Uint8Array(31).fill(n % 256);
  assert.deepEqual(readSet(channel, seen, fixed), readSet(channel, seen, fixed),
    "the same channel state produced two different read sets");
  // And it is sorted, so it does not encode the order the client learned the pointers either.
  const ids = readSet(channel, seen, fixed);
  assert.deepEqual([...ids].sort(), ids);
});

test("selection happens after the fetch, on the client", () => {
  // The separation that matters. A function that fetched and selected in one step would be one
  // refactor away from fetching only the selected id — and that refactor would pass every test
  // that does not exist to stop it.
  const vault = new Vault({ invites: ["r1", "r2", "r3"], buckets: BUCKETS, observeReads: true });
  const seen: SeenPointer[] = [];
  for (let seq = 0; seq < 3; seq++) {
    const out = send(config, new TextEncoder().encode(`secret ${seq}`), seq, seq * BLOCK, lcg(seq + 7));
    vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: out.blobId, body: out.body, invite: `r${seq + 1}` });
    seen.push({ seq, pointer: out.pointer });
  }
  const res = vault.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: readSet(channel, seen) });
  assert.ok(res.ok);
  const batch = (res as { found: ReadonlyMap<string, Uint8Array> }).found;
  assert.equal(batch.size, 3, "the decoys should miss and the real ids should hit");
  // Every message is reachable from the one batch, so a reader fetches once and reads any of them.
  for (const s of seen) assert.ok(select(batch, channel, s), `message ${s.seq} was not in the batch`);
  // The server saw one read of eight ids and cannot say which of the three was wanted.
  const [read] = vault.observe().reads;
  assert.ok(read.ids.length >= MIN_READ_BATCH);
  assert.equal(read.hits.filter(Boolean).length, 3);
});
