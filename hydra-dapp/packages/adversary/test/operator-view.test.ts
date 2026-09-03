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
import { serve, MAX_BODY } from "../../vault-server/src/http.ts";
import { RateLimiter } from "../../vault-server/src/ratelimit.ts";
import { MIN_READ_BATCH, readSet, select } from "../../client/src/read.ts";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBSERVABLE, OBSERVABLE_IDS, NOT_OBSERVABLE } from "../../vault-server/src/observations.ts";
import { deleteHashFor } from "../../vault-server/src/delete-hash.ts";
import { inboxSlot, encodePrekey } from "../../handshake/src/inbox.ts";
import { initiate, bundleFor } from "../../handshake/src/x3dh.ts";
import { sealForChannel, publish, wireBytes } from "../../vault-client/src/blobs.ts";
import { padTo, unpad, bucketFor, BUCKETS, SEAL_OVERHEAD } from "../../vault-client/src/buckets.ts";
import { channelSecret } from "../../channel/src/pointer.ts";
import { COVER_RATE, coverBody, coverId, NO_CHAIN } from "../../channel/src/cover.ts";
import { jitterWindowMs, MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";
import { rootSeed, entropyFrom, derive, VAULT_DOMAIN, fromTestVector} from "../../identity/src/domains.ts";

const seed = rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(5), "operator-view vector")));
const vaultRoot = derive(VAULT_DOMAIN, seed);
const intent = { confirmedPublicAt: "2026-08-30T00:00:00Z", reason: "operator-view session" };

const bytes = (blob: Parameters<typeof wireBytes>[0]) => wireBytes(blob) as unknown as Uint8Array;

/** Widen a read to the minimum the encrypted endpoint will serve. */
const pad = (ids: string[]): string[] =>
  [...ids, ...Array.from({ length: Math.max(0, MIN_READ_BATCH - ids.length) },
    (_, i) => `enc:${"0".repeat(60)}${i.toString(16).padStart(2, "0")}`)];

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
  // Opting in, because this session is about what an operator can see. The default build
  // keeps no read log at all — see the `observeReads` note in server.ts.
  const vault = new Vault({ invites, now: () => clock, buckets: BUCKETS, observeReads: true });

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
  vault.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: pad([...uploaded, "enc:deadbeef"]) });

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

