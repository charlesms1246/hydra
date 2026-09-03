/**
 * The DH ratchet — post-compromise security, which `ratchet.ts` says it does not provide.
 *
 * Forward secrecy and post-compromise security are different properties and this repo now has a
 * module for each. The test that matters is the second one, and it is the last test in this file:
 * an attacker holding a complete copy of the state cannot read what is sent after both ends have
 * each taken one step. That is the only thing the DH half buys, and a Double Ratchet that gets
 * everything else right and that wrong is a symmetric ratchet with extra bytes.
 *
 * `decisions/0032` has the design and the disclosure answer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  newDhState, headerFor, sendKey, receiveKey, step, ratchetPublic, freshRatchetSeed,
  encodeHeader, decodeHeader, rootBytes, HEADER_BYTES, HEADER_RESERVED,
} from "../../handshake/src/dh-ratchet.ts";
import type { DhState, Header } from "../../handshake/src/dh-ratchet.ts";
import { expose, subKey, derive, rootSeed, entropyFrom, fromTestVector, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";

const WHERE = "dh-ratchet test";
const agreed = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(9), "dh-ratchet vector"))));

const keyHex = (k: ReturnType<typeof sendKey> | null) =>
  k === null ? null : Buffer.from(expose(k, VAULT_DOMAIN)).toString("hex");

/** Two ends of one conversation, as X3DH would leave them. */
function pair(): { alice: DhState; bob: DhState } {
  // Bob's ratchet keypair is the one his bundle published, so Alice can take the first step
  // against it. A responder that generated a fresh one here would agree on nothing.
  const bobSeed = freshRatchetSeed();
  const bob = newDhState(agreed, WHERE, { ourSeedHex: bobSeed });
  const alice = newDhState(agreed, WHERE, { theirRatchetKey: ratchetPublic(bobSeed) });
  return { alice, bob };
}

/** Alice sends; the header and key a receiver would need. */
const send = (s: DhState) => {
  const header = headerFor(s);
  return { header, key: keyHex(sendKey(s, WHERE)) };
};

test("a header is fixed width and survives a round trip", () => {
  const h: Header = { ratchetKey: ratchetPublic(freshRatchetSeed()), previousChainLength: 7, messageNumber: 3 };
  const back = decodeHeader(encodeHeader(h));
  assert.deepEqual([...back.ratchetKey], [...h.ratchetKey]);
  assert.equal(back.previousChainLength, 7);
  assert.equal(back.messageNumber, 3);
  assert.equal(encodeHeader(h).length, HEADER_BYTES);
  assert.throws(() => decodeHeader(new Uint8Array(HEADER_BYTES - 1)), /header is/);
});

test("the header fits inside the smallest bucket without moving it", () => {
  // `decisions/0032`: the header takes a reserved prefix INSIDE the bucket, so blob sizes do not
  // change and `blob.bucket` discloses what it always did. If this ever stops being true the
  // disclosure table gains a row, so it is asserted here rather than assumed there.
  assert.equal(HEADER_RESERVED, HEADER_BYTES + 12 + 16);
  assert.ok(HEADER_RESERVED < BUCKETS[0] / 8,
    `a ${HEADER_RESERVED}-byte header is ${(100 * HEADER_RESERVED / BUCKETS[0]).toFixed(1)}% of the `
    + "smallest bucket — at that size it is worth its own row on the disclosure table");
});

test("both ends derive the same key for the same message", () => {
  const { alice, bob } = pair();
  const a = send(alice);
  assert.equal(keyHex(receiveKey(bob, a.header, WHERE)), a.key,
    "the two ends disagree about the first message's key");

  // And back the other way, which is what makes it a ratchet rather than one chain.
  const b = send(bob);
  assert.equal(keyHex(receiveKey(alice, b.header, WHERE)), b.key,
    "the reply's key does not agree");
});

test("messages arriving out of order inside one chain still open", () => {
  const { alice, bob } = pair();
  const sent = [send(alice), send(alice), send(alice)];
  // Third, then first, then second — uploads are late on purpose, so this is ordinary.
  assert.equal(keyHex(receiveKey(bob, sent[2].header, WHERE)), sent[2].key);
  assert.equal(keyHex(receiveKey(bob, sent[0].header, WHERE)), sent[0].key);
  assert.equal(keyHex(receiveKey(bob, sent[1].header, WHERE)), sent[1].key);
});

