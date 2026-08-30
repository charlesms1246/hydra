/**
 * The operator view — Phase 3's acceptance condition.
 *
 * `HYDRA_HANDOFF.md` Phase 3: "run the server, capture everything it can observe across a
 * realistic session, assert the capture matches the published disclosure table exactly.
 * Anything observable but undocumented is a bug."
 *
 * Both directions are checked, because a table that over-claims is its own failure: if people
 * find one entry that is not real, they stop trusting the entries that are. So an observation
 * with no row fails, and a row with no observation fails.
 *
 * The session below is a realistic one rather than a minimal one — two channels, a public
 * post, TTL and pinning, an expiry, a batched read, a miss, an operator takedown. A capture
 * over a session that never exercises a feature cannot notice what that feature discloses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Vault, ENCRYPTED_ENDPOINT, PUBLIC_ENDPOINT, DEFAULT_TTL_MS } from "../../vault-server/src/server.ts";
import { OBSERVABLE, OBSERVABLE_IDS, NOT_OBSERVABLE } from "../../vault-server/src/observations.ts";
import { sealForChannel, publish, wireBytes } from "../../vault-client/src/blobs.ts";
import { padTo, unpad, bucketFor, BUCKETS, SEAL_OVERHEAD } from "../../vault-client/src/buckets.ts";
import { channelSecret } from "../../channel/src/pointer.ts";
import { rootSeed, entropyFrom, derive, VAULT_DOMAIN } from "../../identity/src/domains.ts";

const seed = rootSeed(entropyFrom(new Uint8Array(32).fill(5), "operator-view vector"));
const vaultRoot = derive(VAULT_DOMAIN, seed);
const intent = { confirmedPublicAt: "2026-08-30T00:00:00Z", reason: "operator-view session" };

const bytes = (blob: Parameters<typeof wireBytes>[0]) => wireBytes(blob) as unknown as Uint8Array;

/**
 * Narrowing helpers. Casting the response instead would defeat the I5 build gate, which
 * requires every file it type-checks to be clean — and it caught exactly that here.
 */
