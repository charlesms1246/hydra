/**
 * Who wrote this, and who can prove it — asked of the person with a motive to lie.
 *
 * The residual `two-way.test.ts` carried until now: the value a message committed under came
 * from the channel's shared material, so **your counterparty could mint a message that read as
 * yours**. That test asserted the forgery SUCCEEDED, deliberately, so that nobody could believe
 * it was closed while it was not.
 *
 * It is closed. Authorship is an Ed25519 signature over the on-chain commitment, under a key
 * derived from the author's own vault root and published in their bundle
 * (`handshake/src/authorship.ts`). The counterparty holds the public half — enough to verify,
 * never enough to sign.
 *
 * THE ADVERSARY HERE IS THE COUNTERPARTY, not an observer. Bob has everything two people who
 * have completed a handshake share: both addressing keys, both ratchet chains, and alice's
 * published signing key. He has more than any operator, auditor or chain observer will ever
 * have about this conversation. If the property holds against him it holds against them.
 *
 * AND THE OTHER HALF IS DELIBERATE. Ephemeral content carries no signature, so bob CAN fabricate
 * a line and nobody can tell — that is offline deniability, and it is chosen per message rather
 * than inherited from a primitive that happened not to work. The test for it asserts the
 * fabrication succeeds and is indistinguishable, because a deniability property that cannot be
 * demonstrated is a hope.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { init, open, accept, publishBundle, sendMessage, flush, readChannel }
  from "../../cli/src/commands.ts";
import { memoryChain } from "../../cli/src/chain.ts";
import { Vault } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { signerFor, verifyAuthorship, unframe, frame, SIGNATURE_BYTES }
  from "../../handshake/src/authorship.ts";
import { keyFor } from "../../handshake/src/ratchet.ts";
import { openForChannel, plaintextOf, sealForChannel, wireBytes, ENCRYPTED_ENDPOINT }
  from "../../vault-client/src/blobs.ts";
import { pointerFor, blobIdFrom } from "../../channel/src/pointer.ts";
import { noteCalldata } from "../../channel/src/note.ts";
import { commit, contentHashFor } from "../../channel/src/commitment.ts";
import { derive, rootSeed, entropyFrom, fromTestVector, fromStoredSeed, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

/** A stored channel key, materialised the way `commands.ts` materialises one. */
const channelKeyOf = (hexKey: string) => derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromStoredSeed(new Uint8Array(Buffer.from(hexKey, "hex")), "test"))));

const BLOCK = 30_000;
const T0 = 1_800_000_000_000;
const LATER = T0 + 40 * BLOCK;

async function pair(n = 800) {
  const invites = Array.from({ length: n }, (_, i) => `au-${i}`);
  const v = new Vault({ invites: [...invites], buckets: BUCKETS });
  const { url, server } = await serve(v, 0, { rateLimit: { mode: "none" } });
  const alice = init({ vaultUrl: url, blockMs: BLOCK, invites: invites.slice(0, n / 2) });
  const bob = init({ vaultUrl: url, blockMs: BLOCK, invites: invites.slice(n / 2) });
  accept(bob, "alice", open(alice, "bob", publishBundle(bob, 0)));
  return { alice, bob, v, server, chain: memoryChain() };
}

/** Bob taking alice's side of the channel: everything a shared secret gives him. */
const asAlice = (bob: Awaited<ReturnType<typeof pair>>["bob"]) => {
  const his = bob.channels.alice;
  bob.channels.forged = {
    ...his,
    addressSendHex: his.addressRecvHex,
    addressRecvHex: his.addressSendHex,
    send: JSON.parse(JSON.stringify(his.recv)),
    recv: JSON.parse(JSON.stringify(his.send)),
    nextSeq: his.recv.next,
    history: [],
    foreignSeen: 0,
    refusedSeen: 0,
  };
};

// ---------------------------------------------------------------------------

test("the signature verifies for the author and for nobody else", () => {
  const root = (n: number) => derive(VAULT_DOMAIN,
    rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(n), "author"))));
  const alice = signerFor(root(1));
  const mallory = signerFor(root(2));
  const c = commit(99n, contentHashFor(new TextEncoder().encode("a statement")));

  assert.ok(verifyAuthorship(alice.signingKey, c, alice.sign(c)));
  assert.ok(!verifyAuthorship(mallory.signingKey, c, alice.sign(c)),
    "alice's signature verified under mallory's key");
  assert.ok(!verifyAuthorship(alice.signingKey, c + 1n, alice.sign(c)),
    "a signature over one commitment verified over another");
  // And mallory cannot produce alice's, which is the whole point of a key she does not have.
  assert.ok(!verifyAuthorship(alice.signingKey, c, mallory.sign(c)));
});