test("a message from before a step still opens after it", () => {
  // THE CASE A DH RATCHET USUALLY GETS WRONG, and the one this protocol cannot avoid: a blob
  // lands up to eight block intervals after its chain event, so a message from the old chain
  // routinely arrives after the reply that ended it.
  const { alice, bob } = pair();
  const early = send(alice);
  const late = send(alice);
  // Bob reads only the first, replies — which steps his sending chain — and Alice steps too.
  assert.equal(keyHex(receiveKey(bob, early.header, WHERE)), early.key);
  const reply = send(bob);
  assert.equal(keyHex(receiveKey(alice, reply.header, WHERE)), reply.key);
  const afterStep = send(alice);
  assert.equal(keyHex(receiveKey(bob, afterStep.header, WHERE)), afterStep.key);

  // Now the straggler from before the step arrives.
  assert.equal(keyHex(receiveKey(bob, late.header, WHERE)), late.key,
    "a message sent before the step is unopenable after it — that is data loss, not secrecy");
});

test("a key is gone once it has been used", () => {
  const { alice, bob } = pair();
  const a = send(alice);
  assert.equal(keyHex(receiveKey(bob, a.header, WHERE)), a.key);
  assert.equal(receiveKey(bob, a.header, WHERE), null,
    "the same message opened twice — its key was not deleted");
});

test("POST-COMPROMISE: recovery takes a full round trip, and then the thief is out", () => {
  // The property the whole module exists for, and it took two wrong versions to state correctly.
  //
  // THE THIEF ONLY EVER READS ALICE'S MESSAGES. A stolen copy of Bob's state has Bob's RECEIVING
  // chain, which is for messages from Alice. Handing it one of Bob's own outgoing messages asks
  // it to receive something it sent — that fails whatever the keys are, and worse, it steps the
  // copy onto Bob's own ratchet key and destroys it. The first version did exactly that and
  // passed a mutation that removed the security entirely.
  //
  // Recovery needs Bob to mint a new keypair AND Alice to send under it, which is a full round
  // trip. Asserting failure any earlier would be asserting a property no ratchet has.
  const { alice, bob } = pair();
  const opening = send(alice);
  assert.equal(keyHex(receiveKey(bob, opening.header, WHERE)), opening.key);
  const hello = send(bob);
  assert.equal(keyHex(receiveKey(alice, hello.header, WHERE)), hello.key);

  // A complete copy, taken here — root, both chains, Bob's ratchet seed, every parked key.
  const stolen: DhState = JSON.parse(JSON.stringify(bob));

  // 1. Alice speaks under a key the thief already knows about. Bob and the thief agree, and they
  //    MUST — a copy that could not follow here would make everything below vacuous.
  const during = send(alice);
  assert.equal(keyHex(receiveKey(bob, during.header, WHERE)), during.key);
  assert.equal(keyHex(receiveKey(stolen, during.header, WHERE)), during.key,
    "the stolen copy could not read the message it was stolen to read");

  // 2. Receiving that made Bob mint a fresh ratchet keypair. His reply carries its public half —
  //    and the thief, holding only the old private half, cannot get to the new shared secret.
  //    The thief is NOT asked to receive this: it is Bob's own message.
  const reply = send(bob);
  assert.equal(keyHex(receiveKey(alice, reply.header, WHERE)), reply.key);

  // 3. Alice has stepped onto Bob's new key. This is the first message out of reach.
  const after = send(alice);
  assert.equal(keyHex(receiveKey(bob, after.header, WHERE)), after.key,
    "Bob cannot read it either — the ratchet is broken, not secure");
  assert.notEqual(keyHex(receiveKey(stolen, after.header, WHERE)), after.key,
    "the stolen state opened a message sent after a full round trip — there is no "
    + "post-compromise security");

  // And it stays out of reach, rather than the thief being one step behind.
  const later = send(alice);
  assert.equal(keyHex(receiveKey(bob, later.header, WHERE)), later.key);
  assert.notEqual(keyHex(receiveKey(stolen, later.header, WHERE)), later.key,
    "the thief caught up again on the next message");
});
