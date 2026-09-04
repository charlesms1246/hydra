/**
 * Wire constants — numbers the protocol fixes, and nothing else.
 *
 * **THIS FILE IMPORTS NOTHING, AND THAT IS ITS ENTIRE PURPOSE.** `claims/src/statement.ts` quotes a
 * cover rate and a note width to describe what an observer sees. To reach them it imported
 * `channel/src/cover.ts` and `channel/src/note.ts`, and both of those import
 * `identity/src/domains.ts` — which holds `POOL_DOMAIN`, `VAULT_DOMAIN` and `derive()`, the
 * derivation for **both** key classes I6 names. So the marketing site's import graph reached key
 * derivation in order to name five bucket sizes.
 *
 * Nothing shipped: every page is a server component, `statement()` runs at build time, and the
 * exported site contains no derivation. **But that is a property of the rendering strategy, not of
 * the code** — one `"use client"` directive erases it silently. I6's whole point is that the
 * mistake should be uncompilable, and it was merely unrendered.
 *
 * So a claim depends on a VALUE rather than on the module that defines how keys are derived.
 * `cover.ts` and `note.ts` re-export these, so nothing that already imports them changes.
 *
 * NOT THE SAME AS `vault-server` IMPORTING `vault-client/src/buckets.ts`, which stays as it is: the
 * dependency there is right and only the package name is misleading, and nothing about it crosses
 * an invariant. This one crossed I6, which is what made the extraction worth doing rather than a
 * tidy.
 */

/**
 * Decoy objects uploaded per real message.
 *
 * Four, so a message and its cover are five objects and an operator watching one upload sees a one
 * in five chance of having found the message. The number is quoted in the disclosure statement and
 * measured against real captures by the I3 harness, so it is a value the product says out loud.
 */
export const COVER_RATE = 4;

/**
 * Felts in a chain note: the pointer and the commitment.
 *
 * Two, and the statement quotes it as the whole of what anybody reading the chain sees about a
 * message — neither value says who it is for or what it says.
 */
export const NOTE_FELTS = 2;
