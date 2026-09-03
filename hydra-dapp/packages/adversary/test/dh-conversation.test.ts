/**
 * A two-party conversation over the DH ratchet, plaintext to plaintext.
 *
 * `dh-ratchet.test.ts` checks the state machine and `blob-header.test.ts` checks the wire. This
 * checks that they compose: the real `send` from `client/src/session.ts`, a real sealed blob with
 * a real header, opened by the other end with nothing but its own state and the addressing key.
 *
 * The reason it is a separate file is that the two halves can each be right while the join is
 * wrong — a header sealed under the wrong key, a message number read off the chain instead of the
 * header, a ratchet advanced on the wrong side. None of that shows up in either unit test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { send } from "../../client/src/session.ts";
import { openForChannel, plaintextOf, openHeader, bodyOf } from "../../vault-client/src/blobs.ts";
import { unframe, ephemeral as deniable } from "../../handshake/src/authorship.ts";
import {
  newDhState, receiveKey, ratchetPublic, freshRatchetSeed, decodeHeader,
} from "../../handshake/src/dh-ratchet.ts";
import type { DhState } from "../../handshake/src/dh-ratchet.ts";
import { channelSecret } from "../../channel/src/pointer.ts";
import { derive, rootSeed, entropyFrom, fromTestVector, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

const BLOCK = 30_000;
const T0 = 1_800_000_000_000;
const WHERE = "dh-conversation test";

const root = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(13), "dh-conversation vector"))));
/** ONE addressing key, both directions — it is what makes a blob findable, and both ends keep it. */
const addressing = channelSecret(root, "alice↔bob");

/** The agreed material X3DH would leave. Both ends start from the same secret. */
const agreed = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(14), "dh-conversation agreed"))));

function pair(): { alice: DhState; bob: DhState } {
  const bobSeed = freshRatchetSeed();
  return {
    bob: newDhState(agreed, WHERE, { ourSeedHex: bobSeed }),
    alice: newDhState(agreed, WHERE, { theirRatchetKey: ratchetPublic(bobSeed) }),
  };
}

/** One message, as a sender produces it and an operator would see it. */
const post = (from: DhState, text: string, seq: number, at: number) =>
  send({ channel: addressing, ratchet: from, author: deniable(), blockMs: BLOCK },
    new TextEncoder().encode(text), seq, at);

/**
 * What the other end does with it: header first, under the addressing key, then the body under
 * the key the header names.
 *
 * TWO WAYS TO FAIL, and both mean "cannot read this", which is why they collapse to null here.
 *
 *   - `receiveKey` returns null: the key is gone. Used and deleted, or skipped past and dropped.
 *   - `openForChannel` THROWS: the ratchet handed back a key, and it is the wrong one. That is
 *     the shape a compromised state fails in — it computes something for every message, and GCM
 *     is what says the something is wrong.
 *
 * A client that let the second escape would turn an unreadable message into a crash, and an
 * attacker can cause unreadable messages at will by writing plausible headers.
 */
function open(to: DhState, wire: Uint8Array): string | null {
  const header = decodeHeader(openHeader(addressing, wire));
  const key = receiveKey(to, header, WHERE);
  if (!key) return null;
  try {
    return new TextDecoder().decode(
      unframe(plaintextOf(openForChannel(key, bodyOf(wire)))).plaintext);
  } catch {
    return null;
  }
}

test("a message crosses, plaintext to plaintext", () => {
  const { alice, bob } = pair();
  const m = post(alice, "meet me at eight", 0, T0);
  assert.equal(open(bob, m.body), "meet me at eight");
});

