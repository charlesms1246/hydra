/**
 * Who wrote this, answered by a key only they hold.
 *
 * WHAT THIS REPLACES. `commitment.ts` used to commit to `(nullifier, contentHash)` and describe
 * the nullifier as binding a message to an identity without naming one. In this client the
 * nullifier came from the channel's own material — which both ends hold, because that is what a
 * shared secret is — so it bound a message to a CONVERSATION and not to a person.
 * `two-way.test.ts` asserted the consequence as a residual: your counterparty could compute your
 * value and mint a message that read as yours. A primitive whose name claims more than it does
 * is worse than no primitive, because everything downstream believes the name.
 *
 * So authorship is a signature by a per-author key, and it is the SAME Ed25519 key the bundle
 * already publishes (`keys.ts` `identitySign`). Nothing new is exchanged, nothing new is
 * disclosed, and the private half is derived from the author's own vault root and never leaves
 * it. A counterparty has the public half and can therefore verify and not forge, which is the
 * whole of the fix.
 *
 * TWO KINDS OF CONTENT, and the difference is chosen rather than inherited:
 *
 *   signed     recorded, submitted, published. Carries an Ed25519 signature over the content
 *              commitment. Verifiable by anyone holding the author's bundle, and forgeable by
 *              nobody — including the person you are talking to.
 *
 *   ephemeral  deniable on purpose. Carries no signature. Its authenticator is the AEAD tag
 *              under the channel's shared content key, which EITHER participant can produce, so
 *              a transcript proves nothing about which of them wrote a line. See
 *              `claude-docs/decisions/0026-authorship-and-deniability.md`.
 *
 * THE FRAME IS THE SAME SIZE EITHER WAY. An ephemeral message reserves the signature's bytes and
 * fills them with randomness. Without that, signed content would be 65 bytes longer than
 * ephemeral content and the size bucket would leak which kind a message was — turning a choice
 * about attribution into an observable, and handing a filter to anyone looking for the messages
 * somebody was willing to put their name to.
 */

import { sign as edSign, verify as edVerify, randomBytes } from "node:crypto";
import { identitySign, rawPublic, publicFromRaw, KEY_BYTES } from "./keys.ts";
import { VAULT_DOMAIN } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

/** Ed25519 signatures are 64 bytes, and the frame reserves exactly that either way. */
export const SIGNATURE_BYTES = 64;

/** What gets signed, domain-separated so a signature cannot be replayed into another protocol. */
const STATEMENT = "hydra/authorship/signature/v1 ";

/**
 * The commitment as bytes.
 *
 * Fixed width and big-endian, because a variable-length encoding of a number is a place where
 * two different felts can produce the same bytes if the encoder is careless, and a signature
 * over an ambiguous encoding is a signature over more than one thing.
 */
export function commitmentBytes(commitment: bigint): Buffer {
  if (commitment < 0n) throw new Error("a commitment is not negative");
  const hex = commitment.toString(16).padStart(64, "0");
  if (hex.length > 64) throw new Error("a commitment does not fit in 32 bytes");
  return Buffer.concat([Buffer.from(STATEMENT), Buffer.from(hex, "hex")]);
}

/** The author's own signing key. Derived from their vault root; the private half never travels. */
export const signerFor = (root: Secret<typeof VAULT_DOMAIN>) => ({
  signingKey: rawPublic(identitySign(root)),
  sign: (commitment: bigint): Uint8Array =>
    new Uint8Array(edSign(null, commitmentBytes(commitment), identitySign(root))),
});

/** Verify a signature over a commitment. Throws on a malformed key rather than returning false. */
export function verifyAuthorship(
  signingKey: Uint8Array,
  commitment: bigint,
  signature: Uint8Array,
): boolean {
  if (signingKey.length !== KEY_BYTES) throw new Error("a signing key is 32 bytes");
  if (signature.length !== SIGNATURE_BYTES) return false;
  return edVerify(null, commitmentBytes(commitment), publicFromRaw(signingKey, "Ed25519"), signature);
}

