/**
 * Separating what the code does from what somebody wrote about it.
 *
 * **SIX TIMES IN TWO DAYS, AN ACCURATE EXPLANATION BROKE THE GUARD IT WAS EXPLAINING.** Every one
 * was the same shape and every one was found by tripping over it:
 *
 *   1. `x3dh-authenticates-not-vault` greps for `x-hydra-(sig|auth)`; a comment explaining that
 *      nothing authenticates a writer matched it.
 *   2. The same grep again, on a different mechanism's comment — fixed once in `grep()` for all
 *      of them at once, which is the precedent for this file.
 *   3. A negative claim assertion on a disclosure row matched the row **quoting the wording it was
 *      correcting**.
 *   4. The reachability sweep counted a symbol named in a doc comment as a caller, and declared a
 *      live allowlist entry stale.
 *   5. Fixing that by stripping every `//` to end of line ate the rest of any line containing a
 *      URL — `http://127.0.0.1:8080` is not a comment — which HID REAL CALLERS. The correction ran
 *      in the worse direction than the defect.
 *   6. A guard asserting `usage()` no longer slices a hardcoded range fired on its own comment,
 *      which quotes `slice(3, 30)` while explaining why it went.
 *
 * That is past coincidence and past a rule. **Any assertion about what a source file does — and
 * especially any assertion that something is ABSENT — matches against {@link codeOf}, not against
 * the file.** Written here so the seventh does not arrive, and so a helper exists at the moment
 * somebody needs one rather than after they have been bitten.
 *
 * The direction of failure is not symmetric, which is lesson 5: a matcher that sees too much
 * produces noise somebody investigates, and a matcher that sees too little produces a green suite.
 * When you make one smarter, check what it stopped seeing.
 *
 * **AND THE SECOND HALF OF THE SAME DISCIPLINE: a list must be checked for whether it ever sees
 * anything.** A matcher is checked for what it stopped seeing; a vocabulary, an allowlist or a
 * fixture set is checked for whether it still has something to catch. Three instruments here carry
 * that check explicitly — the typecheck gate fails if the must-not-compile fixtures stop erroring,
 * the forbidden-claim list asserts it contains phrases that really shipped, and this sweep fails if
 * its scan finds implausibly few candidates. Each of those would otherwise pass forever by
 * measuring nothing, which is the same disease as counting an aggregate instead of checking members.
 *
 * It is not sufficient on its own: the forbidden list had `cannot be traced` and not
 * `cannot be linked`, so it was demonstrably catching things and still missed a claim that had
 * already shipped. A calibrated list proves the instrument works; it does not prove the vocabulary
 * is complete.
 */

/**
 * A source file with comments removed, so a claim in prose cannot satisfy or break a check.
 *
 * BLOCK COMMENTS AND WHOLE-LINE `//` ONLY. A trailing `//` after code cannot be stripped safely
 * without parsing: `"http://…"` inside a string is not a comment, and treating it as one deletes
 * the rest of a real line. A trailing comment is a much rarer way to name something you are not
 * doing, and the failure it leaves is noise rather than silence.
 */
export const codeOf = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*\/\//.test(l))
  .join("\n");

/**
 * A string with backtick-quoted spans removed.
 *
 * For assertions about PROSE rather than code — a disclosure row, a decision file, a warning — where
 * the convention is that a quoted span is the thing being discussed rather than the thing being
 * said. A row correcting `the on-chain commitment still stands` must not fail a check that the
 * claim is absent.
 */
export const unquoted = (prose: string): string => prose.replace(/`[^`]*`/g, "");
