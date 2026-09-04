/**
 * Removing an encrypted object under legal process — `DECISIONS-NEEDED.md` D6.
 *
 * **THE POSITION IN `decisions/0035` §1 CHANGED, AND THE OLD REASONING WAS NOT WRONG.** It said an
 * encrypted object the operator can delete on request is one they can be compelled to delete, and
 * that they cannot know what they are deleting — so the encrypted class got a capability instead,
 * with no operator discretion anywhere in it. That argument still holds. The decision (user,
 * 2026-09-04, relayed through review) is that the ordered, auditable version is worth its cost
 * anyway, because the alternative is not "no compelled removal" — it is an operator who complies
 * off the record, by whatever means, with nothing counting it.
 *
 * So this exists to make compulsion **countable and visible**, not to make it easy. Every design
 * choice below is a constraint on it rather than a convenience for it.
 *
 * SEPARATELY KEYED, AND NOT `RemovalAuthority`. Public takedown and compelled encrypted removal are
 * different powers, and possession of one must never imply the other — otherwise routine moderation
 * escalates into reaching into private messages, which is exactly the drift this whole class split
 * was built to prevent. Different brand, different mint, different file, different header. There is
 * no function anywhere that turns one into the other.
 *
 * PER BLOB ID. Never per channel, never bulk, never a range. A bulk path is the thing that gets
 * demanded, and a capability that can only act on one named object is one whose use is countable —
 * which is the entire value of building it in the open.
 *
 * THE OPERATOR STILL CANNOT KNOW WHAT THEY ARE DELETING, and nothing here pretends otherwise. What
 * is recorded is the id and that process was served. **Never a claim about content**: an operator
 * asserting what an encrypted object contained is asserting something they cannot know, and a
 * record that invites them to is a record that will eventually contain a guess.
 */

import { readFileSync } from "node:fs";

declare const compelledBrand: unique symbol;

/**
 * Authority to remove one encrypted object under legal process.
 *
 * Minted only by {@link compelledAuthorityFromFile}. Deliberately no other way, and deliberately
 * not convertible from `RemovalAuthority` in either direction — `i8-must-not-compile.ts` has the
 * routes.
 */
export type CompelledAuthority = string & { readonly [compelledBrand]: true };

/**
 * Read the secret from a file the operator controls.
 *
 * A path rather than a string, the same discipline as `RemovalAuthority` and `Salt`: a function
 * taking a value would make any string in reach an authority, and this is the most consequential
 * authority in the system.
 *
 * LONGER THAN A REMOVAL SECRET, at 32 characters, and the asymmetry is deliberate. A public
 * takedown removes something everyone could already read; this reaches into a conversation the
 * operator cannot read, and the two should not feel like the same act to whoever configures them.
 */
export function compelledAuthorityFromFile(path: string): CompelledAuthority {
  const value = readFileSync(path, "utf8").trim();
  if (value.length < MIN_LENGTH) {
    throw new Error(`the compelled-removal secret in ${path} is ${value.length} characters; this `
      + `authority reaches into encrypted objects and is guessable below ${MIN_LENGTH}`);
  }
  return value as CompelledAuthority;
}

export const MIN_LENGTH = 32;

/** Constant time, for the same reason `authorises` is: `===` times how much of a guess was right. */
export function compels(offered: unknown, authority: CompelledAuthority | undefined): boolean {
  if (authority === undefined || typeof offered !== "string") return false;
  if (offered.length !== authority.length) return false;
  let diff = 0;
  for (let i = 0; i < authority.length; i++) diff |= offered.charCodeAt(i) ^ authority.charCodeAt(i);
  return diff === 0;
}

/**
 * What is written down when one happens.
 *
 * FOUR FIELDS AND NO FIFTH. There is no place to record what the object was, what was alleged, or
 * who asked — the first two are unknowable to the operator and the third is a record about a person
 * that this service has spent its whole design refusing to keep. `reference` is the operator's own
 * handle for the process served (a case number), so an audit can be joined to paperwork that exists
 * outside this system, and it is free text precisely because we should not model it.
 */
export type CompelledRemoval = {
  readonly blobId: string;
  readonly at: number;
  /** The operator's handle for the process served. Never a description of the object. */
  readonly reference: string;
  /** Always true. Present so the record cannot be confused with a capability delete. */
  readonly underProcess: true;
};