test("everything the table claims is observable actually is", async () => {
  // The other direction, and the one a disclosure table normally skips. A row nobody can
  // produce is a row that teaches readers the table is decorative.
  //
  // "A full session" has to mean over the transport as well, or the transport rows are
  // unfalsifiable. Adding them without this is what made this check fail when they went in,
  // which is the check doing its job.
  const { vault } = session();
  const { url, server } = await serve(vault, 0, { observeTransport: true });
  try {
    await fetch(`${url}${PUBLIC_ENDPOINT}/pub:nothing`, { method: "POST", body: "[]" });
  } finally {
    server.close();
  }
  const observed = new Set(vault.observedKeys());

  // A full session also means a vault configured the way one would actually be run. The `fs.*`
  // rows are only producible on disk, and adding them without this is what made this check
  // fail — twice now, for the transport rows and again for these.
  const burstInvites = Array.from({ length: COVER_RATE + 1 }, (_, i) => `d${i}`);
  const dir = await mkdtemp(join(tmpdir(), "hydra-vault-"));
  try {
    // And a client flushing a queue by hand, because `upload.burst` is producible only from a
    // batch. It is a message WITH ITS OWN COVER rather than five arbitrary objects: the row
    // claims the operator sees `coverRate + 1` objects arrive as a run, so the capture has to
    // contain that and not a resemblance to it.
    let tick = 1_700_000_000_000;
    const onDisk = new Vault({ invites: burstInvites, buckets: BUCKETS, dir, now: () => tick });
    const channel = channelSecret(vaultRoot, "on-disk");
    const blob = sealForChannel(channel, new TextEncoder().encode("x"));
    // Unpinned, deliberately: `blob.arrival` is derivable only from a TTL deadline, and the
    // session's own objects are all pinned by the time it ends. A vault holding nothing but
    // pinned objects genuinely discloses no arrival time, which is the distinction the row
    // makes and this is what exercises the other side of it.
    onDisk.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id, body: bytes(blob), invite: burstInvites[0] });
    for (let k = 0; k < COVER_RATE; k++) {
      // Milliseconds apart, which is what sequential HTTP requests are. Uploading them at one
      // timestamp would make the batch findable by equality and prove nothing about a client.
      tick += 40;
      const body = coverBody(channel, bytes(blob).length, k, NO_CHAIN);
      onDisk.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: coverId(body), body, invite: burstInvites[k + 1] });
    }
    for (const k of onDisk.observedKeys()) observed.add(k);
    // And a TLS listener, because the `tls.*` rows are only producible when this process is the
    // one terminating. Adding them without this is what made this check fail — for the third
    // time now, after the transport rows and the `fs.*` rows.
    //
    // The certificate is generated here and thrown away. A test key committed to a public repo
    // is a test key somebody eventually uses, however loudly it is labelled.
    const certDir = await mkdtemp(join(tmpdir(), "hydra-tls-"));
    try {
      // A missing openssl is a FAILURE, not a skip: the TLS rows would silently stop being
      // checked, which is how a disclosure row becomes decorative.
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=localhost",
        "-keyout", join(certDir, "k.pem"), "-out", join(certDir, "c.pem"),
      ], { stdio: "ignore" });
      const tlsVault = new Vault({ buckets: BUCKETS });
      const t = await serve(tlsVault, 0, {
        tls: {
          key: readFileSync(join(certDir, "k.pem")),
          cert: readFileSync(join(certDir, "c.pem")),
        },
      });
      assert.ok(t.url.startsWith("https://"), "the TLS listener did not come up on https");
      t.server.close();
      for (const k of tlsVault.observedKeys()) observed.add(k);
    } finally {
      await rm(certDir, { recursive: true, force: true });
    }

    // And a delete capability plus a removal, because `blob.deleteHash` is only producible on an
    // encrypted upload that carries one and `removal.observed` only once something is removed.
    // Adding either without this is what made this check fail — for the fourth time now.
    const capable = new Vault({ invites: ["c1"], buckets: BUCKETS });
    const cblob = sealForChannel(channelSecret(vaultRoot, "capability"),
      new TextEncoder().encode("removable"));
    const token = new Uint8Array(32).fill(9);
    capable.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: cblob.id, body: bytes(cblob),
      invite: "c1", deleteHash: deleteHashFor(token),
    });
    for (const k of capable.observedKeys()) observed.add(k);
    const gone = capable.handle({ op: "remove", id: cblob.id, token });
    assert.ok(gone.ok && gone.op === "remove" && gone.removed, "the capability delete did not work");
    for (const k of capable.observedKeys()) observed.add(k);

    // And the limiter mode that produces `rate.peerBucket`, for the same reason.
    const peered = new Vault({ buckets: BUCKETS });
    const p = await serve(peered, 0, { rateLimit: { mode: "per-peer", perMinute: 10 } });
    p.server.close();
    for (const k of peered.observedKeys()) observed.add(k);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

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

  // Upload channel: two of the three encrypted blobs share a channel, and nothing in the STORED
  // record says which. That is all this claims now — a read batch groups them exactly, which is
  // `read.channelSet` on the observable table and `i3-batch-membership.test.ts` measures it.
  assert.ok(!view.includes("alice"), "a channel label reached the server");
  assert.ok(!view.includes("bob"), "a channel label reached the server");

  // Uploader identity: no accounts, and the invite is gone.
  assert.ok(!view.includes("invite-a"), "a redeemed invite token was retained");
  assert.equal(vault.observe().invitesRedeemed, 3);

  // Read target: the batch is visible, so the wanted id is one of many rather than one of one.
  // Asserted as a floor rather than an exact count — the claim is "at least this wide", and an
  // exact number would have to be edited every time the session sends another message.
  const reads = vault.observe().reads;
  assert.equal(reads.length, 1);
  assert.ok(reads[0].ids.length >= MIN_READ_BATCH,
    `a read asked for ${reads[0].ids.length} ids; ${MIN_READ_BATCH} is the floor that makes the claim true`);
  assert.ok(reads[0].ids.length > uploaded.length, "the batch was not padded beyond what exists");

  // Inbox sender: a prekey message is addressed by its RECIPIENT, so the capture carries
  // nothing that says who wrote it. Its own vault, because this session's counts are asserted
  // exactly above and an extra object would move them.
  const mail = new Vault({ invites: ["m"], buckets: BUCKETS });
  const bobRoot = derive(VAULT_DOMAIN,
    rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(41), "operator-view inbox"))));
  const senderRoot = derive(VAULT_DOMAIN,
    rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(42), "operator-view sender"))));
  const bobKey = bundleFor(bobRoot, 0, 0).identityKey;
  const opening = initiate(senderRoot, bundleFor(bobRoot, 0, 0));
  mail.handle({
    op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: inboxSlot(bobKey, 0),
    body: encodePrekey(opening.message), invite: "m",
  });
  const mailView = JSON.stringify(mail.observe(), (_k, v) =>
    v instanceof Uint8Array ? [...v] : v instanceof Map ? [...v] : v);
  const senderKeyHex = Buffer.from(opening.message.identityKey).toString("hex");
  assert.ok(!mailView.includes(senderKeyHex),
    "the sender's identity key is in the operator's record of a mailbox slot");

  // Content author: the record has no field that could name one, and two blobs written by
  // different participants of one channel are the same shape in it. The load-bearing half of
  // this claim — that the counterparty can produce an indistinguishable message — is measured in
  // `not-observable-mechanisms.test.ts`, because it is a property of the frame rather than of
  // the record.
  const rows = vault.observe().rows;
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).filter((k) => /author|sender|from|signer/i.test(k)), [],
      `the stored record has a field that could name an author: ${Object.keys(row)}`);
  }

  // Every NOT_OBSERVABLE row is one of the cases above; this keeps the two lists in step.
  assert.deepEqual(
    NOT_OBSERVABLE.map((o) => o.id).sort(),
    ["blob.trueLength", "content.author", "content.plaintext", "inbox.sender", "read.target",
      "tls.resumption", "upload.channel", "uploader.identity"],
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
  assert.equal(found(vault.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: pad([post.id]) })).size, 0);
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
  for (const o of OBSERVABLE) {
    assert.ok(o.what.length > 10, `${o.id} has no description`);
    assert.ok(o.why.length > 20, `${o.id} has no reason`);
  }
  // The guarantees carry their reasons as a list of claims, each with its own mechanism, so the
  // check is that every claim says something rather than that one string is long enough.
  for (const g of NOT_OBSERVABLE) {
    assert.ok(g.because.length > 0, `${g.id} states no reason`);
    for (const b of g.because) assert.ok(b.claim.length > 20, `${g.id} has an empty claim`);
  }
  const ids = [...OBSERVABLE, ...NOT_OBSERVABLE].map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate observation id");
});

