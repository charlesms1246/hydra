/**
 * The on-chain pointer — invariant I3.
 *
 * The chain publishes timestamped events. The vault sees timestamped uploads. If the value
 * published on chain is the blob id, the two timelines join on that value and the vault
 * operator maps every blob to a channel while holding no key and decrypting nothing. So the
 * pointer carries `blob_id` masked under a channel-scoped, per-message pad
 * (`claude-docs/HYDRA_HANDOFF.md` I3: "carry `enc(channel_key, blob_id)` or a channel-scoped
 * KDF derivation").
 *
 * WHICH channel key, and this is the part that is easy to get wrong. Not the pool's. The pool
 * derives channel keys from the viewing key it escrows to the auditor
 * (`.upstream/packages/privacy/src/privacy.cairo:331-350`), so a pointer masked under a pool
 * channel key is readable by the auditor — which would hand exactly the blob-to-channel map
 * I3 exists to prevent to the one party guaranteed to have it. The pad comes from the VAULT
 * domain, via `subKey`, which cannot cross domains because it takes no domain argument.
 *
 * WHAT THIS BUYS, AND WHAT IT DOES NOT. It closes the value join completely and the timing
 * join not at all. An operator that ignores these bytes and matches each pointer to the
 * nearest upload in time succeeds on every pair when the client uploads as it publishes. Only
 * jitter wider than the block interval closes that, and the test in
 * `packages/adversary/test/i3-timeline-join.test.ts` asserts both halves — including that the
 * undefended case succeeds, so the gap is recorded rather than implied.
 */

import { createHash } from "node:crypto";
import { VAULT_DOMAIN, expose, requireDomain, subKey } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

/**
 * 31 bytes, not 32.
 *
 * A Starknet felt holds 251 bits, so 31 bytes (248) is the largest value that always fits in
 * one. A 32-byte id would need two felts on chain or a reduction that is not injective, and
 * "usually fits" is the kind of property that fails in production on the one input that
 * matters. Truncating SHA-256 to 248 bits leaves 124-bit collision resistance, which is the
 * cost of the choice and is worth stating rather than discovering.
 */
export const ID_BYTES = 31;

/** Content addressing: the id of a blob is a hash of the bytes the vault will store. */
export function blobIdFrom(ciphertext: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(ciphertext).digest()).slice(0, ID_BYTES);
}

/**
 * The vault-domain secret for one channel.
 *
 * `subKey` carries the domain with it and takes no domain argument, so there is no way to
 * reach here from a pool secret — the type rejects it and `requireDomain` rejects it again
 * for call sites that arrived through an `as any`.
 */
export function channelSecret(
  vaultRoot: Secret<typeof VAULT_DOMAIN>,
  channelId: string,
): Secret<typeof VAULT_DOMAIN> {
  return subKey(requireDomain(vaultRoot, VAULT_DOMAIN), `channel ${channelId}`);
}

/**
 * The one-time pad for message `seq` in this channel.
 *
 * Keyed by sequence number so a resent blob does not publish a repeated pointer: the same
 * content at two positions must look unrelated on chain, or a repeat is visible to anyone.
 */
function pad(channel: Secret<typeof VAULT_DOMAIN>, seq: number): Uint8Array {
  return expose(subKey(channel, `pointer ${seq}`), VAULT_DOMAIN).slice(0, ID_BYTES);
}

const xor = (a: Uint8Array, b: Uint8Array): Uint8Array =>
  Uint8Array.from(a, (byte, i) => byte ^ b[i]);

/** The value published on chain: the blob id, masked. */
export function pointerFor(
  channel: Secret<typeof VAULT_DOMAIN>,
  blobId: Uint8Array,
  seq: number,
): Uint8Array {
  if (blobId.length !== ID_BYTES) throw new Error(`blob id must be ${ID_BYTES} bytes`);
  return xor(blobId, pad(channel, seq));
}

/**
 * Recover the blob id from a pointer. The inverse of {@link pointerFor}, and the reason the
 * pointer is a mask rather than a hash: the recipient has to reach the message.
 *
 * A mask gives confidentiality and NO integrity. The wrong channel secret does not throw — it
 * returns a well-formed id that is not in the vault, and the caller sees a miss rather than an
 * error. Anything relying on this to authenticate a message is relying on the wrong thing;
 * that job belongs to the content commitment bound into the note.
 */
export function recoverBlobId(
  channel: Secret<typeof VAULT_DOMAIN>,
  pointer: Uint8Array,
  seq: number,
): Uint8Array {
  if (pointer.length !== ID_BYTES) throw new Error(`pointer must be ${ID_BYTES} bytes`);
  return xor(pointer, pad(channel, seq));
}
