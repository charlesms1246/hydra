/**
 * The bundle as a chain record, so a stranger can check a signature.
 *
 * `decisions/0026` closed the forgery hole by making authorship an Ed25519 signature over the
 * on-chain commitment. It left one thing open, and the note in `TODO.md` calls it load-bearing:
 * **a signature is only verifiable by somebody who holds your signing key**, and today that is
 * a counterparty who completed a handshake. Signing content nobody else can check is most of
 * the cost of signing it and none of the benefit.
 *
 * A record fixes that by putting the public half somewhere a stranger can find it. Which
 * immediately raises the question this module exists to answer:
 *
 * WHAT STOPS SOMEBODY PUBLISHING YOUR BUNDLE UNDER THEIR OWN NAME?
 *
 * Nothing about a bundle does. Every field in it is public by design — that is what publishing
 * means — so `verifyBundle` passes on a copy, because the copy is genuine. Bob writes Alice's
 * bundle into `bob.stark`, a stranger resolves `bob.stark`, checks a signature Alice made, and
 * is told bob wrote it. That is the *same forgery*, moved up one level: the attacker no longer
 * needs a shared secret, only the ability to copy public bytes.
 *
 * So the record carries a **second signature, over the address it is anchored to**. The prekey
 * signature binds the prekey to the identity; this one binds the identity to a place. Copying
 * the record moves it to an address its signature does not name, and `verifyRecord` refuses it.
 * That is `record.test.ts`'s first assertion and the reason this file is not just `bundleFrom`
 * plus a hex encoder.
 *
 * The two signatures are separate on purpose rather than one statement covering everything: a
 * bundle is also published in the vault, over a QR code and in a file, where there is no
 * address to bind to. Extending `prekeyStatement` would make every one of those paths carry a
 * field they cannot fill.
 *
 * WHAT IS IN THE RECORD, and what is deliberately not:
 *
 *   identityKey    long-term, X25519 — the thing a fingerprint is of
 *   signingKey     long-term, Ed25519 — what makes signed content checkable, the whole point
 *   signedPrekey   rotated by epoch
 *   epoch          so a reader can tell a stale record from a current one
 *   two signatures the prekey's, and this record's own over the anchor
 *
 * ONE-TIME PREKEYS ARE NOT HERE. They are consumable, there are many, and a chain record is a
 * storage write per felt — putting a consumable in one means paying to consume it. They stay in
 * the vault, where `inbox.ts` already reaches them.
 *
 * WHAT A RECORD DISCLOSES, said here and computed in `identity/src/linkage.ts`: it names your
 * messaging identity and a Starknet address **in one place, forever, to everybody**. That is
 * the point — an anchor nobody can read is not an anchor — and it is also the exact link
 * `decisions/0002` spent a harness proving a fresh identity does not have. Publishing is
 * therefore a decision with a cost, not a setup step, and both front ends say so before they
 * do it. See `decisions/0027`.
 */

import { sign, verify } from "node:crypto";
import { identitySign, publicFromRaw, verifyBundle, KEY_BYTES } from "./keys.ts";
import type { Bundle } from "./keys.ts";
import { bundleFrom } from "./prekeys.ts";
import type { PrekeyStore } from "./prekeys.ts";
import { VAULT_DOMAIN } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

export const SIGNATURE_BYTES = 64;

/**
 * Bumped when the byte layout changes, and checked on the way in.
 *
 * A record is read by software that did not write it, possibly years later, from a place that
 * cannot be edited retroactively. A version byte is the difference between "this is a v2
 * record I cannot read" and a v2 record decoded as a v1 one, which produces keys rather than
 * an error.
 */
export const RECORD_VERSION = 1;

/**
 * A record's fixed size in bytes.
 *
 * Fixed, so nothing needs a length prefix and a truncated record is refused by arithmetic
 * rather than by a check somebody has to remember to write.
 */
export const RECORD_BYTES = 1 + 4 + KEY_BYTES * 3 + SIGNATURE_BYTES * 2;

/**
 * Bytes per felt.
 *
 * 31 rather than 32: a felt252 is smaller than the Starknet prime, and 32 arbitrary bytes can
 * exceed it. Chunking at 31 makes every chunk a valid felt by construction, which is the only
 * form of this that cannot fail on an unlucky key.
 */
export const FELT_BYTES = 31;

export const RECORD_FELTS = Math.ceil(RECORD_BYTES / FELT_BYTES);

/** Everything a record holds. `oneTimePrekey` is absent by design — see the header. */
export type BundleRecord = {
  readonly identityKey: Uint8Array;
  readonly signingKey: Uint8Array;
  readonly signedPrekey: Uint8Array;
  readonly signedPrekeySignature: Uint8Array;
  readonly epoch: number;
  /** Over `anchorStatement`. What stops the record being copied to another name. */
  readonly anchorSignature: Uint8Array;
};

/**
 * What the anchor signature covers.
 *
 * The address is first and the domain string is fixed, so this cannot collide with
 * `prekeyStatement` — two Ed25519 signatures made by one key over overlapping fields is how a
 * signature for one purpose gets replayed as a signature for another.
 */
export function anchorStatement(owner: bigint, record: Omit<BundleRecord, "anchorSignature">): Buffer {
  if (owner <= 0n) throw new Error("an anchor address must be a positive felt");
  return Buffer.concat([
    Buffer.from("hydra/starknet-id/record/v1 "),
    Buffer.from(owner.toString(16).padStart(64, "0"), "hex"),
    Buffer.from(record.identityKey),
    Buffer.from(record.signingKey),
    Buffer.from(record.signedPrekey),
    Buffer.from(new Uint32Array([record.epoch]).buffer),
  ]);
}