// ---------------------------------------------------------------------------
// Over HTTP, where the transport discloses more than the object did
// ---------------------------------------------------------------------------

test("served over HTTP, the vault still stores and returns what it should", async () => {
  const vault = new Vault({ invites: ["http-1"], buckets: BUCKETS });
  const { url, server } = await serve(vault);
  try {
    const chan = channelSecret(vaultRoot, "over-http");
    const blob = sealForChannel(chan, new TextEncoder().encode("through a socket"));
    const put = await fetch(`${url}${ENCRYPTED_ENDPOINT}/${blob.id}`, {
      method: "PUT",
      headers: { "x-hydra-invite": "http-1" },
      body: bytes(blob),
    });
    assert.equal(put.status, 201, await put.text());

    const got = await fetch(`${url}${ENCRYPTED_ENDPOINT}`, {
      method: "POST",
      body: JSON.stringify(pad([blob.id, "enc:missing"])),
    });
    const { found } = await got.json() as { found: Record<string, string> };
    assert.deepEqual(Object.keys(found), [blob.id], "the batch returned the wrong set");
    assert.deepEqual(new Uint8Array(Buffer.from(found[blob.id], "base64")), bytes(blob));
  } finally {
    server.close();
  }
});

test("the transport rows are real: an HTTP server can produce every one", async () => {
  // The reason `transport.*` is on the table. The in-process object cannot produce these, and
  // when they were added the over-claims check failed — correctly. This is what makes them
  // honest rather than defensive.
  const vault = new Vault({ invites: ["t-1"], buckets: BUCKETS });
  const { url, server } = await serve(vault, 0, { observeTransport: true });
  try {
    await fetch(`${url}${PUBLIC_ENDPOINT}/pub:nothing`, { method: "POST", body: "[]" });
    const seen = vault.observedKeys();
    for (const id of ["transport.peer", "transport.headers", "transport.timing"]) {
      assert.ok(seen.includes(id), `${id} is on the table but the server cannot produce it`);
    }
    const [record] = vault.observe().transport;
    assert.ok(record.peer.length > 0, "no peer address was observable");
    assert.ok(record.headers.length > 0, "no headers were observable");
    assert.ok(record.at > 0);
  } finally {
    server.close();
  }
});