test("a whole back-and-forth crosses, and every message seals under its own key", () => {
  const { alice, bob } = pair();
  const seen: Uint8Array[] = [];
  const script: [DhState, DhState, string][] = [
    [alice, bob, "are you there"],
    [bob, alice, "yes"],
    [alice, bob, "the usual place"],
    [bob, alice, "eight or nine?"],
    [alice, bob, "eight"],
  ];
  script.forEach(([from, to, text], i) => {
    const m = post(from, text, i, T0 + i * BLOCK);
    seen.push(m.body);
    assert.equal(open(to, m.body), text, `message ${i} did not cross`);
  });

  // No two blobs are the same bytes, which is what a ratchet is for. Two messages under one key
  // would be identical for identical text, and "yes"/"eight" recur in real conversations.
  assert.equal(new Set(seen.map((b) => Buffer.from(b).toString("hex"))).size, seen.length,
    "two messages produced identical bytes — a key was reused");
});

test("a message that arrives after the reply that ended its chain still opens", () => {
  // The case this protocol cannot avoid: uploads are late on purpose, so a straggler from before
  // a DH step is ordinary. `dh-ratchet.test.ts` checks the key survives; this checks the message
  // does, through the real seal.
  const { alice, bob } = pair();
  const early = post(alice, "first", 0, T0);
  const late = post(alice, "second", 1, T0 + BLOCK);
  assert.equal(open(bob, early.body), "first");

  const reply = post(bob, "got it", 0, T0 + 2 * BLOCK);
  assert.equal(open(alice, reply.body), "got it");
  const after = post(alice, "third", 2, T0 + 3 * BLOCK);
  assert.equal(open(bob, after.body), "third");

  assert.equal(open(bob, late.body), "second",
    "the straggler is unreadable — that is data loss dressed as forward secrecy");
});

test("POST-COMPROMISE, at the level of a message rather than a key", () => {
  // The same property `dh-ratchet.test.ts` proves about keys, proved about plaintext. The thief
  // gets a complete copy of Bob's state and reads only ALICE's messages, which is what a copy of
  // Bob's receiving chain is for.
  const { alice, bob } = pair();
  assert.equal(open(bob, post(alice, "hello", 0, T0).body), "hello");
  assert.equal(open(alice, post(bob, "hi", 0, T0 + BLOCK).body), "hi");

  const stolen: DhState = JSON.parse(JSON.stringify(bob));

  // Readable, and it must be — a copy that could not follow here would make the rest vacuous.
  const during = post(alice, "still here", 1, T0 + 2 * BLOCK);
  assert.equal(open(bob, during.body), "still here");
  assert.equal(open(stolen, during.body), "still here",
    "the copy could not read the message it was stolen to read");

  // Bob minted a fresh ratchet key when he received that. Alice steps onto it.
  const rekey = post(bob, "one moment", 1, T0 + 3 * BLOCK);
  assert.equal(open(alice, rekey.body), "one moment");

  // And now the thief is out.
  const after = post(alice, "the secret is 4712", 2, T0 + 4 * BLOCK);
  assert.equal(open(bob, after.body), "the secret is 4712");
  assert.notEqual(open(stolen, after.body), "the secret is 4712",
    "the stolen state read plaintext sent after a full round trip");
});

test("the header is what carries the message number, not the chain sequence", () => {
  // `seq` addresses the blob and the header numbers the ratchet, and they are deliberately not
  // the same counter — a DH step resets the ratchet's numbering while the chain sequence keeps
  // climbing. A reader that used `seq` to index the ratchet would work until the first step.
  const { alice, bob } = pair();
  assert.equal(open(bob, post(alice, "a", 0, T0).body), "a");
  const reply = post(bob, "b", 0, T0 + BLOCK);
  assert.equal(open(alice, reply.body), "b");

  // Alice's next message is chain sequence 7 and ratchet message number 0, because receiving
  // Bob's reply started a new chain.
  const m = post(alice, "c", 7, T0 + 2 * BLOCK);
  assert.equal(decodeHeader(openHeader(addressing, m.body)).messageNumber, 0,
    "the header numbered the message by its chain sequence");
  assert.equal(open(bob, m.body), "c");
});