/**
 * Build the record this identity would publish at `owner`.
 *
 * `owner` is an argument rather than something read from a wallet because the address is what
 * is being committed to: a function that guessed it would produce a record that verifies
 * nowhere, and the failure would appear at a stranger's client rather than here.
 */
export function recordFor(
  root: Secret<typeof VAULT_DOMAIN>,
  store: PrekeyStore,
  owner: bigint,
): BundleRecord {
  const bundle = bundleFrom(root, store);
  const body = {
    identityKey: bundle.identityKey,
    signingKey: bundle.signingKey,
    signedPrekey: bundle.signedPrekey,
    signedPrekeySignature: bundle.signedPrekeySignature,
    epoch: bundle.epoch,
  };
  return { ...body, anchorSignature: new Uint8Array(
    sign(null, anchorStatement(owner, body), identitySign(root))) };
}

/**
 * Check a record fetched from `owner`, and throw rather than return false.
 *
 * Both signatures, because they establish different things and either alone is insufficient:
 * `verifyBundle` says the prekey belongs to this identity, and the anchor says this identity
 * asked to be found at this address. A caller who skips the second accepts a copy.
 *
 * What this does NOT establish is that the address belongs to the person you mean. Starknet ID
 * resolves a name to an address and this resolves an address to keys; whether the human behind
 * `alice.stark` is your Alice is a question no signature answers.
 */
export function verifyRecord(record: BundleRecord, owner: bigint): void {
  const bundle: Bundle = {
    identityKey: record.identityKey,
    signingKey: record.signingKey,
    signedPrekey: record.signedPrekey,
    signedPrekeySignature: record.signedPrekeySignature,
    epoch: record.epoch,
  };
  verifyBundle(bundle);
  if (record.anchorSignature.length !== SIGNATURE_BYTES) {
    throw new Error(`a record anchor signature is ${SIGNATURE_BYTES} bytes`);
  }
  const ok = verify(
    null,
    anchorStatement(owner, record),
    publicFromRaw(record.signingKey, "Ed25519"),
    record.anchorSignature,
  );
  if (!ok) throw new Error(`record does not name ${`0x${owner.toString(16)}`} — it was published elsewhere`);
}

/** The bundle a verified record yields, for `initiate`. Never returned unverified. */
export function bundleOf(record: BundleRecord, owner: bigint): Bundle {
  verifyRecord(record, owner);
  return {
    identityKey: record.identityKey,
    signingKey: record.signingKey,
    signedPrekey: record.signedPrekey,
    signedPrekeySignature: record.signedPrekeySignature,
    epoch: record.epoch,
  };
}

// ---------------------------------------------------------------------------
// Felts
// ---------------------------------------------------------------------------

function bytesOf(record: BundleRecord): Uint8Array {
  const out = new Uint8Array(RECORD_BYTES);
  const view = new DataView(out.buffer);
  out[0] = RECORD_VERSION;
  view.setUint32(1, record.epoch, false);
  let at = 5;
  for (const field of [record.identityKey, record.signingKey, record.signedPrekey,
                       record.signedPrekeySignature, record.anchorSignature]) {
    out.set(field, at);
    at += field.length;
  }
  if (at !== RECORD_BYTES) throw new Error(`a record field is the wrong length: ${at} of ${RECORD_BYTES}`);
  return out;
}

/** The felts to write on chain. Fixed length, so a partial write is detectable. */
export function encodeRecord(record: BundleRecord): bigint[] {
  const bytes = bytesOf(record);
  const felts: bigint[] = [];
  for (let at = 0; at < RECORD_BYTES; at += FELT_BYTES) {
    const chunk = bytes.slice(at, Math.min(at + FELT_BYTES, RECORD_BYTES));
    felts.push(BigInt(`0x${Buffer.from(chunk).toString("hex")}`));
  }
  return felts;
}

/**
 * Read felts back into a record. Refuses anything it cannot account for exactly.
 *
 * A record comes off a chain, which anyone may write to, so every failure here is a real case
 * rather than defensive noise: a wrong count is a truncated or padded write, an oversized felt
 * is a value that did not come from `encodeRecord`, and a version byte this build does not know
 * is a record written by software newer than this one.
 */
export function decodeRecord(felts: readonly bigint[]): BundleRecord {
  if (felts.length !== RECORD_FELTS) {
    throw new Error(`a record is ${RECORD_FELTS} felts, got ${felts.length}`);
  }
  const bytes = new Uint8Array(RECORD_BYTES);
  for (const [i, felt] of felts.entries()) {
    const at = i * FELT_BYTES;
    const width = Math.min(FELT_BYTES, RECORD_BYTES - at);
    if (felt < 0n || felt >= 1n << BigInt(width * 8)) {
      throw new Error(`record felt ${i} does not fit in ${width} bytes`);
    }
    bytes.set(Buffer.from(felt.toString(16).padStart(width * 2, "0"), "hex"), at);
  }
  if (bytes[0] !== RECORD_VERSION) {
    throw new Error(`record version ${bytes[0]}, this client reads ${RECORD_VERSION}`);
  }
  const view = new DataView(bytes.buffer);
  const at = (n: number) => 5 + n;
  return {
    epoch: view.getUint32(1, false),
    identityKey: bytes.slice(at(0), at(KEY_BYTES)),
    signingKey: bytes.slice(at(KEY_BYTES), at(KEY_BYTES * 2)),
    signedPrekey: bytes.slice(at(KEY_BYTES * 2), at(KEY_BYTES * 3)),
    signedPrekeySignature: bytes.slice(at(KEY_BYTES * 3), at(KEY_BYTES * 3 + SIGNATURE_BYTES)),
    anchorSignature: bytes.slice(at(KEY_BYTES * 3 + SIGNATURE_BYTES), RECORD_BYTES),
  };
}