test("but nothing about the transport is recorded by default", async () => {
  // The difference between what an operator CAN see and what this build keeps. The rows stay
  // on the table either way, because the gap between them is one argument.
  const vault = new Vault({ invites: ["t-2"], buckets: BUCKETS });
  const { url, server } = await serve(vault);
  try {
    await fetch(`${url}${PUBLIC_ENDPOINT}/pub:nothing`, { method: "POST", body: "[]" });
    assert.deepEqual(vault.observe().transport, [], "the default build kept a transport record");
    for (const id of vault.observedKeys()) {
      assert.ok(!id.startsWith("transport."), `${id} was recorded without being asked for`);
    }
  } finally {
    server.close();
  }
});

test("the server refuses a body larger than the largest bucket", async () => {
  // Refused, not truncated: a truncated body would be stored under an id that does not match
  // its bytes, and content addressing would quietly stop being true.
  const vault = new Vault({ invites: ["t-3"], buckets: BUCKETS });
  const { url, server } = await serve(vault);
  try {
    const res = await fetch(`${url}${ENCRYPTED_ENDPOINT}/enc:toobig`, {
      method: "PUT",
      headers: { "x-hydra-invite": "t-3" },
      body: new Uint8Array(MAX_BODY + 1),
    });
    assert.equal(res.status, 400);
    assert.equal(vault.observe().rows.length, 0, "an oversized body was stored anyway");
  } finally {
    server.close();
  }
});

