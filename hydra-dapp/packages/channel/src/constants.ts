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
 * **A POSITION RECONSIDERED, SO THE EARLIER REASONING HERE DOES NOT READ AS STILL STANDING.** This
 * file originally said `vault-server` importing `vault-client/src/buckets.ts` should be left alone:
 * no invariant crossed, only a misleading package name, and extracting it would be a refactor in
 * service of a tidy. That was right on what was known then.
 *
 * It stopped being right when a **second** cross-package consumer appeared. `BUCKETS` is now
 * reached by `vault-server` and by `claims/src/statement.ts`, and the second sits on an I6
 * boundary. A shared wire constant with two consumers, reaching into a package named for a third
 * thing, is no longer a naming oddity — **it is the reason the boundary keeps getting crossed.** So
 * `BUCKETS` lives here too, and the `vault-server` oddity resolves as a side effect rather than as
 * the purpose.
 *
 * The severity was never the same as the first extraction and the distinction is worth keeping:
 * `buckets.ts` imports nothing and holds five integers, so reaching it was a package-boundary
 * violation rather than a key-exposure one. `cover.ts` and `note.ts` reached `derive()`.
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

/**
 * The padding ladder every blob is rounded up to.
 *
 * Five sizes, quoted in the disclosure statement as what an operator learns about length: not the
 * length, but which of five buckets it fell in. Both classes use the same ladder so that a public
 * object and an encrypted one disclose length at the same granularity.
 */
export const BUCKETS: readonly number[] = [1024, 4096, 16384, 65536, 262144];
