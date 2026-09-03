/**
 * The authority to remove public content, as a type that a user's value cannot become.
 *
 * FOURTH INSTANCE OF ONE CLASS. An invite code, a user's delete token and the operator's removal
 * token were all `string`. They are three different authorities — permission to upload, a
 * capability over one object held by the person who made it, and discretion over anyone's public
 * post — and nothing but attention stopped one being passed where another was wanted. E-DEL was
 * the third instance; `decisions/0035` §0 names the class as two distinct authorities collapsed
 * onto one value.
 *
 * This is also I8's value-level half. `decisions/0036` argues that a module-graph invariant
 * cannot be carried by a type fixture — and the authority a tool HOLDS can be, which is the
 * route that actually works. A user client cannot hold one of these by accident, because there
 * is no way to make one out of a value it already has.
 *
 * THE MINT TAKES A PATH, NOT A STRING, and that is the whole discipline — the same one `Salt`
 * uses. A function `removalAuthorityFrom(s: string)` would be a cast with a comment on it: any
 * string in reach becomes an authority, and the type stops meaning anything. Reading a file is
 * an act an operator performs on a secret they were given, so possession of the file IS the
 * evidence, and there is nothing else that produces one.
 */

import { readFileSync } from "node:fs";

declare const removalBrand: unique symbol;

/** Minted only by {@link removalAuthorityFromFile}. There is deliberately no other way. */
export type RemovalAuthority = string & { readonly [removalBrand]: true };

/**
 * Read an operator's removal secret from a file they control.
 *
 * A FILE RATHER THAN AN ARGUMENT, following `--tls-key`: a secret in argv is in the process table
 * and in a shell history. Trailing whitespace is stripped because a token file is written by a
 * human and an editor adds a newline — a secret that fails to match for that reason sends someone
 * looking for a bug in the comparison.
 */
export function removalAuthorityFromFile(path: string): RemovalAuthority {
  const value = readFileSync(path, "utf8").trim();
  if (value.length < MIN_LENGTH) {
    throw new Error(`the removal secret in ${path} is ${value.length} characters; this authority `
      + `removes anyone's public post and is guessable below ${MIN_LENGTH}`);
  }
  return value as RemovalAuthority;
}

/**
 * Short enough to be brute-forced is not a secret, and an empty file is the case that matters.
 *
 * `touch removal.token` produces a file, an empty string, and — before this check — a server that
 * announced takedown as ENABLED and matched a caller who sent an empty header. That is E-UNREACHABLE
 * inverted: a capability that appears armed and is open to everyone.
 */
export const MIN_LENGTH = 16;

/**
 * Whether an offered header carries the authority. Constant time in the length of the secret.
 *
 * `===` on a secret compares byte by byte and returns at the first difference, which times how
 * much of a guess was right. Deliberately mirrors `deleteHashMatches` rather than importing it:
 * that one compares a stored hash, this one compares a live secret, and a shared helper would
 * invite the next person to reuse whichever they found first.
 */
export function authorises(offered: unknown, authority: RemovalAuthority | undefined): boolean {
  if (authority === undefined || typeof offered !== "string") return false;
  if (offered.length !== authority.length) return false;
  let diff = 0;
  for (let i = 0; i < authority.length; i++) diff |= offered.charCodeAt(i) ^ authority.charCodeAt(i);
  return diff === 0;
}
