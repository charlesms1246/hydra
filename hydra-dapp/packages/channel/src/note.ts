/**
 * What a message puts on chain — invariant I4.
 *
 * `HYDRA_HANDOFF.md` I4: payloads are never stored as pool notes; the pool carries pointers
 * and commitments only. Two felts, fixed, whatever the message is.
 *
 * The pool does not emit our calldata — `ExternalContractInvoked` carries the contract address
 * and selector and states that calldata is not emitted
 * (`.upstream/packages/privacy/src/events.cairo:82-90`). So the route to chain is the pool
 * invoking an external contract at `selector!("privacy_invoke")`
 * (`.upstream/packages/privacy/src/utils.cairo:84`, dispatched at `privacy.cairo:878-886`),
 * and that contract emitting what it was given. Ours is `contracts/src/channel.cairo`.
 *
 * I4 is enforced by that contract's signature rather than by a size check here. Its entrypoint
 * takes two felts: no array, no span, nothing with a length. A payload cannot be too large if
 * there is nowhere to put it, and there is no branch anyone has to remember to review.
 */

import { P } from "./commitment.ts";
import { ID_BYTES } from "./pointer.ts";
import type { Pointer } from "./pointer.ts";
import { VAULT_DOMAIN } from "../../identity/src/domains.ts";

/** Two. The whole on-chain footprint of a message. */
export const NOTE_FELTS = 2;

/**
 * A 31-byte pointer as a felt.
 *
 * `pointer.ts` chose 31 bytes precisely so this is total: 248 bits always fits the 251-bit
 * field, with no reduction and no case where it does not.
 */
export function pointerToFelt(pointer: Uint8Array): bigint {
  if (pointer.length !== ID_BYTES) throw new Error(`pointer must be ${ID_BYTES} bytes`);
  return pointer.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

/** The inverse, for a recipient reading the chain. */
export function feltToPointer(felt: bigint): Uint8Array {
  if (felt < 0n || felt >= P) throw new Error("pointer felt is not a field element");
  const out = new Uint8Array(ID_BYTES);
  let v = felt;
  for (let i = ID_BYTES - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("pointer felt does not fit 31 bytes");
  return out;
}

/**
 * The calldata for one message.
 *
 * Returns a fixed-length tuple rather than an array so a caller cannot append to it, and takes
 * no content argument at all — the content is in the vault, and the only thing that reaches
 * the chain is a masked reference to it plus a commitment to what it says.
 *
 * The pointer type is where I6 is enforced. It accepts `Pointer<VAULT_DOMAIN>` and nothing
 * else, so a pointer derived from sandbox material — disposable keys that must never touch the
 * chain — will not compile here. That is the "on-chain code paths refuse it" half of I6's
 * acceptance condition, and it costs one type parameter rather than a runtime check somebody
 * has to remember to call.
 */
export function noteCalldata(
  pointer: Pointer<typeof VAULT_DOMAIN>,
  commitment: bigint,
): readonly [bigint, bigint] {
  if (commitment < 0n || commitment >= P) throw new Error("commitment is not a field element");
  return [pointerToFelt(pointer), commitment] as const;
}
