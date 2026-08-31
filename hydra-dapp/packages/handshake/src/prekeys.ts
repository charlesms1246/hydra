/**
 * Prekey privates that are stored, and then deleted.
 *
 * `keys.ts` derived every prekey from the vault root — nothing to lose, nothing to leak, a
 * recipient republishing from a backup of one seed. It also meant `signedPrekey(root, epoch)`
 * regenerated forever, so rotation had nothing to delete, and `x3dh.test.ts` measured the
 * consequence: **a compromised root plus a recorded transcript recovered every past channel
 * secret.** Rotation without deletion is bookkeeping.
 *
 * Deleting a private is what forward secrecy IS. So prekeys are minted from randomness, kept
 * here, and dropped when their epoch rotates or their one-time key is used. The identity keys
 * stay derived from the root: they are the identity, and erasing them is not rotation but
 * suicide.
 *
 * WHAT "DELETED" HONESTLY MEANS, because this is JavaScript and the word is doing less work
 * than it sounds like:
 *
 *   - The value is removed from this object and from whatever the caller persists.
 *   - The bytes are overwritten in the one buffer this module holds.
 *   - JavaScript strings are immutable and the collector copies, so any hex the value passed
 *     through may survive in memory until the process exits.
 *   - The old contents of a state file may survive on the device until something overwrites
 *     the blocks — the same `fs.deletedResidue` problem the vault's disclosure table already
 *     names, applied to the client.
 *
 * Real erasure needs guarantees this runtime does not offer. What this buys is that a root
 * compromise no longer recovers a rotated epoch, which is the attack that was measured.
 *
 * THE COST, and it is a real one: a prekey message built against an epoch you have rotated past
 * can no longer be answered. Somebody who fetched your bundle, wrote to your mailbox, and waited
 * too long gets silence. That is forward secrecy working, and it is indistinguishable from a
 * bug unless the client says so.
 */

import { randomBytes } from "node:crypto";
import { rawPublic, prekeyStatement, identityDh, identitySign, privateFromSeed, KEY_BYTES }
  from "./keys.ts";
import type { Bundle } from "./keys.ts";
import { sign } from "node:crypto";
import { VAULT_DOMAIN } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

/** Serialisable, because a client has to survive being restarted. Hex, one entry per key. */
export type PrekeyStore = {
  epoch: number;
  /** epoch → private seed. Exactly one live entry after a rotation. */
  signed: Record<string, string>;
  /** index → private seed. Removed on use. */
  oneTime: Record<string, string>;
  nextOneTime: number;
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

/** A fresh store with one signed prekey and no one-time keys. */
export function createStore(random: (n: number) => Uint8Array = randomBytes): PrekeyStore {
  return {
    epoch: 0,
    signed: { 0: hex(random(KEY_BYTES)) },
    oneTime: {},
    nextOneTime: 0,
  };
}

/**
 * Overwrite and remove.
 *
 * The overwrite is of the array this function builds, not of the string in the object — see the
 * header. It is done anyway because the alternative is deleting a property and calling it
 * erasure, and the difference between those two is exactly what a reader of this file needs to
 * be able to see.
 */
function drop(table: Record<string, string>, key: string): Uint8Array | null {
  const value = table[key];
  if (value === undefined) return null;
  const bytes = unhex(value);
  const copy = Uint8Array.from(bytes);
  bytes.fill(0);
  delete table[key];
  return copy;
}

/**
 * Rotate to a new epoch, deleting the old private.
 *
 * Returns the epoch that was destroyed, so a caller can say what it just made unanswerable.
 */
export function rotate(store: PrekeyStore, random: (n: number) => Uint8Array = randomBytes): number {
  const gone = store.epoch;
  drop(store.signed, String(gone));
  store.epoch = gone + 1;
  store.signed[String(store.epoch)] = hex(random(KEY_BYTES));
  return gone;
}

/** Mint one-time prekeys. Returns the indices, which go into published bundles. */
export function mintOneTime(
  store: PrekeyStore,
  count: number,
  random: (n: number) => Uint8Array = randomBytes,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const index = store.nextOneTime++;
    store.oneTime[String(index)] = hex(random(KEY_BYTES));
    out.push(index);
  }
  return out;
}

/** How many one-time keys are still available. A bundle without one loses replay resistance. */
export const oneTimeRemaining = (store: PrekeyStore): number => Object.keys(store.oneTime).length;

/** The private halves, for `respond`. `oneTime` is CONSUMED — asking twice returns null. */
export function take(
  store: PrekeyStore,
  epoch: number,
  oneTimeIndex: number | null,
): { signed: Uint8Array; oneTime: Uint8Array | null } | null {
  const signed = store.signed[String(epoch)];
  if (signed === undefined) return null;
  const oneTime = oneTimeIndex === null ? null : drop(store.oneTime, String(oneTimeIndex));
  if (oneTimeIndex !== null && oneTime === null) return null;
  return { signed: unhex(signed), oneTime };
}

/**
 * A publishable bundle: identity keys from the root, prekeys from the store.
 *
 * The split is the point. Identity is long-term and derived, so it survives a lost device that
 * still has the seed; prekeys are short-term and stored, so rotation can destroy them.
 */
export function bundleFrom(
  root: Secret<typeof VAULT_DOMAIN>,
  store: PrekeyStore,
  oneTimeIndex?: number,
): Bundle {
  const seed = store.signed[String(store.epoch)];
  if (seed === undefined) throw new Error(`no private for epoch ${store.epoch} — the store is broken`);
  const identityKey = rawPublic(identityDh(root));
  const prekey = rawPublic(privateFromSeed(unhex(seed), "x25519"));
  const bundle: Bundle = {
    identityKey,
    signingKey: rawPublic(identitySign(root)),
    signedPrekey: prekey,
    signedPrekeySignature: new Uint8Array(
      sign(null, prekeyStatement(identityKey, prekey, store.epoch), identitySign(root))),
    epoch: store.epoch,
    ...(oneTimeIndex === undefined ? {} : {
      oneTimePrekey: rawPublic(privateFromSeed(unhex(
        store.oneTime[String(oneTimeIndex)]
          ?? (() => { throw new Error(`one-time prekey ${oneTimeIndex} does not exist`); })()),
        "x25519")),
      oneTimeIndex,
    }),
  };
  return bundle;
}
