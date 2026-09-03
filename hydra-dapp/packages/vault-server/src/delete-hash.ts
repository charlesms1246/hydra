/**
 * What the server stores for a delete capability, and how it checks one.
 *
 * CALLED A HASH RATHER THAN AN AUTHENTICATOR, and the rename was a test's doing. It was
 * `authenticator`, with a header to match, and `not-observable-mechanisms.test.ts` fired: its
 * `x3dh-authenticates-not-vault` guard greps the server for `x-hydra-(sig|auth)` because the
 * vault must not verify anything about who is writing.
 *
 * The guard was right about the name and wrong about the behaviour — nothing here authenticates a
 * writer; the value is stored unexamined at upload and only ever compared at delete. But a header
 * called `x-hydra-authenticator` in a server whose claim is that it authenticates nobody is a
 * name that will mislead the next reader, and `authenticator` in cryptography means a proof of
 * identity, which this is not. So the name moved to what it is.
 *
 * A hash and a comparison. **No key material, by design** — this file exists separately from
 * `channel/src/deletion.ts` because that one derives tokens from secrets, and a server that
 * imported it would pull `identity/` into its own module graph. `server.ts`'s header records that
 * happening once already: the server's whole claim is that it holds no keys, and the dependency
 * direction is part of the guarantee rather than a matter of taste.
 *
 * So: the client derives, the server hashes and compares, and neither needs the other's half.
 */

import { createHash } from "node:crypto";

/**
 * What the server stores, and it must be a one-way function of the token.
 *
 * Storing the token itself would make the operator's own disk a delete capability for every
 * object on it — E-DEL rebuilt one layer down, where a backup or a snapshot is a standing
 * authority to erase the service's contents.
 */
export const deleteHashFor = (token: Uint8Array): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * Constant-time comparison, because the stored value is derived from a secret.
 *
 * A byte-at-a-time compare leaks the length of a matching prefix, which turns an unbounded guess
 * into a per-byte one. The server does this on every delete attempt and an attacker chooses how
 * often that happens.
 */
export function deleteHashMatches(stored: string, offered: string): boolean {
  if (stored.length !== offered.length) return false;
  let diff = 0;
  for (let i = 0; i < stored.length; i++) diff |= stored.charCodeAt(i) ^ offered.charCodeAt(i);
  return diff === 0;
}