test("the HTTP surface adds no headers of its own beyond the content type", async () => {
  // Every response header is something the operator hands a client for free, and a `Server:`
  // or a request id is a fingerprint the client did not ask to carry.
  const vault = new Vault({ buckets: BUCKETS });
  const { url, server } = await serve(vault);
  try {
    const res = await fetch(`${url}${PUBLIC_ENDPOINT}/pub:nothing`, { method: "POST", body: "[]" });
    const names = [...res.headers.keys()].filter((h) => !["content-type", "content-length", "date", "connection", "keep-alive", "transfer-encoding"].includes(h));
    assert.deepEqual(names, [], `the server set extra headers: ${names.join(", ")}`);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Persisted to disk, where the filesystem discloses things the server did not
// ---------------------------------------------------------------------------

test("objects survive a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hydra-vault-"));
  try {
    const chan = channelSecret(vaultRoot, "persisted");
    const blob = sealForChannel(chan, new TextEncoder().encode("outlives the process"));
    const first = new Vault({ invites: ["p1"], buckets: BUCKETS, dir });
    assert.equal(first.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id, body: bytes(blob), invite: "p1", pin: true,
    }).ok, true);

    // A second Vault over the same directory is what a restart looks like.
    const second = new Vault({ invites: [], buckets: BUCKETS, dir });
    assert.deepEqual(found(second.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: pad([blob.id]) })).get(blob.id),
      bytes(blob), "the object did not survive a restart");
    // Invites do NOT survive, deliberately: a redeemed token is destroyed, and an unredeemed
    // one is the operator's to reissue rather than the store's to remember.
    assert.equal(second.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id, body: bytes(blob), invite: "p1",
    }).ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persistent vault discloses more than an in-memory one, and says so", async () => {
  // The reason `fs.*` is on the table. Persistence is not a neutral implementation detail:
  // the kernel keeps timestamps this code never wrote, and unlink is not erasure.
  const dir = await mkdtemp(join(tmpdir(), "hydra-vault-"));
  try {
    const chan = channelSecret(vaultRoot, "persisted");
    const blob = sealForChannel(chan, new TextEncoder().encode("on disk"));
    const vault = new Vault({ invites: ["p1"], buckets: BUCKETS, dir });
    vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id, body: bytes(blob), invite: "p1", pin: true });

    assert.equal(vault.persistent, true);
    for (const id of ["fs.timestamps", "fs.deletedResidue"]) {
      assert.ok(vault.observedKeys().includes(id), `${id} is on the table but not produced on disk`);
    }
    // And the claim is literally true: the filesystem holds an mtime nobody asked it to.
    const info = await stat(join(dir, `${blob.id}.blob`));
    assert.ok(info.mtimeMs > 0, "the filesystem kept no timestamp — recheck the fs.timestamps row");

    // An in-memory vault produces neither row, so the table is not over-claiming for it.
    const memory = new Vault({ buckets: BUCKETS });
    assert.equal(memory.persistent, false);
    assert.ok(!memory.observedKeys().some((k) => k.startsWith("fs.")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the bytes on disk are exactly the bytes the client sent", async () => {
  // No framing, no envelope, nothing this code could later be trusted not to derive from.
  const dir = await mkdtemp(join(tmpdir(), "hydra-vault-"));
  try {
    const chan = channelSecret(vaultRoot, "persisted");
    const blob = sealForChannel(chan, new TextEncoder().encode("byte for byte"));
    const vault = new Vault({ invites: ["p1"], buckets: BUCKETS, dir });
    vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id, body: bytes(blob), invite: "p1", pin: true });
    assert.deepEqual(new Uint8Array(await readFile(join(dir, `${blob.id}.blob`))), bytes(blob));
    // The sidecar holds only what the table names.
    const meta = JSON.parse(await readFile(join(dir, `${blob.id}.json`), "utf8")) as Record<string, unknown>;
    for (const key of Object.keys(meta)) {
      assert.ok(["class", "id", "bucket", "arrival", "expiresAt"].includes(key),
        `the sidecar holds ${key}, which is not on the disclosure table`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expiry removes the file, not just the entry", async () => {
  // Removing from the map and leaving the bytes on disk would make the TTL a lie about the
  // one thing it is supposed to guarantee.
  const dir = await mkdtemp(join(tmpdir(), "hydra-vault-"));
  try {
    let clock = 1_700_000_000_000;
    const chan = channelSecret(vaultRoot, "persisted");
    const blob = sealForChannel(chan, new TextEncoder().encode("expires"));
    const vault = new Vault({ invites: ["p1"], buckets: BUCKETS, dir, now: () => clock });
    vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id, body: bytes(blob), invite: "p1" });
    clock += DEFAULT_TTL_MS + 1;
    vault.observe();
    assert.equal(existsSync(join(dir, `${blob.id}.blob`)), false, "an expired object stayed on disk");
    assert.equal(existsSync(join(dir, `${blob.id}.json`)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rate limiting, which buys availability with a little linkability
// ---------------------------------------------------------------------------

test("the default limiter keeps nothing that distinguishes one client from another", () => {
  // `global` is the default for exactly this reason. It is worse at its job — one client can
  // degrade the service for everyone — and it is the only mode that keeps no per-client state.
  const limiter = new RateLimiter();
  assert.equal(limiter.mode, "global");
  assert.equal(limiter.keyedByPeer, false);
  for (const peer of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) limiter.allow(peer);
  assert.deepEqual(limiter.observe().keys, ["*"], "the global mode kept a per-client key");
});

test("per-peer limiting adds its row, and the row is honest about what it means", () => {
  // The disclosure this mode costs. Requests from one address share a key for the window, so
  // they are linkable to each other — which is a smaller claim than "we know who you are" and
  // a larger one than the `uploader.identity` row would otherwise suggest.
  let clock = 0;
  const limiter = new RateLimiter({ mode: "per-peer", perMinute: 3 }, () => clock);
  for (let i = 0; i < 3; i++) assert.equal(limiter.allow("9.9.9.9"), true);
  assert.equal(limiter.allow("9.9.9.9"), false, "the limit did not bite");
  assert.equal(limiter.allow("8.8.8.8"), true, "one client's limit hit another");

  const keys = limiter.observe().keys;
  assert.equal(keys.length, 2);
  for (const k of keys) {
    assert.match(k, /^[0-9a-f]{16}$/, "the key is not a truncated hash");
    assert.ok(!k.includes("9.9.9.9") && !k.includes("8.8.8.8"), "an address was stored verbatim");
  }
});

test("the salt is per process, so the key is not a durable pseudonym", () => {
  // A stable salt would make this token identify an address across restarts, and a restart
  // would stop clearing it. The cost is that a restart also resets everyone's quota.
  const a = new RateLimiter({ mode: "per-peer", perMinute: 5 });
  const b = new RateLimiter({ mode: "per-peer", perMinute: 5 });
  a.allow("7.7.7.7");
  b.allow("7.7.7.7");
  assert.notDeepEqual(a.observe().keys, b.observe().keys,
    "two processes derived the same key for one address");
});

test("the window decays rather than accumulating", () => {
  // Fixed window, not sliding: a sliding window has to remember individual request timestamps
  // and a fixed one remembers a count. Fewer bytes about a client is the point.
  let clock = 0;
  const limiter = new RateLimiter({ mode: "per-peer", perMinute: 2 }, () => clock);
  limiter.allow("5.5.5.5");
  limiter.allow("5.5.5.5");
  assert.equal(limiter.allow("5.5.5.5"), false);
  clock += 60_001;
  assert.equal(limiter.allow("5.5.5.5"), true, "the window did not reset");
  // And last window's entries are swept, not archived.
  clock += 60_001;
  limiter.allow("4.4.4.4");
  assert.equal(limiter.observe().keys.length, 1, "a stale window was retained");
});

test("a rate-limited request is refused without describing the limiter", async () => {
  const vault = new Vault({ buckets: BUCKETS });
  const { url, server, limiter } = await serve(vault, 0, { rateLimit: { mode: "global", perMinute: 2 } });
  try {
    const hit = () => fetch(`${url}${PUBLIC_ENDPOINT}/pub:x`, { method: "POST", body: "[]" });
    assert.equal((await hit()).status, 200);
    assert.equal((await hit()).status, 200);
    const refused = await hit();
    assert.equal(refused.status, 429);
    // No Retry-After: it would tell a caller the shape of the bucket, and a client being
    // refused can back off without being handed the configuration.
    assert.equal(refused.headers.get("retry-after"), null);
    assert.equal(limiter.mode, "global");
  } finally {
    server.close();
  }
});

test("a per-peer server reports the row; a global one does not", async () => {
  const global = new Vault({ buckets: BUCKETS });
  const g = await serve(global, 0, { rateLimit: { mode: "global", perMinute: 100 } });
  g.server.close();
  assert.ok(!global.observedKeys().includes("rate.peerBucket"),
    "the global mode claimed a per-client bucket it does not keep");

  const peered = new Vault({ buckets: BUCKETS });
  const p = await serve(peered, 0, { rateLimit: { mode: "per-peer", perMinute: 100 } });
  p.server.close();
  assert.ok(peered.observedKeys().includes("rate.peerBucket"),
    "the per-peer mode did not disclose its bucket");
});

// ---------------------------------------------------------------------------
// Seeing is forced; recording is a choice
// ---------------------------------------------------------------------------

test("the default build keeps no read log at all", () => {
  // The server must be asked for something in order to return it, so an operator watching the
  // process sees every read. It does not have to write them down, and it did — an unbounded
  // list of every id ever requested, which nothing in the server consumed.
  const vault = new Vault({ buckets: BUCKETS });
  for (let i = 0; i < 5; i++) {
    vault.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: pad([`enc:${i}`]) });
  }
  assert.deepEqual(vault.observe().reads, [], "the default build retained a read log");
  for (const id of vault.observedKeys()) {
    assert.ok(!id.startsWith("read."), `${id} was recorded without being asked for`);
  }
  // Reads still work — this is about retention, not about refusing to serve.
  const res = vault.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: pad(["enc:absent"]) });
  assert.equal(res.ok, true);
});

