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

/**
 * How often a client asks its vault for what has arrived.
 *
 * **CONSTANT, AND THAT IS A DISCLOSURE PROPERTY RATHER THAN AN IMPLEMENTATION DETAIL.** The two
 * variants have opposite consequences and the difference was measured, not argued
 * (`causal-reference-cost.test.ts`):
 *
 *   - **event-triggered** — read when something arrives — gives an operator **100%** precision
 *     guessing that a message arrived before a given read, because the read *is* the arrival;
 *   - **constant-rate** gives **63.6%** against a **63.6%** prior: nothing beyond what they knew.
 *
 * So polling sounds worse and is better, provided it is fixed. **A future optimisation toward
 * "poll more when busy" would silently take that row from the prior back to certainty**, which is
 * why `constant-rate-polling.test.ts` pins it rather than a comment asking nicely.
 *
 * WHAT IT DOES DISCLOSE, priced rather than waved through: **presence** — a client on a metronome
 * says it is running, continuously, where today one that sends and reads nothing is invisible
 * between messages — and **collection time**, since the miss→hit transition bounds when a reader
 * collected a message to within one interval. That is a read receipt the vault infers without
 * either party sending one, and **the interval IS the granularity**, which makes it a stated
 * number a user can see rather than a property nobody can quote.
 *
 * Sixty seconds: short enough that a conversation feels like one, long enough that the
 * collection-time bound is coarse. It is a trade with a number on it, and the number is published.
 */
export const POLL_INTERVAL_MS = 60_000;

/**
 * ---------------------------------------------------------------------------
 * THE JITTER FLOORS, MOVED HERE FOR ONE INTEGER.
 *
 * `claims/src/statement.ts` quotes `MIN_JITTER_BLOCKS` and reached `channel/src/schedule.ts` to
 * get it. `schedule.ts` imports `node:crypto` for the jitter draw, so **a display value dragged a
 * random source into the browser bundle** and the build failed on it — the third instance of the
 * shape this file was created for, and the same one its header describes: a claim depending on the
 * module that implements a mechanism rather than on the value it quotes.
 *
 * `schedule.ts` re-exports both, so every existing importer is unchanged.
 *
 * **BOTH, NOT JUST THE ONE THAT WAS NEEDED.** `MIN_JITTER_MS` has no consumer outside
 * `assertSafeSchedule` and moving it is not required by anything. It moves because the two numbers
 * exist to agree with each other — the count is justified entirely in minutes, and they coincide
 * only at 30s blocks — and a pair whose whole relationship is that they must be checked against
 * one another is a pair that should not be read in two files.
 * ---------------------------------------------------------------------------
 */

/**
 * Eight. Not the point where the operator reaches chance — there is no such point — but where
 * the measured curve flattens: interior messages within ~1.3x of chance, for four minutes of
 * latency. Doubling it again buys 0.02. If the sweep in `i3-upload-schedule.test.ts` moves,
 * this moves with it.
 */
export const MIN_JITTER_BLOCKS = 8;

/**
 * Four minutes, and it is a WALL-CLOCK floor because that is what the defence was measured in.
 *
 * `MIN_JITTER_BLOCKS` is a count, and every sentence justifying it is in minutes — "interior
 * messages within ~1.3x of chance, for four minutes of latency". Those agree only at the 30s
 * blocks this was written against. `blockMs` is a `--block-ms` flag, so the two came apart the
 * moment anyone set it, and setting it to the chain's REAL block time is the thing a careful
 * person does. Starknet mainnet now produces a block about every two seconds.
 *
 * MEASURED ON REAL MAINNET BLOCKS (`adversary/test/live-crowd.test.ts`), a six-message
 * conversation, counting how many other accounts published often enough to cover every one of
 * its uploads — the `channel.activeAccount` crowd. Two independent runs, different block ranges
 * and different public nodes:
 *
 *     blockMs   window   crowd  right     crowd  right
 *       2000      16s     1.0   0.500      1.0   0.500
 *       5000      40s     1.0   0.500      1.0   0.500
 *      10000      80s     1.4   0.437      1.3   0.458
 *      30000     240s    12.6   0.076      5.5   0.184   <- the default, the design point
 *      60000     480s    65.9   0.015     31.3   0.061
 *
 * THE MAGNITUDE IS NOT A CONSTANT and the two runs differ by about a factor of two — the crowd
 * is a property of who happened to be publishing, which is why the
 * number is read per conversation rather than published as one. The SHAPE is stable, and the
 * shape is the whole argument: sixteen seconds leaves the operator right half the time in both.
 *
 * So `--block-ms 2000`, which looks like a correction, costs at least a factor of three and
 * passed every check this module had. The floor is in milliseconds now. A faster chain does not
 * make a shorter window safe; it only makes the same window cost fewer blocks.
 */
export const MIN_JITTER_MS = 240_000;
