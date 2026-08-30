/**
 * Vault content keys.
 *
 * Every function here takes `Secret<typeof VAULT_DOMAIN>` and checks the tag again at
 * runtime. The type stops the honest mistake; the check stops the one that arrives
 * through an `as any` at a call site this package does not own.
 */

import { VAULT_DOMAIN, derive, requireDomain, subKey } from "./domains.ts";
import type { Secret, Seed } from "./domains.ts";

/** The vault-domain root, from which every content key hangs. */
export function vaultRoot(seed: Seed): Secret<typeof VAULT_DOMAIN> {
  return derive(VAULT_DOMAIN, seed);
}

/**
 * The key for one blob, scoped by its id — so a leaked content key opens one object
 * rather than the vault.
 *
 * Returns a `Secret`, not bytes. Callers that need the material call `expose` and are
 * visible when someone greps for it; returning a bare `Uint8Array` here would make
 * every content key an ordinary array the moment it was created.
 *
 * There was a `contentKeyBytes` wrapper here, and the I1 audit check deleted it: it was
 * a second export handing out raw key material, and it did nothing `expose` does not.
 * One exit, not two.
 */
export function contentKey(
  root: Secret<typeof VAULT_DOMAIN>,
  blobId: string,
): Secret<typeof VAULT_DOMAIN> {
  return subKey(requireDomain(root, VAULT_DOMAIN), `blob ${blobId}`);
}