test("no arrival time is stored, and for pinned objects none is derivable", () => {
  // `storedAt` was kept on every object and read by nothing. For anything with a TTL it was
  // also redundant — `expiresAt` minus a published constant is the arrival time — so it
  // disclosed arrival twice for unpinned objects and, for pinned ones, disclosed it where
  // nothing otherwise would have.
  const vault = new Vault({ invites: ["a1", "a2"], buckets: BUCKETS });
  const chan = channelSecret(vaultRoot, "arrival");
  const pinned = sealForChannel(chan, new TextEncoder().encode("kept"));
  const ttl = sealForChannel(chan, new TextEncoder().encode("expires"));
  vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: pinned.id, body: bytes(pinned), invite: "a1", pin: true });

  // Pinned only: no deadline, so no arrival time anywhere in the record.
  const pinnedRows = vault.observe().rows;
  assert.equal(pinnedRows.length, 1);
  assert.equal(pinnedRows[0]["blob.expiry"], null);
  assert.ok(!Object.keys(pinnedRows[0]).some((k) => /arrival|storedAt/i.test(k)),
    "an arrival time is stored on the object");
  assert.ok(!vault.observedKeys().includes("blob.arrival"),
    "a vault of pinned objects claimed to disclose arrival times");

  // Add an unpinned one and the arrival becomes derivable — which the table says, and which is
  // why removing the field was a real reduction only for the pinned case.
  vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: ttl.id, body: bytes(ttl), invite: "a2" });
  assert.ok(vault.observedKeys().includes("blob.arrival"));
  const withTtl = vault.observe().rows.find((r) => r["blob.expiry"] !== null)!;
  assert.equal(Number(withTtl["blob.expiry"]) - DEFAULT_TTL_MS <= Date.now(), true,
    "the deadline does not imply an arrival time — recheck the blob.arrival row");
});

