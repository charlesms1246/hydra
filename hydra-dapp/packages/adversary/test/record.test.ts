/**
 * The forgery moved up a level, and this is where it stops.
 *
 * `authorship.test.ts` closed the counterparty forgery: content is signed under a key only the
 * author holds. That left a residual the TODO calls load-bearing — **a signature is only
 * checkable by somebody who has your signing key**, and today that is a counterparty who
 * completed a handshake. Signing content that nobody else can verify is most of the cost of
 * signing it and none of the benefit.
 *
 * Publishing the key fixes it, and creates a new attacker in the same motion. Every field in a
 * bundle is public — that is what publishing means — so bob can copy alice's bundle verbatim
 * into his own name, and a stranger resolving that name checks a signature alice made and is
 * told bob wrote it. `verifyBundle` passes, because the copy is genuine. No shared secret is
 * needed this time; anyone at all can do it.
 *
 * THE ADVERSARY HERE IS A PUBLISHER, not a counterparty and not an operator. He is given
 * everything public, which is everything, and asked to be believed at his own address.
 *
 * The whole defence is one extra signature over the address the record sits at. So the tests
 * that matter are the ones that would still pass without it — the copy verifying as a bundle —
 * placed next to the one that would not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  recordFor, encodeRecord, decodeRecord, verifyRecord, bundleOf, anchorStatement,
  RECORD_BYTES, RECORD_FELTS, FELT_BYTES, RECORD_VERSION,
} from "../../handshake/src/record.ts";
import { verifyBundle, prekeyStatement, KEY_BYTES } from "../../handshake/src/keys.ts";
import { createStore, rotate } from "../../handshake/src/prekeys.ts";
import { initiate } from "../../handshake/src/x3dh.ts";
import {
  init, open, accept, publishBundle, myRecord, anchorPeer, anchorOf, attributionLabel,
} from "../../cli/src/commands.ts";
import { components, links, evidence } from "../../identity/src/linkage.ts";
import { derive, rootSeed, entropyFrom, fromTestVector, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

const rootOf = (fill: number, who: string) => derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(fill), who))));

const ALICE_AT = 0x049d36570d4e46f48e99674bd3fcc5644ddd8e0e5db65d0bcaa2e4bc0b2b3c9an;
const BOB_AT = 0x0517ececd29116499f4a1b64b094da79ba08dfd54a3edaa316134c41f8160973n;

const aliceRoot = rootOf(3, "alice");
const aliceStore = createStore();
const aliceRecord = recordFor(aliceRoot, aliceStore, ALICE_AT);

// ---------------------------------------------------------------------------
// The record itself
// ---------------------------------------------------------------------------

test("a record survives the felts and verifies at the address it names", () => {
  const felts = encodeRecord(aliceRecord);
  assert.equal(felts.length, RECORD_FELTS);
  const back = decodeRecord(felts);
  assert.deepEqual(back, aliceRecord, "the record did not survive its own encoding");
  assert.doesNotThrow(() => verifyRecord(back, ALICE_AT));
  // And the bundle a reader gets out of it is usable: a stranger can start a conversation from
  // a record alone, which is the other half of what publishing is for.
  assert.doesNotThrow(() => initiate(rootOf(9, "stranger"), bundleOf(back, ALICE_AT)));
});

test("THE COPY. Bob republishes alice's record at his own address and is refused", () => {
  const copied = decodeRecord(encodeRecord(aliceRecord));
  assert.throws(() => verifyRecord(copied, BOB_AT), /published elsewhere/);

  // The half that shows the anchor signature is what did it, rather than something else
  // catching the copy by accident: as a BUNDLE the copy is perfectly genuine. Every existing
  // check passes on it. Without the second signature, bob succeeds.
  assert.doesNotThrow(() => verifyBundle({
    identityKey: copied.identityKey,
    signingKey: copied.signingKey,
    signedPrekey: copied.signedPrekey,
    signedPrekeySignature: copied.signedPrekeySignature,
    epoch: copied.epoch,
  }), "the copy is a genuine bundle — if this throws, this test is measuring the wrong thing");
});

test("bob cannot re-sign the anchor, because signing is what he does not have", () => {
  // The only way to move a record is to produce the anchor signature for the new address, which
  // needs alice's Ed25519 private. Bob signing with his own key produces a record whose signing
  // key is bob's — a record for bob, which is exactly what he is allowed to publish and is not
  // the attack.
  const bobRecord = recordFor(rootOf(5, "bob"), createStore(), BOB_AT);
  assert.doesNotThrow(() => verifyRecord(bobRecord, BOB_AT));
  assert.notDeepEqual(bobRecord.signingKey, aliceRecord.signingKey);

  // And splicing: alice's keys with bob's anchor signature. The signature does not verify under
  // the signing key in the record, which is the field it has to be checked against.
  const spliced = { ...aliceRecord, anchorSignature: bobRecord.anchorSignature };
  assert.throws(() => verifyRecord(spliced, BOB_AT), /published elsewhere/);
});

test("the anchor signature is over the keys as well as the address", () => {
  // Otherwise a real anchor signature could be lifted onto a different signing key at the same
  // address, and the address is the one thing an attacker who owns a name controls.
  const swapped = { ...aliceRecord, signingKey: recordFor(rootOf(5, "bob"), createStore(), ALICE_AT).signingKey };
  assert.throws(() => verifyRecord(swapped, ALICE_AT));
  const movedPrekey = { ...aliceRecord, signedPrekey: aliceRecord.identityKey };
  assert.throws(() => verifyRecord(movedPrekey, ALICE_AT));
  const wrongEpoch = { ...aliceRecord, epoch: aliceRecord.epoch + 1 };
  assert.throws(() => verifyRecord(wrongEpoch, ALICE_AT));
});

test("the two statements one key signs cannot be confused for each other", () => {
  // One Ed25519 key signs both the prekey statement and the anchor. Overlapping encodings are
  // how a signature made for one purpose gets replayed as a signature for another, so the
  // domains differ and neither is a prefix of the other.
  const anchor = anchorStatement(ALICE_AT, aliceRecord);
  const prekey = prekeyStatement(aliceRecord.identityKey, aliceRecord.signedPrekey, aliceRecord.epoch);
  assert.notEqual(anchor.toString("latin1"), prekey.toString("latin1"));
  assert.ok(!anchor.toString("latin1").startsWith(prekey.toString("latin1")));
  assert.ok(!prekey.toString("latin1").startsWith(anchor.toString("latin1")));
});

test("a rotated epoch produces a different record, and the old one still verifies", () => {
  // Rotation is not revocation and the record cannot pretend otherwise: chain state replaces
  // what is CURRENT, and anyone who copied the old felts still holds a record that verifies.
  // What rotation buys is that the retired prekey's private is gone, so nobody can answer it.
  const store = createStore();
  const before = recordFor(aliceRoot, store, ALICE_AT);
  rotate(store);
  const after = recordFor(aliceRoot, store, ALICE_AT);
  assert.notEqual(after.epoch, before.epoch);
  assert.notDeepEqual(after.signedPrekey, before.signedPrekey);
  assert.deepEqual(after.signingKey, before.signingKey, "rotation must not change the identity");
  assert.doesNotThrow(() => verifyRecord(before, ALICE_AT));
});

// ---------------------------------------------------------------------------
// The wire form, which anyone may write to
// ---------------------------------------------------------------------------

test("a record is fixed width, so a partial write is arithmetic rather than a check", () => {
  const felts = encodeRecord(aliceRecord);
  assert.equal(RECORD_BYTES, 1 + 4 + KEY_BYTES * 3 + 64 * 2);
  assert.throws(() => decodeRecord(felts.slice(0, -1)), /is 8 felts, got 7/);
  assert.throws(() => decodeRecord([...felts, 1n]), /is 8 felts, got 9/);
  // Every felt fits a chunk. 31 bytes rather than 32 because a felt252 is smaller than the
  // prime and 32 arbitrary bytes can exceed it — an unlucky key would otherwise be unpublishable.
  for (const f of felts) assert.ok(f < 1n << BigInt(FELT_BYTES * 8));
});

test("felts that did not come from a record are refused rather than decoded", () => {
  const felts = encodeRecord(aliceRecord);
  const oversized = [...felts];
  oversized[0] = 1n << 250n;
  assert.throws(() => decodeRecord(oversized), /does not fit/);
  assert.throws(() => decodeRecord(felts.map(() => -1n)), /does not fit/);
  // A version this build does not know is an error, not a misparse. Reading a v2 record as a v1
  // one produces keys rather than a refusal, which is worse than failing.
  const future = [...felts];
  future[0] = felts[0] + (BigInt(RECORD_VERSION + 1 - RECORD_VERSION) << BigInt((FELT_BYTES - 1) * 8));
  assert.throws(() => decodeRecord(future), new RegExp(`this client reads ${RECORD_VERSION}`));
});

test("no one-time prekey reaches the record", () => {
  // Deliberate: they are consumed, there are many, and a chain record charges per felt — so
  // putting one on chain means paying to consume it. The byte budget is the assertion, because
  // a field added later would have to change it.
  assert.equal(RECORD_BYTES, 229);
  assert.equal(RECORD_FELTS, 8);
  const felts = encodeRecord(aliceRecord);
  const flat = felts.map((f) => f.toString(16)).join("");
  const bundle = publishBundle(init(), 0);
  assert.ok(bundle.oneTimePrekey, "the fixture has no one-time key, so this test proves nothing");
  assert.ok(!flat.includes(Buffer.from(bundle.oneTimePrekey!).toString("hex")));
});

// ---------------------------------------------------------------------------
// What it does in the product
// ---------------------------------------------------------------------------

test("anchoring turns trust-on-first-use into a check, and says so on screen", () => {
  const alice = init();
  const bob = init();
  accept(bob, "alice", open(alice, "bob", publishBundle(bob, 0)));

  // Before: the key alice verifies bob's signatures against came from the handshake. Real, and
  // silent about who answered it.
  assert.equal(anchorOf(alice, "bob"), null);
  const before = attributionLabel({ mine: false, attribution: "signed" }, "bob", anchorOf(alice, "bob"));
  assert.match(before.basis, /not published/);

  const published = myRecord(bob, BOB_AT);
  const at = anchorPeer(alice, "bob", BOB_AT, published.felts);
  assert.equal(at, `0x${BOB_AT.toString(16)}`);
  assert.equal(anchorOf(alice, "bob"), at);
  const after = attributionLabel({ mine: false, attribution: "signed" }, "bob", anchorOf(alice, "bob"));
  assert.match(after.basis, new RegExp(at));
  assert.equal(after.mark, before.mark, "an anchor must change the basis, never the mark");
});

test("a record that disagrees with the handshake is REFUSED, not preferred", () => {
  // The two could disagree because the handshake was answered by somebody else, or because the
  // record is not theirs. Nothing here can tell those apart, so overwriting the stored key would
  // settle — silently, in the attacker's favour — the exact question the user ran this to ask.
  const alice = init();
  const bob = init();
  const mallory = init();
  accept(bob, "alice", open(alice, "bob", publishBundle(bob, 0)));

  const impostor = myRecord(mallory, BOB_AT).felts;
  assert.throws(() => anchorPeer(alice, "bob", BOB_AT, impostor), /different signing key/);
  assert.equal(anchorOf(alice, "bob"), null, "a refused record still moved the channel");

  // And bob's own record at the wrong address fails earlier, on the anchor.
  assert.throws(() => anchorPeer(alice, "bob", ALICE_AT, myRecord(bob, BOB_AT).felts),
    /published elsewhere/);
  assert.equal(anchorOf(alice, "bob"), null);
});

test("a record verifies content from someone this client never handshook with", () => {
  // The residual, stated as the property that closes it. A stranger holds nothing but the felts
  // and the address they came from, and ends up with a signing key they can check signatures
  // against — which is what makes signed content mean anything outside a conversation.
  const bob = init();
  const felts = myRecord(bob, BOB_AT).felts;
  const stranger = decodeRecord(felts);
  assert.doesNotThrow(() => verifyRecord(stranger, BOB_AT));
  assert.deepEqual(stranger.signingKey, publishBundle(bob, 0).signingKey);
});

// ---------------------------------------------------------------------------
// What it costs, computed
// ---------------------------------------------------------------------------

test("publishing a record LINKS the messaging identity to the address, and the model says so", () => {
  // Not a caveat in prose. `linkage.ts` computes it from the same rule that computes every other
  // disclosure in this project, and the answer is that a public observer joins the two — which
  // is precisely the link `decisions/0002` built a harness to show a fresh identity does not
  // have. The anchor is the disclosure; an anchor nobody can read is not an anchor.
  const plan = [{ op: "publishRecord" as const, user: "fresh", identity: "messaging", submitter: "fresh" }];
  assert.ok(links(plan, "public", "fresh", "messaging"));
  assert.ok(evidence(plan, "public").some((r) => r.step === "publishRecord"));

  // And it is transitive through whatever else that address does. An address funded from an
  // exchange, then used to anchor a record, names the messaging identity to the exchange's
  // observer too.
  const funded = [
    { op: "erc20" as const, from: "exchange", to: "fresh" },
    ...plan,
  ];
  assert.ok(links(funded, "public", "exchange", "messaging"),
    "funding and anchoring did not join, so the model is missing the hop that matters");

  // Not publishing keeps them apart, which is what makes the row above a cost rather than a fact
  // of life. This is the choice the client has to put in front of a user.
  assert.ok(!links([{ op: "erc20" as const, from: "exchange", to: "fresh" }], "public", "exchange", "messaging"));
  assert.equal(components(plan, "public").length, 1);
});