test("THE HOLE IS CLOSED: the counterparty cannot mint signed content as you", async () => {
  const s = await pair();
  try {
    await sendMessage(s.alice, s.chain, "bob", "signed", "alice really said this", T0);
    await flush(s.alice, LATER);
    await readChannel(s.bob, s.chain, "alice");

    // Bob, holding both addressing keys and both chains, sends into alice's direction. He can
    // produce the ciphertext, the pointer and the chain event. He cannot produce the signature.
    asAlice(s.bob);
    await sendMessage(s.bob, s.chain, "forged", "signed", "alice did NOT say this", T0 + BLOCK);
    await flush(s.bob, LATER);

    const read = await readChannel(s.bob, s.chain, "alice");
    const texts = read.map((m) => m.text);
    assert.ok(texts.includes("alice really said this"));
    assert.ok(!texts.includes("alice did NOT say this"),
      "the forgery was displayed — a counterparty can still speak as you");

    // Refused, not silently downgraded to deniable content. Somebody tried, and the count says so.
    assert.equal(s.bob.channels.alice.refusedSeen, 1,
      "the forgery was dropped without being counted, so nothing can report it");
  } finally { s.server.close(); }
});

test("a REPLAYED signature over different content is refused", async () => {
  // The link a naive implementation leaves out. Verifying a signature over a commitment proves
  // the author signed SOMETHING; it says nothing about the bytes in front of you unless the
  // commitment is recomputed from those bytes and matched against the felt on chain.
  //
  // So bob takes a real signature and a real blind out of a message alice signed, puts them in a
  // frame around words she never wrote, and publishes it under her original commitment. Every
  // individual piece is genuine.
  const s = await pair();
  try {
    await sendMessage(s.alice, s.chain, "bob", "signed", "transfer 10", T0);
    await flush(s.alice, LATER);
    // Snapshotted BEFORE the read, because reading consumes the key and deletes it — bob cannot
    // reopen a message he has already read, which is the ratchet working. An attacker builds
    // this from the frame at the moment they legitimately open it.
    const before = JSON.parse(JSON.stringify(s.bob.channels.alice.recv));
    const read = await readChannel(s.bob, s.chain, "alice");
    assert.equal(read[0].attribution, "signed");

    // What bob has: the commitment from the chain, and the stored object.
    const commitment = (await s.chain.events())[0].data[1];
    const stored = s.v.handle({
      op: "fetch", endpoint: ENCRYPTED_ENDPOINT,
      ids: [read[0].id, ...Array.from({ length: 7 }, (_, i) => `enc:${i}`.padEnd(20, "0"))],
    });
    assert.ok(stored.ok && stored.op === "fetch");
    const body = stored.found.get(read[0].id)!;

    // Bob re-seals under the SAME content key alice used, at the same sequence, with her
    // signature and her blind around different words.
    const key = keyFor(before, 0, "test")!;
    const opened = unframe(plaintextOf(openForChannel(key, body)));
    assert.ok(opened.signature, "the message bob is replaying was not signed");
    assert.equal(commit(opened.blind, contentHashFor(opened.plaintext)), commitment);

    // Sealed under the key for the sequence he is about to publish at, which he holds because a
    // ratchet chain is shared. Everything about this message is legitimate except the pairing.
    const forgeChain = JSON.parse(JSON.stringify(s.bob.channels.alice.recv));
    const nextKey = keyFor(forgeChain, 1, "test")!;
    const forgedBody = wireBytes(sealForChannel(nextKey, frame(
      opened.signature, opened.blind, new TextEncoder().encode("transfer 1000"),
    ))) as unknown as Uint8Array;

    // Published under alice's ORIGINAL commitment, so the signature over it is valid.
    const address = channelKeyOf(s.bob.channels.alice.addressRecvHex);
    const pointer = pointerFor(address, blobIdFrom(forgedBody), 1);
    await s.chain.publish(noteCalldata(pointer, commitment));
    const put = s.v.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT,
      id: `enc:${Buffer.from(blobIdFrom(forgedBody)).toString("hex")}`,
      // An invite from the far end of bob's own allocation, so this does not fail for the boring
      // reason that alice already spent it.
      body: forgedBody, invite: "au-799",
    });
    assert.ok(put.ok, `the forged object was not stored: ${JSON.stringify(put)}`);

    const after = await readChannel(s.bob, s.chain, "alice");
    assert.deepEqual(after.map((m) => m.text), ["transfer 10"],
      "a replayed signature carried different content past the reader");
    assert.equal(s.bob.channels.alice.refusedSeen, 1,
      "the replay was dropped without being counted");
  } finally { s.server.close(); }
});