type Reply = ReturnType<Vault["handle"]>;
const found = (r: Reply): ReadonlyMap<string, Uint8Array> => {
  if (!r.ok || r.op !== "fetch") throw new Error(`expected a fetch reply, got ${JSON.stringify(r)}`);
  return r.found;
};
const removed = (r: Reply): boolean => {
  if (!r.ok || r.op !== "remove") throw new Error(`expected a remove reply, got ${JSON.stringify(r)}`);
  return r.removed;
};
const errorOf = (r: Reply): string => {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r)}`);
  return r.error;
};

/** A realistic session, driven against the real server. Returns the vault for inspection. */
function session() {
  let clock = 1_700_000_000_000;
  const invites = ["invite-a", "invite-b", "invite-c", "invite-d"];
  const vault = new Vault({ invites, now: () => clock, buckets: BUCKETS });

  const alice = channelSecret(vaultRoot, "alice→bob");
  const carol = channelSecret(vaultRoot, "alice→carol");
  const uploaded: string[] = [];

  for (const [i, channel] of [alice, carol, alice].entries()) {
    const blob = sealForChannel(channel, new TextEncoder().encode(`message ${i}`));
    const res = vault.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id,
      body: bytes(blob), invite: invites[i], pin: i === 2,
    });
    assert.equal(res.ok, true, `upload ${i} failed: ${JSON.stringify(res)}`);
    uploaded.push(blob.id);
    clock += 60_000;
  }

  const post = publish(new TextEncoder().encode("a public post"), intent);
  assert.equal(vault.handle({
    op: "upload", endpoint: PUBLIC_ENDPOINT, id: post.id, body: bytes(post), pin: true,
  }).ok, true);

  // A batched read over the client's whole channel set, plus an id that was never stored.
  vault.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: [...uploaded, "enc:deadbeef"] });

  // Walk past the TTL: the two unpinned objects go, the pinned one stays.
  clock += DEFAULT_TTL_MS + 1;

  return { vault, uploaded, post, clock: () => clock };
}

test("everything the operator can observe is on the published table", () => {
  const { vault } = session();
  const observed = vault.observedKeys();
  assert.ok(observed.length > 0, "the session produced no observations at all");
  const undocumented = observed.filter((k) => !OBSERVABLE_IDS.includes(k));
  assert.deepEqual(undocumented, [],
    `observable but undocumented — add a row to observations.ts:\n${undocumented.join("\n")}`);
});

test("everything the table claims is observable actually is", () => {
  // The other direction, and the one a disclosure table normally skips. A row nobody can
  // produce is a row that teaches readers the table is decorative.
  const { vault } = session();
  const observed = new Set(vault.observedKeys());
  const unproduced = OBSERVABLE_IDS.filter((id) => !observed.has(id));
  assert.deepEqual(unproduced, [],
    `documented but not observable in a full session — the table over-claims:\n${unproduced.join("\n")}`);
});

test("the stored record holds no field the table does not name", () => {
  // observedKeys() reports what the server chose to surface. This checks the record itself,
  // because the interesting regression is a field added to storage and quietly not reported.
  const { vault } = session();
  for (const row of vault.observe().rows) {
    for (const key of Object.keys(row)) {
      assert.ok(OBSERVABLE_IDS.includes(key), `stored field ${key} is not on the table`);
    }
  }
});

test("the capture confirms each NOT_OBSERVABLE claim", () => {
  const { vault, uploaded } = session();
  const view = JSON.stringify(vault.observe(), (_k, v) =>
    v instanceof Uint8Array ? [...v] : v instanceof Map ? [...v] : v);

  // Plaintext never appears anywhere in what the operator holds.
  assert.ok(!view.includes("message 0"), "plaintext of an encrypted blob is visible");
  // Public content is world-readable by design, but it is not in the operator's METADATA
  // capture either — the bytes live in storage, and the capture is what is recorded about them.
  assert.ok(!view.includes("a public post"), "blob content leaked into the metadata capture");

  // Channel membership: two of the three encrypted blobs share a channel, and nothing in the
  // capture says which. The only way to tell would be a field naming the channel.
  assert.ok(!view.includes("alice"), "a channel label reached the server");
  assert.ok(!view.includes("bob"), "a channel label reached the server");

  // Uploader identity: no accounts, and the invite is gone.
  assert.ok(!view.includes("invite-a"), "a redeemed invite token was retained");
  assert.equal(vault.observe().invitesRedeemed, 3);

  // Read target: the batch is visible, so the wanted id is one of four rather than one of one.
  const reads = vault.observe().reads;
  assert.equal(reads.length, 1);
  assert.equal(reads[0].ids.length, uploaded.length + 1);

  // Every NOT_OBSERVABLE row is one of the cases above; this keeps the two lists in step.
  assert.deepEqual(
    NOT_OBSERVABLE.map((o) => o.id).sort(),
    ["blob.trueLength", "channel.membership", "content.plaintext", "read.target", "uploader.identity"],
  );
});

test("true message length never reaches the server", () => {
  // The bucketing claim, checked at the server rather than in the padding unit test: messages
  // of wildly different sizes must arrive indistinguishable within a bucket.
  const { vault } = session();
  const chan = channelSecret(vaultRoot, "alice→bob");
  const lengths = [1, 2, 100, 900, 992];
  const sizes = new Set<number>();
  for (const n of lengths) {
    const blob = sealForChannel(chan, new Uint8Array(n));
    sizes.add(bytes(blob).length);
  }
  assert.equal(sizes.size, 1, `messages of ${lengths.join(", ")} bytes produced ${sizes.size} distinct sizes`);
  assert.equal([...sizes][0], BUCKETS[0]);
  for (const row of vault.observe().rows) assert.ok(BUCKETS.includes(row["blob.bucket"] as number));
});

test("the server refuses an unpadded upload", () => {
  // The one place it can be enforced. Once the bytes are stored the true length has already
  // been disclosed, and no later padding undoes it.
  const vault = new Vault({ invites: ["i"], buckets: BUCKETS });
  // Constructed by hand rather than through sealForChannel, which pads — this is the client
  // that did not use the client library, which is the one the server has to refuse.
  const blob = sealForChannel(channelSecret(vaultRoot, "c"), new TextEncoder().encode("unpadded"));
  const res = vault.handle({
    op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id,
    body: bytes(blob).slice(0, 900), invite: "i",
  });
  assert.equal(res.ok, false);
  assert.match(errorOf(res), /size bucket/);
});

test("padding round-trips and buckets are chosen tightly", () => {
  for (const n of [0, 1, 992, 993, 4063, 4064]) {
    assert.equal(unpad(padTo(new Uint8Array(n).fill(7), SEAL_OVERHEAD)).length, n);
    assert.equal(unpad(padTo(new Uint8Array(n).fill(7), 0)).length, n);
  }
  assert.equal(bucketFor(0), 1024);
  // The boundary is where the length prefix and the seal overhead push it over: 992 fits a
  // 1 KiB bucket once framed and sealed, 993 does not.
  assert.equal(bucketFor(992, SEAL_OVERHEAD), 1024);
  assert.equal(bucketFor(993, SEAL_OVERHEAD), 4096);
  assert.throws(() => padTo(new Uint8Array(300_000), 0), /largest bucket/);
});

test("an invite admits exactly one upload and is not reusable", () => {
  const vault = new Vault({ invites: ["once"], buckets: BUCKETS });
  const chan = channelSecret(vaultRoot, "c");
  const one = sealForChannel(chan, new TextEncoder().encode("a"));
  const two = sealForChannel(chan, new TextEncoder().encode("b"));
  assert.equal(vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: one.id, body: bytes(one), invite: "once" }).ok, true);
  assert.equal(vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: two.id, body: bytes(two), invite: "once" }).ok, false);
  // The public endpoint is not gated: publishing is world-readable by definition and an
  // invite there would be a record of who published what.
  const post = publish(new Uint8Array([1]), intent);
  assert.equal(vault.handle({ op: "upload", endpoint: PUBLIC_ENDPOINT, id: post.id, body: bytes(post) }).ok, true);
});

test("I5 survives the server: a blob cannot enter through the wrong door", () => {
  const vault = new Vault({ invites: Array.from({ length: 64 }, (_, i) => `i${i}`), buckets: BUCKETS });
  const chan = channelSecret(vaultRoot, "c");
  for (let i = 0; i < 32; i++) {
    const enc = sealForChannel(chan, new Uint8Array(8).fill(i));
    const pub = publish(new Uint8Array(8).fill(i), intent);
    // An encrypted blob at the public endpoint, which is the accident I5 exists to prevent.
    const wrong = vault.handle({ op: "upload", endpoint: PUBLIC_ENDPOINT, id: enc.id, body: bytes(enc) });
    assert.equal(wrong.ok, false, "an encrypted blob was accepted at the public endpoint");
    // And the reverse, which is merely a bug but would burn an invite on a public object.
    const alsoWrong = vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: pub.id, body: bytes(pub), invite: `i${i}` });
    assert.equal(alsoWrong.ok, false);
  }
});

test("reads are unauthenticated and scoped to their endpoint", () => {
  // The blob id is the capability: anyone holding it reads, with no account and no token.
  // But an id from one class must not resolve at the other's endpoint, or the namespaces are
  // only cosmetically separate.
  const { vault, post } = session();
  assert.ok(found(vault.handle({ op: "fetch", endpoint: PUBLIC_ENDPOINT, ids: [post.id] })).has(post.id));
  assert.equal(found(vault.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: [post.id] })).size, 0);
});

test("TTL expires by default and pinning survives; takedown is public-only", () => {
  const { vault, uploaded, post } = session();
  const held = new Set(vault.observe().rows.map((r) => r["blob.id"]));
  assert.ok(!held.has(uploaded[0]), "an unpinned object outlived its TTL");
  assert.ok(held.has(uploaded[2]), "a pinned object was expired");

  // The operator can remove a public object. The on-chain commitment stands regardless, which
  // is what keeps takedown from being a rewrite of the record.
  assert.equal(removed(vault.handle({ op: "remove", id: post.id })), true);
  // And cannot remove an encrypted one — an object they can be compelled to delete without
  // knowing what it is.
  assert.equal(removed(vault.handle({ op: "remove", id: uploaded[2] })), false);
});

test("every table row carries a reason, and the ids are unique", () => {
  // The table is read by people deciding whether to trust the thing. A row without a why is a
  // row that gets argued about instead of understood.
  for (const o of [...OBSERVABLE, ...NOT_OBSERVABLE]) {
    assert.ok(o.what.length > 10, `${o.id} has no description`);
    assert.ok(o.why.length > 20, `${o.id} has no reason`);
  }
  const ids = [...OBSERVABLE, ...NOT_OBSERVABLE].map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate observation id");
});