// ---------------------------------------------------------------------------
// The choice, and the frame that carries it
// ---------------------------------------------------------------------------

/**
 * How a message answers "who wrote this".
 *
 * Required by `SessionConfig`, with no default. Every call site has to say which it wants, which
 * is the difference between deniability that was designed and deniability that was left over.
 */
export type Attribution =
  | {
    readonly kind: "signed";
    readonly signingKey: Uint8Array;
    readonly sign: (commitment: bigint) => Uint8Array;
  }
  | { readonly kind: "ephemeral" };

/** A signing attribution from an author's own root. */
export const signedBy = (root: Secret<typeof VAULT_DOMAIN>): Attribution =>
  ({ kind: "signed", ...signerFor(root) });

/**
 * A deniable attribution.
 *
 * Named, and required, so choosing it is visible in the code that chose it. Deniability that
 * nobody selected is not a property, it is an accident that has not been noticed yet.
 */
export const ephemeral = (): Attribution => ({ kind: "ephemeral" });

/** Blinds are 31 bytes so they are always inside the Stark field. */
export const BLIND_BYTES = 31;

export const freshBlind = (): bigint =>
  BigInt(`0x${Buffer.from(randomBytes(BLIND_BYTES)).toString("hex")}`);

/**
 * What is sealed: the signature, the blind, and the plaintext.
 *
 * INSIDE the encryption, not beside it. A signature in the clear would be 64 bytes the vault
 * operator could see, and the same author signing two messages would hand them a value to
 * compare — an author identifier by another name. The operator's record is unchanged by any of
 * this.
 *
 * THE BLIND TRAVELS TOO, and it has to. Without it a reader can check that the author signed
 * SOME commitment and cannot check that the commitment is to the message in front of them. With
 * it the chain is complete: recompute `commit(blind, contentHash)`, require it to equal the felt
 * on chain, and require the signature to be over that felt. The result is a statement about a
 * specific author, a specific message and a specific chain event, and it is the reason the blind
 * is not simply generated and forgotten.
 *
 *     [0]        mode: 1 signed, 0 ephemeral
 *     [1..65)    signature, or randomness of the same length for ephemeral content
 *     [65..97)   blind, big-endian
 *     [97..]     plaintext
 */
export const FRAME_HEADER = 1 + SIGNATURE_BYTES + 32;

export function frame(
  signature: Uint8Array | null,
  blind: bigint,
  plaintext: Uint8Array,
): Uint8Array {
  const filler = signature ?? new Uint8Array(randomBytes(SIGNATURE_BYTES));
  if (filler.length !== SIGNATURE_BYTES) throw new Error(`a signature is ${SIGNATURE_BYTES} bytes`);
  const hex = blind.toString(16).padStart(64, "0");
  if (hex.length > 64) throw new Error("a blind does not fit in 32 bytes");
  return Buffer.concat([
    Buffer.from([signature ? 1 : 0]),
    Buffer.from(filler),
    Buffer.from(hex, "hex"),
    Buffer.from(plaintext),
  ]);
}

/** The inverse. `signature` is null for ephemeral content — the reserved bytes are noise. */
export function unframe(bytes: Uint8Array): {
  readonly signature: Uint8Array | null;
  readonly blind: bigint;
  readonly plaintext: Uint8Array;
} {
  if (bytes.length < FRAME_HEADER) throw new Error("a framed message is truncated");
  if (bytes[0] !== 0 && bytes[0] !== 1) throw new Error(`unknown attribution frame ${bytes[0]}`);
  return {
    signature: bytes[0] === 1 ? bytes.slice(1, 1 + SIGNATURE_BYTES) : null,
    blind: BigInt(`0x${Buffer.from(bytes.slice(1 + SIGNATURE_BYTES, FRAME_HEADER)).toString("hex")}`),
    plaintext: bytes.slice(FRAME_HEADER),
  };
}
