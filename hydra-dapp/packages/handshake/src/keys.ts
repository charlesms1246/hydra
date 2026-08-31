/**
 * X3DH key material, derived under the vault domain and nowhere near the pool.
 *
 * The decision this implements: **key agreement is an independent exchange, never derived from
 * pool material.** The pool can already establish channel context between two registered
 * viewing keys, and using it would have been less code — but the pool's channel is readable by
 * the auditor who holds the escrowed key (`identity/src/linkage.ts`), so deriving the vault
 * channel from it would hand the vault's contents to that auditor and collapse I1's separation
 * into a formality. The two domains stay separate all the way down or they are not separate.
 *
 * That is enforced by signature, not by care: every function here takes
 * `Secret<typeof VAULT_DOMAIN>`, so a pool secret is a compile error at the entry point.
 *
 * FOUR KEYS, and why they are four:
 *
 *   identity DH   (X25519)  long-term, the thing a fingerprint is of
 *   identity sign (Ed25519) long-term, signs prekeys so a swapped bundle is detectable
 *   signed prekey (X25519)  rotated by epoch; limits how far back a compromise reaches
 *   one-time key  (X25519)  used once; what makes a REPLAYED first message fail
 *
 * Signal uses one key for both roles via XEdDSA. Node's crypto does not implement XEdDSA and
 * writing it here would be inventing cryptography, which is the one thing this project does not
 * do — so the signing key is separate and the bundle carries both. The cost is one more 32-byte
 * value to publish and to fingerprint.
 *
 * IDENTITY IS DERIVED; PREKEYS ARE NOT, AND THAT CHANGED FOR A REASON. Deriving everything from
 * the root was operationally lovely — nothing to lose, nothing to erase, republish from a backup
 * of one seed — and it meant `signedPrekey(root, epoch)` regenerated forever, so rotation had
 * nothing to delete. Measured: a compromised root plus a recorded transcript recovered every
 * past channel secret. **Deleting a private is what forward secrecy is.**
 *
 * So prekeys are minted from randomness and kept in `prekeys.ts`, which destroys them on
 * rotation and on use. The derived `signedPrekey` and `oneTimePrekey` below remain for test
 * vectors and for the parity checks that need a deterministic bundle; production paths go
 * through the store. The identity keys stay derived, because they ARE the identity and erasing
 * them is not rotation.
 *
 * The initiator's ephemeral is random by definition: derived ephemerals are not ephemeral.
 */

