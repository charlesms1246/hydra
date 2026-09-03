/**
 * Deleting an encrypted blob — a capability, not a report.
 *
 * `decisions/0035` §1: for an encrypted blob the operator has no information and nothing to judge,
 * because the only party who can read it has already fetched it. So there is no moderation path
 * for this class. There is a capability instead, and the operator holds no discretion over it —
 * the token verifies or it does not, and there is no judgement to compel.
 *
 * THE CAPABILITY IS NOT THE BLOB ID, and that is the whole shape. `ERRORS.md` E-DEL: a public
 * blob's id was both its read capability and its delete capability, so anyone who could fetch a
 * post could destroy it. A blob id is public by construction. This is derived material that is
 * not, so being able to read an object is not being able to remove it.
 *
 * WHOSE CAPABILITY IT IS DEPENDS ON THE CLASS OF CONTENT, and getting that wrong would undo
 * `decisions/0026`.
 *
 *   deniable content   derived from the CHANNEL — either party may clear it, which is what
 *                      deniable means: neither of them can prove anything about it anyway.
 *   signed content     derived from the AUTHOR's signing material — only its author may withdraw
 *                      it.
 *
 * The second is the important one. A signed message is evidentiary: the signature over the
 * on-chain commitment is what makes authorship provable to a stranger later. A channel-derived
 * capability would let the COUNTERPARTY delete it — the commitment would stand, the signature
 * would stand, and there would be nothing left to check them against. `0026` closed "a
 * counterparty can fabricate your authorship"; this is the same guarantee's other half, "a
 * counterparty can destroy it", on the same submission surface.
 *
 * THE SERVER CANNOT TELL WHICH IT IS. It stores one hash and checks one preimage, so the two
 * derivations are indistinguishable to it. That is deliberate: a blob whose class the operator
 * can read is a blob whose evidentiary weight the operator can see.
 *
 * PER OBJECT, NEVER PER CHANNEL. A channel-wide token would mean one compromise clears the whole
 * history, and it could not be handed to one party without handing over the channel.
 */

import { subKey, expose, VAULT_DOMAIN } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

/** Bytes of the token a deleter presents. The stored form is `vault-server/src/delete-hash.ts`. */
export const TOKEN_BYTES = 32;

/**
 * The token that deletes one object.
 *
 * `from` is the channel's addressing key for deniable content and the author's own signing
 * material for signed content — the caller chooses, because the caller is the one that knows
 * which class it just produced.
 *
 * The blob id is mixed in so the token is per object. It is public, which is fine: it is a label
 * here rather than the secret, and the secret is `from`.
 *
 * THE HASHING AND THE COMPARE ARE NOT HERE, and that is a dependency direction rather than a
 * layout preference. `vault-server`'s whole claim is that it holds no keys, and its own header
 * records that this package once reached into its module graph through a chain of imports. A
 * server that imported this file would import `identity/` with it. So the server owns the
 * one-way function and the comparison, which need no key material, and this file owns the
 * derivation, which is nothing but key material.
 */
export function deleteToken(from: Secret<typeof VAULT_DOMAIN>, blobId: string): Uint8Array {
  return expose(subKey(from, `delete/${blobId}`), VAULT_DOMAIN).slice(0, TOKEN_BYTES);
}