test("DENIABILITY, chosen: ephemeral content the counterparty can fabricate", async () => {
  const s = await pair();
  try {
    await sendMessage(s.alice, s.chain, "bob", "ephemeral", "meet me at eight", T0);
    await flush(s.alice, LATER);
    const before = JSON.parse(JSON.stringify(s.bob.channels.alice.recv));
    const genuine = await readChannel(s.bob, s.chain, "alice");
    assert.deepEqual(genuine.map((m) => m.text), ["meet me at eight"]);
    assert.equal(genuine[0].attribution, "unverifiable");

    // Bob fabricates a line in alice's direction. Nothing refuses it, because there is nothing
    // to refuse: the only authenticator ephemeral content has is the AEAD tag under a key they
    // both hold, and he holds it.
    asAlice(s.bob);
    await sendMessage(s.bob, s.chain, "forged", "ephemeral", "bring the money", T0 + BLOCK);
    await flush(s.bob, LATER);
    const fabricated = await readChannel(s.bob, s.chain, "forged");
    assert.deepEqual(fabricated.map((m) => m.text), ["bring the money"]);
    assert.equal(s.bob.channels.forged.refusedSeen, 0,
      "something refused the fabrication, which would mean ephemeral content is not deniable");

    // THE PROPERTY, asked the way it would actually be asked: a third party is handed both
    // stored objects and every key either participant holds, and asked which one alice wrote.
    // Both open under the channel's keys and NEITHER carries a signature, so there is nothing in
    // the artifacts to answer with. That is offline deniability, and it is the flavour this
    // product chose — see `claude-docs/decisions/0026-authorship-and-deniability.md`.
    const ids = [genuine[0].id, fabricated[0].id];
    const stored = s.v.handle({
      op: "fetch", endpoint: ENCRYPTED_ENDPOINT,
      ids: [...ids, ...Array.from({ length: 6 }, (_, i) => `enc:${i}`.padEnd(20, "0"))],
    });
    assert.ok(stored.ok && stored.op === "fetch");

    const key = keyFor(before, 0, "test")!;
    const opened = unframe(plaintextOf(openForChannel(key, stored.found.get(ids[0])!)));
    assert.equal(opened.signature, null,
      "an ephemeral message carried a signature, which would settle who wrote it");
    assert.equal(stored.found.get(ids[0])!.length, stored.found.get(ids[1])!.length,
      "the genuine message and the fabrication are different sizes");
  } finally { s.server.close(); }
});

test("signed and ephemeral content are the same size on the wire", async () => {
  // Otherwise the size bucket says which kind a message was, and an observer filtering for
  // "content somebody was willing to put their name to" gets it for free. The frame reserves the
  // signature's bytes either way and fills them with randomness when there is no signature.
  const s = await pair();
  try {
    await sendMessage(s.alice, s.chain, "bob", "signed", "the same words", T0);
    await sendMessage(s.alice, s.chain, "bob", "ephemeral", "the same words", T0 + BLOCK);
    const [a, b] = s.alice.pending.filter((p) => p.real);
    assert.equal(a.bodyB64.length, b.bodyB64.length,
      "a signed message is a different size from a deniable one");
    // And they are not the same bytes, so the choice is not visible by comparison either.
    assert.notEqual(a.bodyB64, b.bodyB64);
  } finally { s.server.close(); }
});

test("identical words no longer produce identical blobs", async () => {
  // A side effect of the blind, and a limitation closed. `sealForChannel` derives its nonce from
  // the plaintext, so a repeated message used to produce a byte-identical object — a repeat the
  // operator could see WITHIN a channel, recorded as an open question in `decisions/0004`. The
  // frame now carries a fresh blind, so the sealed bytes differ every time.
  const s = await pair();
  try {
    for (let i = 0; i < 3; i++) {
      await sendMessage(s.alice, s.chain, "bob", "ephemeral", "on my way", T0 + i * BLOCK);
    }
    const real = s.alice.pending.filter((p) => p.real);
    assert.equal(new Set(real.map((p) => p.id)).size, 3,
      "the same message produced the same object — the operator can see a repeat");
  } finally { s.server.close(); }
});

test("the frame is the only thing that says which kind a message is, and it is sealed", async () => {
  const signature = new Uint8Array(SIGNATURE_BYTES).fill(7);
  const signed = frame(signature, 5n, new TextEncoder().encode("x"));
  const deniable = frame(null, 5n, new TextEncoder().encode("x"));
  assert.equal(signed.length, deniable.length);
  assert.equal(unframe(signed).signature?.length, SIGNATURE_BYTES);
  assert.equal(unframe(deniable).signature, null);
  assert.equal(unframe(signed).blind, 5n);
  assert.deepEqual(Buffer.from(unframe(deniable).plaintext), Buffer.from("x"));
  // Truncation is refused rather than read as a short message.
  assert.throws(() => unframe(signed.slice(0, 10)), /truncated/);
});
