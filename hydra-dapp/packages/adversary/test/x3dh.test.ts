/**
 * The handshake, attacked.
 *
 * X3DH's whole value is a list of properties, and each one is bought by exactly one of the four
 * Diffie-Hellmans. A test that only checks "both sides agree" would pass with any three of them
 * — and would pass with one — so most of this file is about which property dies when which
 * input changes.
 *
 * The last two tests are the uncomfortable ones. `keys.ts` claims "everything is derived, not
 * stored" as a virtue, and it is one operationally; it also costs forward secrecy against root
 * compromise, which Signal buys by deleting prekey privates. That is measured here rather than
 * argued about, and it is on `TODO.md` as a decision.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { uncoveredRoutes } from "../src/must-not-compile.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { initiate, respond, respondWith, bundleFor, verifyBundle } from "../../handshake/src/x3dh.ts";
import { createStore, mintOneTime, rotate, bundleFrom, oneTimeRemaining }
  from "../../handshake/src/prekeys.ts";
import type { PrekeyMessage } from "../../handshake/src/x3dh.ts";
import { identityDh, rawPublic, signedPrekey, prekeyStatement, LABELS }
  from "../../handshake/src/keys.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, expose, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDSHAKE_SRC = join(HERE, "..", "..", "handshake", "src");

const rootOf = (fill: number, label: string): Secret<typeof VAULT_DOMAIN> =>
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(fill), label))));

const alice = rootOf(1, "alice");
const bob = rootOf(2, "bob");
const mallory = rootOf(9, "mallory");

const key = (s: Secret<typeof VAULT_DOMAIN>) =>
  Buffer.from(expose(s, VAULT_DOMAIN)).toString("hex");
const EK = new Uint8Array(32).fill(7);

test("two people who have never spoken agree on a channel secret", () => {
  // The property that was missing. `conversation.test.ts` used to hand bob alice's secret
  // because nothing could establish one, and every guarantee in that file was conditional on a
  // step nobody had written.
  const a = initiate(alice, bundleFor(bob, 0, 3));
  const b = respond(bob, a.message);
  assert.equal(key(a.channel), key(b.channel));
  assert.equal(a.channel.domain, VAULT_DOMAIN);
  // And bob was never online for it: everything alice used is in the published bundle.
  assert.equal(a.agreed.usedOneTimePrekey, true);
  assert.equal(b.agreed.usedOneTimePrekey, true);
});

test("each of the four Diffie-Hellmans is load-bearing", () => {
  // Not "the code has four DH calls" — that is a source check and it would pass if one of them
  // used the wrong key. Each INPUT is varied in turn and the agreed secret must move. A DH that
  // was dropped or duplicated stops one of these mattering.
  const base = initiate(alice, bundleFor(bob, 0, 3), { ephemeralSeed: EK });

  // DH1 = DH(IK_a, SPK_b): alice's identity. Drop it and anyone can impersonate her.
  const otherAlice = initiate(rootOf(11, "not-alice"), bundleFor(bob, 0, 3), { ephemeralSeed: EK });
  assert.notEqual(key(base.channel), key(otherAlice.channel));
  assert.notDeepEqual(base.agreed.secret, otherAlice.agreed.secret);

  // DH2 = DH(EK_a, IK_b): bob's identity. Drop it and the handshake authenticates nobody.
  const otherBob = initiate(alice, bundleFor(rootOf(12, "not-bob"), 0, 3), { ephemeralSeed: EK });
  assert.notDeepEqual(base.agreed.secret, otherBob.agreed.secret);

  // DH3 = DH(EK_a, SPK_b): the rotating prekey. Drop it and rotation buys nothing.
  const nextEpoch = initiate(alice, bundleFor(bob, 1, 3), { ephemeralSeed: EK });
  assert.notDeepEqual(base.agreed.secret, nextEpoch.agreed.secret);

  // DH4 = DH(EK_a, OPK_b): the one-time key. Drop it and a replayed first message succeeds.
  const otherOtp = initiate(alice, bundleFor(bob, 0, 4), { ephemeralSeed: EK });
  assert.notDeepEqual(base.agreed.secret, otherOtp.agreed.secret);

  // And the ephemeral, which is what makes two conversations between the same pair distinct.
  const otherEk = initiate(alice, bundleFor(bob, 0, 3), { ephemeralSeed: new Uint8Array(32).fill(8) });
  assert.notDeepEqual(base.agreed.secret, otherEk.agreed.secret);
  assert.notEqual(key(base.channel), key(otherEk.channel));
});

test("a recipient with no one-time keys left is still reachable, and it is on the record", () => {
  // Exhaustion must degrade, not fail: a bundle with no one-time prekey is what a popular
  // recipient publishes most of the time. What is lost is replay resistance and nothing else,
  // and `usedOneTimePrekey` is on the return type so a caller can say so rather than infer it.
  const a = initiate(alice, bundleFor(bob, 0));
  const b = respond(bob, a.message);
  assert.equal(key(a.channel), key(b.channel));
  assert.equal(a.agreed.usedOneTimePrekey, false);
  assert.equal(b.agreed.usedOneTimePrekey, false);
  assert.equal(a.message.oneTimeIndex, null);
});

test("nobody without the recipient's root can complete it", () => {
  // Everything alice sends is public except the wrap, and the wrap opens only under a key that
  // requires bob's private prekeys. GCM's tag is what turns "wrong key" into a refusal.
  const a = initiate(alice, bundleFor(bob, 0, 3));
  assert.throws(() => respond(mallory, a.message), /unable to authenticate|bad decrypt/i);
  // Including someone holding the whole published bundle, which is the realistic attacker.
  const bundle = bundleFor(bob, 0, 3);
  assert.ok(bundle.identityKey.length === 32 && bundle.signedPrekey.length === 32);
  assert.throws(() => respond(mallory, initiate(alice, bundle).message),
    /unable to authenticate|bad decrypt/i);
});

test("a tampered prekey message fails rather than agreeing on something else", () => {
  const a = initiate(alice, bundleFor(bob, 0, 3));
  const mutate = (m: PrekeyMessage, field: "identityKey" | "ephemeralKey" | "wrapped"): PrekeyMessage => {
    const copy = new Uint8Array(m[field]);
    copy[0] ^= 0xff;
    return { ...m, [field]: copy };
  };
  for (const field of ["identityKey", "ephemeralKey", "wrapped"] as const) {
    assert.throws(() => respond(bob, mutate(a.message, field)),
      /unable to authenticate|bad decrypt/i, `${field} could be altered undetected`);
  }
  // A message pointing at the wrong epoch is a different signed prekey, so it also fails —
  // which is what makes rotation safe rather than merely tidy.
  assert.throws(() => respond(bob, { ...a.message, epoch: 1 }), /unable to authenticate|bad decrypt/i);
});

test("a bundle whose signature does not cover its own identity is refused", () => {
  // The directory attack. A vault or chain record that serves bundles can try to move a real,
  // validly-signed prekey under a different identity key — the signature verifies, and the
  // conversation is with the wrong person. Binding the identity key into the signed statement
  // is what stops it, so the check is that this specific swap fails.
  const good = bundleFor(bob, 0, 3);
  assert.doesNotThrow(() => verifyBundle(good));

  const swappedIdentity = { ...good, identityKey: rawPublic(identityDh(mallory)) };
  assert.throws(() => verifyBundle(swappedIdentity), /does not verify/);
  assert.throws(() => initiate(alice, swappedIdentity), /does not verify/);

  const swappedPrekey = { ...good, signedPrekey: rawPublic(signedPrekey(mallory, 0)) };
  assert.throws(() => verifyBundle(swappedPrekey), /does not verify/);

  // Mallory's own signature over the substituted values does not help either: the signing key
  // is in the bundle, so a bundle that verifies under mallory's key IS mallory's bundle.
  const mine = bundleFor(mallory, 0, 3);
  assert.doesNotThrow(() => verifyBundle(mine));
  assert.notDeepEqual(mine.identityKey, good.identityKey);

  // A malformed bundle is refused before any DH runs, not after.
  assert.throws(() => verifyBundle({ ...good, identityKey: new Uint8Array(31) }), /not 32 bytes/);
  assert.throws(() => verifyBundle({ ...good, signedPrekeySignature: new Uint8Array(64) }),
    /does not verify/);
});

test("replaying a prekey message is detectable, and detecting it is the caller's job", () => {
  // Deliberately NOT enforced inside `respond`. Consumption is state; `respond` is arithmetic.
  // A one-time prekey tracked inside this module would be tracked per process, so a second
  // instance of the client — a phone and a laptop — would each happily accept the same replay.
  const a = initiate(alice, bundleFor(bob, 0, 3));
  const first = respond(bob, a.message);
  const second = respond(bob, a.message);
  assert.equal(key(first.channel), key(second.channel), "a replay produces the same channel");
  // What the module owes a caller is the index, so refusing a repeat is possible at all.
  assert.equal(first.oneTimeIndex, 3);
  assert.equal(second.oneTimeIndex, 3);
  const consumed = new Set<number>([first.oneTimeIndex!]);
  assert.ok(consumed.has(second.oneTimeIndex!), "a caller cannot tell it has seen this one");
});

test("bundles regenerate from the root, so there is no private key at rest", () => {
  // The operational half of the derived-not-stored choice: nothing to lose, leak, or fail to
  // erase, and a recipient can republish from a backup of one seed.
  assert.deepEqual(bundleFor(bob, 0, 3), bundleFor(bob, 0, 3));
  assert.notDeepEqual(bundleFor(bob, 0, 3).signedPrekey, bundleFor(bob, 1, 3).signedPrekey);
  assert.notDeepEqual(bundleFor(bob, 0, 3).oneTimePrekey, bundleFor(bob, 0, 4).oneTimePrekey);
  // Every role has its own label, or one key would be doing two jobs.
  const labels = [LABELS.identityDh, LABELS.identitySign, LABELS.signedPrekey(0), LABELS.oneTimePrekey(0)];
  assert.equal(new Set(labels).size, labels.length);
  // And the identity DH key is not the signing key, which a single label would have made true.
  assert.notDeepEqual(bundleFor(bob, 0).identityKey, bundleFor(bob, 0).signingKey);
});

test("FIXED: a rotated epoch cannot be reopened, even holding the root", () => {
  // The correction to the test below. Prekeys used to be derived, so `signedPrekey(root, 0)`
  // regenerated forever and rotation had nothing to delete; the measurement under it is what
  // that cost. `prekeys.ts` mints them from randomness and destroys them, so the root alone is
  // no longer enough.
  const store = createStore();
  mintOneTime(store, 2);
  const bundle = bundleFrom(bob, store, 0);
  const opening = initiate(alice, bundle);

  // Answerable now.
  const before = respondWith(bob, store, opening.message);
  assert.equal(key(before.channel), key(opening.channel));

  // Rotate, and the same message is dead — with the root in hand, and the transcript in hand.
  const fresh = createStore();
  mintOneTime(fresh, 2);
  const again = initiate(alice, bundleFrom(bob, fresh, 0));
  rotate(fresh);
  assert.throws(() => respondWith(bob, fresh, again.message), /no private key left for epoch 0/);
});

test("a one-time prekey is spent, so a replayed first message dies", () => {
  // Replay resistance moves from "the caller should track it" to "the key is gone". `respond`
  // deliberately left this to the caller because consumption is state; the store IS that state,
  // so the module that owns it can enforce it.
  const store = createStore();
  mintOneTime(store, 1);
  const opening = initiate(alice, bundleFrom(bob, store, 0));
  assert.equal(key(respondWith(bob, store, opening.message).channel), key(opening.channel));
  assert.throws(() => respondWith(bob, store, opening.message), /one-time 0/);
});

test("the identity keys are NOT deleted, because they are the identity", () => {
  // The split that makes the rest workable. Rotating a prekey is routine; erasing the identity
  // would mean nobody could ever reach you again under the name they know.
  const store = createStore();
  const first = bundleFrom(bob, store, undefined);
  rotate(store);
  const second = bundleFrom(bob, store, undefined);
  assert.deepEqual(second.identityKey, first.identityKey);
  assert.deepEqual(second.signingKey, first.signingKey);
  assert.notDeepEqual(second.signedPrekey, first.signedPrekey);
  assert.equal(second.epoch, first.epoch + 1);
  // And a rotated bundle still verifies, so contacts can keep using the published identity.
  assert.doesNotThrow(() => verifyBundle(second));
});

test("THE COST it replaced: with DERIVED prekeys, root compromise opened everything", () => {
  // Kept as the measurement that forced `prekeys.ts` into existence, and still true of the
  // DERIVED path this exercises: `signedPrekey(root, 0)` regenerates for as long as the root
  // exists, so there is nothing to delete. Production no longer uses it.
  //
  // Measured, not argued: an adversary who obtains bob's vault root long after the fact, plus
  // the prekey messages the vault operator saw go past, recovers every channel secret.
  const transcript = [0, 1, 2].map((epoch) => initiate(alice, bundleFor(bob, epoch, epoch)).message);
  const recovered = transcript.map((m) => key(respond(bob, m).channel));
  assert.equal(new Set(recovered).size, 3, "the transcript should hold three distinct channels");
  // Rotating far past those epochs changes nothing, which is the point: rotation without
  // deletion is bookkeeping.
  for (const [i, m] of transcript.entries()) {
    assert.equal(key(respond(bob, m).channel), recovered[i]);
  }
  // What IS still protected: the ephemeral is random and never derived, so alice's root does
  // not open bob's side, and no root at all recovers a session whose prekey message was never
  // recorded — the wrap is the only copy of the channel material.
  assert.throws(() => respond(alice, transcript[0]), /unable to authenticate|bad decrypt/i);
});

test("no pool material can reach the handshake, transitively or by hand", () => {
  // I1 at the boundary that matters most. The decision was that key agreement is independent of
  // the pool; the check is that the package cannot even see pool material.
  const src = readFileSync(join(HANDSHAKE_SRC, "keys.ts"), "utf8")
    + readFileSync(join(HANDSHAKE_SRC, "x3dh.ts"), "utf8");
  assert.ok(!/POOL_DOMAIN|adoptPoolKey|SANDBOX_DOMAIN/.test(src),
    "the handshake package references pool or sandbox material");
  // Every entry point is typed to the vault domain, so the check above is belt and braces
  // rather than the guarantee. The guarantee is the fixture below.
  assert.ok(/Secret<typeof VAULT_DOMAIN>/.test(src));
});

test("none of the eight cross-domain handshake routes compiles", () => {
  const tsc = [join(HERE, "..", "node_modules", ".bin", "tsc"),
    join(HERE, "..", "..", "identity", "node_modules", ".bin", "tsc")].find(existsSync);
  // A missing type-checker is a FAILURE, not a skip.
  assert.ok(tsc, "no tsc — run `npm i -D typescript` in hydra-dapp/packages/identity");

  let out = "";
  try {
    execFileSync(tsc, ["--noEmit", "-p", join(HERE, "..", "tsconfig.json")], { encoding: "utf8" });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const { uncovered, orphans, routes } = uncoveredRoutes(out, "x3dh-must-not-compile", join(HERE, "x3dh-must-not-compile.ts"));
  assert.ok(routes.length >= 8, `only ${routes.length} numbered routes in the fixture`);
  // EVERY ROUTE INDIVIDUALLY, through the shared reader — see `adversary/src/must-not-compile.ts`
  // for why a total cannot say which route was rejected, and for how this exact check was got
  // wrong twice before.
  assert.deepEqual(uncovered.map((r) => r.label), [],
    `these routes COMPILE:\n`
    + `${uncovered.map((r) => `  route ${r.label} ($x3dh-must-not-compile.ts:${r.from}-${r.to - 1})`).join("\n")}`
    + `\n\nfull tsc output:\n${out}`);
  assert.deepEqual(orphans, [],
    `type errors in the fixture outside any numbered route: lines ${orphans.join(", ")}`);
});