import { createPrivateKey, createPublicKey, diffieHellman, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { subKey, expose, VAULT_DOMAIN } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

/** PKCS#8 wrappers for a raw 32-byte seed. Node has no API that takes the seed directly. */
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

export const KEY_BYTES = 32;

const privateFrom = (prefix: Buffer, seed: Uint8Array): KeyObject =>
  createPrivateKey({ key: Buffer.concat([prefix, Buffer.from(seed)]), format: "der", type: "pkcs8" });

/**
 * A key from raw bytes somebody else is keeping.
 *
 * `prekeys.ts` mints prekey privates from randomness and stores them so rotation can DELETE
 * them, which is what forward secrecy is. Deriving them from the root, as the functions below
 * still do for identity, leaves nothing to delete.
 */
export const privateFromSeed = (seed: Uint8Array, kind: "x25519" | "ed25519"): KeyObject => {
  if (seed.length !== KEY_BYTES) throw new Error(`a key seed is ${KEY_BYTES} bytes`);
  return privateFrom(kind === "x25519" ? X25519_PKCS8 : ED25519_PKCS8, seed);
};

/** The raw 32 bytes of a public key, which is what a bundle publishes. */
export function rawPublic(key: KeyObject): Uint8Array {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("key has no public component");
  return new Uint8Array(Buffer.from(jwk.x, "base64url"));
}

const publicFromRaw = (raw: Uint8Array, crv: "X25519" | "Ed25519"): KeyObject =>
  createPublicKey({
    key: { kty: "OKP", crv, x: Buffer.from(raw).toString("base64url") },
    format: "jwk",
  });

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * The labels. Listed together because their distinctness is the property that matters: two
 * roles sharing a label would be one key doing two jobs, and a signature over a prekey would
 * become a signature the identity key could be tricked into making about itself.
 */
export const LABELS = {
  identityDh: "x3dh/identity/dh",
  identitySign: "x3dh/identity/sign",
  signedPrekey: (epoch: number) => `x3dh/signed-prekey/${epoch}`,
  oneTimePrekey: (index: number) => `x3dh/one-time-prekey/${index}`,
} as const;

const keyFor = (root: Secret<typeof VAULT_DOMAIN>, label: string, prefix: Buffer): KeyObject =>
  privateFrom(prefix, expose(subKey(root, label), VAULT_DOMAIN));

export const identityDh = (root: Secret<typeof VAULT_DOMAIN>): KeyObject =>
  keyFor(root, LABELS.identityDh, X25519_PKCS8);

export const identitySign = (root: Secret<typeof VAULT_DOMAIN>): KeyObject =>
  keyFor(root, LABELS.identitySign, ED25519_PKCS8);

export const signedPrekey = (root: Secret<typeof VAULT_DOMAIN>, epoch: number): KeyObject =>
  keyFor(root, LABELS.signedPrekey(epoch), X25519_PKCS8);

export const oneTimePrekey = (root: Secret<typeof VAULT_DOMAIN>, index: number): KeyObject =>
  keyFor(root, LABELS.oneTimePrekey(index), X25519_PKCS8);

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

/**
 * What a recipient publishes so anyone can start a conversation with them while they are
 * offline. Public values only — every field here is meant to be read by strangers.
 *
 * `identityKey` and `signingKey` go in the Starknet ID record (long-term, one place, and a
 * record whose ownership is already provable). One-time prekeys do not: there are many, they
 * are consumed, and putting a consumable in a chain record means paying to consume it. They go
 * in the vault.
 */
export type Bundle = {
  readonly identityKey: Uint8Array;
  readonly signingKey: Uint8Array;
  readonly signedPrekey: Uint8Array;
  readonly signedPrekeySignature: Uint8Array;
  readonly epoch: number;
  /** Absent when the recipient's one-time keys are exhausted. See `initiate`. */
  readonly oneTimePrekey?: Uint8Array;
  readonly oneTimeIndex?: number;
};

/**
 * What gets signed: the prekey, its epoch, and the identity it belongs to.
 *
 * The identity key is inside the signed region on purpose. Signing the prekey alone would let
 * a directory move a real signed prekey under a different identity key and have it verify —
 * the signature would be valid and about the wrong person.
 */
export function prekeyStatement(identityKey: Uint8Array, prekey: Uint8Array, epoch: number): Buffer {
  return Buffer.concat([
    Buffer.from("hydra/x3dh/signed-prekey "),
    Buffer.from(identityKey),
    Buffer.from(prekey),
    Buffer.from(new Uint32Array([epoch]).buffer),
  ]);
}

export function bundleFor(
  root: Secret<typeof VAULT_DOMAIN>,
  epoch: number,
  oneTimeIndex?: number,
): Bundle {
  const identityKey = rawPublic(identityDh(root));
  const prekey = rawPublic(signedPrekey(root, epoch));
  return {
    identityKey,
    signingKey: rawPublic(identitySign(root)),
    signedPrekey: prekey,
    signedPrekeySignature: new Uint8Array(
      sign(null, prekeyStatement(identityKey, prekey, epoch), identitySign(root))),
    epoch,
    ...(oneTimeIndex === undefined ? {} : {
      oneTimePrekey: rawPublic(oneTimePrekey(root, oneTimeIndex)),
      oneTimeIndex,
    }),
  };
}

/**
 * Check a bundle before using it, and throw rather than return false.
 *
 * A bundle arrives from a directory — a chain record, a vault, a QR code — and the whole
 * question X3DH answers is whether the person on the other end is who the directory says. A
 * caller who forgets to check has no protection at all, so `initiate` calls this itself and
 * there is no path that skips it.
 *
 * What this does NOT establish is that the identity key is the right person's. That is a
 * trust-on-first-use or fingerprint question and no signature can settle it.
 */
export function verifyBundle(bundle: Bundle): void {
  const fields = [
    ["identityKey", bundle.identityKey],
    ["signingKey", bundle.signingKey],
    ["signedPrekey", bundle.signedPrekey],
  ] as const;
  for (const [name, v] of fields) {
    if (v?.length !== KEY_BYTES) throw new Error(`bundle ${name} is not ${KEY_BYTES} bytes`);
  }
  if (bundle.oneTimePrekey && bundle.oneTimePrekey.length !== KEY_BYTES) {
    throw new Error("bundle oneTimePrekey is not 32 bytes");
  }
  const ok = verify(
    null,
    prekeyStatement(bundle.identityKey, bundle.signedPrekey, bundle.epoch),
    publicFromRaw(bundle.signingKey, "Ed25519"),
    bundle.signedPrekeySignature,
  );
  if (!ok) throw new Error("bundle signed prekey does not verify under its own signing key");
}

// ---------------------------------------------------------------------------
// Diffie-Hellman
// ---------------------------------------------------------------------------

/** One DH, taking the peer's key as the raw bytes a bundle carries. */
export function dh(mine: KeyObject, theirs: Uint8Array): Uint8Array {
  return new Uint8Array(diffieHellman({
    privateKey: mine,
    publicKey: publicFromRaw(theirs, "X25519"),
  }));
}

/** An initiator's ephemeral key. Random, never derived — see the header. */
export function ephemeral(seed: Uint8Array): KeyObject {
  if (seed.length !== KEY_BYTES) throw new Error("an ephemeral seed must be 32 bytes");
  return privateFrom(X25519_PKCS8, seed);
}
