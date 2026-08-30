/**
 * The authorship commitment, client side.
 *
 * `contracts/src/commitment.cairo` is the authority. This recomputes the same value off-chain
 * so a client can bind a commitment into a note before sending it — `HYDRA_HANDOFF.md` Phase 2
 * asks for one in every note, so that authorship of specific content stays provable after the
 * payload expires, and Phase 5 proves knowledge of the nullifier preimage against it.
 *
 * The two implementations must never disagree, and a disagreement would be silent: a proof
 * that verifies against nothing, or a commitment nobody can open. That is what
 * `adversary/test/commitment-parity.test.ts` is for — it runs `snforge test`, reads the
 * vectors the Cairo prints, and requires every one to match what this file computes. Cairo
 * leads; this follows.
 *
 * Three things have to agree, not one: the hash (Poseidon over the same span, in the same
 * order), the domain tag's felt encoding, and the felt arithmetic at the field boundary. The
 * vectors exercise all three, including P-1, because a reduction that is wrong only near the
 * prime is exactly the kind that passes a test suite of small numbers.
 */

import { createHash } from "node:crypto";
import { poseidonHashMany } from "@scure/starknet";

/** The Stark field prime: 2^251 + 17 * 2^192 + 1. */
export const P = 2n ** 251n + 17n * 2n ** 192n + 1n;

/**
 * A Cairo short string is its bytes read big-endian as a felt. `'hydra/authorship/v1'` is 19
 * bytes, so it fits with room to spare — a felt holds 31.
 */
export function shortString(text: string): bigint {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 31) throw new Error(`short string too long: ${bytes.length} bytes`);
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

/** Must equal `commitment::DOMAIN`. The parity test reads the Cairo's value and checks it. */
export const DOMAIN = shortString("hydra/authorship/v1");

const inField = (name: string, v: bigint): bigint => {
  if (v < 0n || v >= P) throw new Error(`${name} is not a field element`);
  return v;
};

/**
 * Commit to a piece of content authored by the owner of `nullifier`.
 *
 * Order matters and is not symmetric, so a nullifier can never be passed off as a content
 * hash. Both Cairo and this file are tested for that separately.
 */
export function commit(nullifier: bigint, contentHash: bigint): bigint {
  return poseidonHashMany([
    DOMAIN,
    inField("nullifier", nullifier),
    inField("contentHash", contentHash),
  ]);
}

/**
 * Reduce arbitrary content to a felt.
 *
 * SHA-256 truncated to 31 bytes, for the reason `pointer.ts` truncates blob ids: 248 bits is
 * the largest value that always fits one felt, and "usually fits" is the property that fails
 * on the one input that matters. Truncation costs 124-bit collision resistance — an author
 * could commit to two documents at once only by finding a truncated-SHA-256 collision, which
 * is the same bar the blob id already sits behind.
 *
 * Domain-separated from the blob id so the same bytes do not produce the same value in both
 * places; a commitment that equalled a public id would leak which document it commits to.
 */
export function contentHashFor(content: Uint8Array): bigint {
  const digest = createHash("sha256").update("hydra/authorship/content/v1 ").update(content).digest();
  return BigInt(`0x${digest.subarray(0, 31).toString("hex")}`);
}
