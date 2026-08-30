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
import { SANDBOX_DOMAIN, VAULT_DOMAIN, expose, requireDomain, subKey } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

/**
 * Domains a channel may live in — invariant I6.
 *
 * The sandbox runs the same channel machinery on disposable keys, so it needs the same
 * functions. What it must never do is reach the chain, and that refusal lives on the pointer
 * rather than here: `Pointer<D>` remembers which domain produced it and `note.ts` accepts only
 * the real one.
 */
export type ChannelDomain = typeof VAULT_DOMAIN | typeof SANDBOX_DOMAIN;

declare const pointerBrand: unique symbol;

/**
 * A pointer, tagged with the domain of the channel that produced it.
 *
 * Branded rather than opaque, and the direction is what makes that safe. I1 needed opacity
 * because it was preventing key material from *escaping* into a `Uint8Array`. Here the job is
 * the reverse — restricting what may be passed *in* — and a plain `Uint8Array` is not
 * assignable to a branded one, so the brand is exactly the barrier required.
 */
export type Pointer<D extends ChannelDomain = ChannelDomain> =
  Uint8Array & { readonly [pointerBrand]: D };

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
export function channelSecret<D extends ChannelDomain>(
  root: Secret<D>,
  channelId: string,
): Secret<D> {
  return subKey(requireDomain(root, root.domain), `channel ${channelId}`) as Secret<D>;
}

/**
 * The one-time pad for message `seq` in this channel.
 *
 * Keyed by sequence number so a resent blob does not publish a repeated pointer: the same
 * content at two positions must look unrelated on chain, or a repeat is visible to anyone.
 */
function pad<D extends ChannelDomain>(channel: Secret<D>, seq: number): Uint8Array {
  return expose(subKey(channel, `pointer ${seq}`), channel.domain).slice(0, ID_BYTES);
}

const xor = (a: Uint8Array, b: Uint8Array): Uint8Array =>
  Uint8Array.from(a, (byte, i) => byte ^ b[i]);

/** The value published on chain: the blob id, masked. */
export function pointerFor<D extends ChannelDomain>(
  channel: Secret<D>,
  blobId: Uint8Array,
  seq: number,
): Pointer<D> {
  if (blobId.length !== ID_BYTES) throw new Error(`blob id must be ${ID_BYTES} bytes`);
  return xor(blobId, pad(channel, seq)) as Pointer<D>;
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
export function recoverBlobId<D extends ChannelDomain>(
  channel: Secret<D>,
  pointer: Uint8Array,
  seq: number,
): Uint8Array {
  if (pointer.length !== ID_BYTES) throw new Error(`pointer must be ${ID_BYTES} bytes`);
  return xor(pointer, pad(channel, seq));
}