test("a hand-flushed batch is recoverable from the record alone, and a spread client leaves none", () => {
  // The `upload.burst` row, computed. `resident-flush.test.ts` measures what a burst costs the
  // CLIENT — a low mean that comes from destroying the clock rather than from hiding anything.
  // This is the other half: that the vault's own record, with no read log and no transport log
  // and nothing on disk, hands the operator the batch and its size.
  //
  // The two clients differ in nothing but cadence. Same channel, same objects, same count.
  const batch = (spacing: number) => {
    let tick = 1_700_000_000_000;
    const chan = channelSecret(vaultRoot, `burst-${spacing}`);
    const vault = new Vault({
      invites: Array.from({ length: COVER_RATE + 1 }, (_, i) => `b${i}`),
      buckets: BUCKETS, now: () => tick,
    });
    const real = sealForChannel(chan, new TextEncoder().encode("a message"));
    vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: real.id, body: bytes(real), invite: "b0" });
    for (let k = 0; k < COVER_RATE; k++) {
      tick += spacing;
      const body = coverBody(chan, bytes(real).length, k, NO_CHAIN);
      vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: coverId(body), body, invite: `b${k + 1}` });
    }
    return vault;
  };

  // The operator's whole method, from `observe()` and nothing else: sort the deadlines, cut
  // wherever the gap exceeds the second `blob.arrival` already discloses.
  const groups = (vault: Vault): number[] => {
    const at = vault.observe().rows
      .map((r) => Number(r["blob.expiry"]) - DEFAULT_TTL_MS).sort((a, b) => a - b);
    const sizes: number[] = [];
    for (const [i, t] of at.entries()) {
      if (i > 0 && t - at[i - 1] <= 1000) sizes[sizes.length - 1]++;
      else sizes.push(1);
    }
    return sizes;
  };

  // Flushed by hand: sequential requests, milliseconds apart. The operator gets one group of
  // exactly `coverRate + 1` — the message and every decoy that was meant to hide it, delivered
  // as a set. Nothing in it says which is the message; that it is a set is the disclosure.
  const flushed = batch(40);
  assert.deepEqual(groups(flushed), [COVER_RATE + 1],
    "a hand-flushed queue no longer arrives as one group — recheck the upload.burst row");
  assert.ok(flushed.observedKeys().includes("upload.burst"));

  // The same five objects on their own slots inside a jitter window. No group, and the row is
  // absent — the capability is the client's to remove, which is why this is a row about cadence.
  const spread = batch(jitterWindowMs({ blockMs: 30_000, jitterBlocks: MIN_JITTER_BLOCKS }) / COVER_RATE);
  assert.deepEqual(groups(spread), new Array(COVER_RATE + 1).fill(1),
    "a spread client's uploads grouped anyway — the threshold is wrong, not the client");
  assert.ok(!spread.observedKeys().includes("upload.burst"),
    "a client that spread its uploads was reported as bursting");
});

test("A STRANGER CANNOT TAKE DOWN A PUBLIC POST, which they could until `decisions/0035`", async () => {
  // A public blob's id is public BY CONSTRUCTION — it is how the object is fetched, and it is in
  // the pointer. `DELETE /v1/pub/<id>` had no check of any kind, so anyone who could read a post
  // could delete it with one unauthenticated request. Measured against the real server before the
  // token existed: `{"ok":true,"op":"remove","removed":true}`, and the object was gone.
  //
  // This is the narrowest fix that does not pre-empt the moderation design, because every option
  // in `decisions/0035` ends with the OPERATOR performing the removal, whoever asked for it.
  const post = publish(new TextEncoder().encode("a public statement"), intent);
  const withToken = async (token?: string) => {
    const vault = new Vault({ invites: [], buckets: BUCKETS });
    const { url, server } = await serve(vault, 0, token ? { removalToken: token } : {});
    try {
      await fetch(`${url}${PUBLIC_ENDPOINT}/${post.id}`, { method: "PUT", body: bytes(post) });
      assert.equal(vault.observe().rows.length, 1, "the post did not store");
      const attempts: Record<string, number> = {};
      for (const [label, headers] of [
        ["none", {}],
        ["wrong", { "x-hydra-removal": "guess" }],
        ["right", { "x-hydra-removal": token ?? "" }],
      ] as const) {
        const r = await fetch(`${url}${PUBLIC_ENDPOINT}/${post.id}`, { method: "DELETE", headers });
        attempts[label] = r.status;
      }
      return { attempts, left: vault.observe().rows.length };
    } finally { server.close(); }
  };

  // No token configured: refused outright. An operator who has not decided who may remove content
  // has not thereby decided that everyone may.
  const unset = await withToken(undefined);
  assert.equal(unset.attempts.none, 404);
  assert.equal(unset.attempts.right, 404);
  assert.equal(unset.left, 1, "a post was removed by a server with no removal token configured");

  // Token configured: only the token works, and a miss is a 404 rather than a 401 — a 401 would
  // confirm the object exists to anyone probing ids.
  const set = await withToken("s3cret");
  assert.equal(set.attempts.none, 404);
  assert.equal(set.attempts.wrong, 404);
  assert.equal(set.attempts.right, 200);
  assert.equal(set.left, 0, "the operator's own takedown did not work");
});
