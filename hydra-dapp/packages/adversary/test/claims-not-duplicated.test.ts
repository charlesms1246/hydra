/**
 * A privacy claim has ONE source and two readers.
 *
 * Standing rule 3 says privacy claims are generated, never asserted. Three were asserted twice —
 * once in `cli`, once in `tui` — and drifted **in both directions**:
 *
 *   - The CLI was corrected to say signing alone buys no third-party proof; the TUI went on saying
 *     *"anyone can prove it"*. A user acting on that is exactly who this product is for.
 *   - The CLI retracted *"the ABI is not verified anywhere in this repo"* after `0031`; the TUI did
 *     not.
 *   - `0033` fixed the two-device cover collision, the TUI was updated, and **the CLI kept warning
 *     about identical cover.** Same defect, opposite direction — so it is not one careless file.
 *
 * **WHAT THIS INSTRUMENT CANNOT SEE: a paraphrase.** It matches strings, so a sentence making the
 * same claim in different words passes it — and one did, immediately. The CLI's usage block still
 * read *"signed: only you could have, and it is provable"*, a fourth copy of the signing claim,
 * worded differently enough to be invisible here. That is the boundary of string matching rather
 * than a defect in this check, and it is why `no-invented-claims.test.ts` exists: it forbids
 * claim-shaped LANGUAGE outside the claims module, so a front end cannot invent one whatever words
 * it chooses. Read the two together; neither is coverage on its own.
 *
 * A TEST WAS PINNING ONE OF THE LIES. `tui-conversation.test.ts` asserted the compose line said
 * "anyone holding your bundle can prove it", so the false claim had a guard keeping it in place.
 * That is why this file checks the SHAPE — one source, both readers — rather than adding a fourth
 * assertion about a fourth string.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { WARNINGS } from "../../claims/src/warnings.ts";
import { codeOf } from "../src/prose.ts";

const PACKAGES = join(import.meta.dirname, "..", "..");
/** The two front ends. Both must render every claim; neither may restate one. */
const FRONT_ENDS = ["cli", "tui"];

const sourcesOf = (pkg: string) => {
  const dir = join(PACKAGES, pkg, "src");
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => ({ path: `${pkg}/src/${f}`, text: readFileSync(join(dir, f), "utf8") }));
};

test("EVERY FRONT END RENDERS THE SAME CLAIMS, from the same place", () => {
  assert.ok(WARNINGS.length >= 4, "the claim set shrank — check nothing was quietly inlined again");
  // IMPORT LINES REMOVED BEFORE MATCHING. Without this the guard sees the symbol in the `import`
  // statement and passes even when nothing renders it — a mutation replacing `SIGNED.short` with
  // a hand-written string went straight through. Importing a claim is not showing it, and the
  // whole failure mode here is a claim that stops being rendered while the wiring stays.
  const rendered = (text: string) => codeOf(text)
    .split("\n").filter((l) => !/^\s*import\b/.test(l))
    // QUOTED STRINGS REMOVED TOO, so a symbol NAME appearing as display text does not count as a
    // reference to the symbol. `paint(" SIGNED ", "inverse")` is a badge a user reads, not a use
    // of `SIGNED` — and with it left in, a mutation replacing the rendered claim with hand-written
    // prose still passed. Backticks are kept, because `${SIGNED.short}` is exactly the reference
    // being looked for and lives inside one.
    .map((l) => l.replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, '""'))
    .join("\n");
  const rendering = new Map([...new Set(WARNINGS.flatMap((w) => w.surfaces))].map((pkg) => [pkg,
    sourcesOf(pkg).map((f) => rendered(f.text)).join("\n")]));

  // A claim shown by one front end and not the other is the drift itself. `SECOND_CLIENT` is the
  // case that proves the direction runs both ways — the CLI was the stale one there.
  const symbols = { "compose.signed": "SIGNED", "compose.deniable": "DENIABLE",
    "record.notWritten": "RECORD_NOT_WRITTEN", "identity.secondClient": "SECOND_CLIENT",
    "vault.tlsTermination": "TLS_TERMINATION" };
  for (const w of WARNINGS) {
    const symbol = symbols[w.id as keyof typeof symbols];
    assert.ok(symbol, `${w.id} has no symbol in this guard — add it, or the claim is unchecked`);
    // Checked against the surfaces the claim DECLARES, not against every package: the compose
    // claims belong to both clients and drifting between them is the defect; the vault's TLS claim
    // belongs to the vault. A rule that demanded all of them everywhere would be followed by
    // nobody.
    const shown = w.surfaces.filter((pkg) => new RegExp(`\\b${symbol}\\b`).test(rendering.get(pkg)!));
    assert.deepEqual(shown, [...w.surfaces],
      `${w.id} is rendered by ${shown.join(", ") || "neither front end"} — a claim shown in one `
      + "interface and not the other is how all three of these drifted");
  }
});

test("NEITHER FRONT END RESTATES A CLAIM IN ITS OWN WORDS", () => {
  // The other half. Importing the module is not enough if a second, hand-written copy survives
  // beside it — that is exactly the state the repo was in, with `cli` and `tui` each holding a
  // version of the same sentence.
  //
  // Matched on a distinctive PHRASE from each claim rather than the whole text, because a front
  // end legitimately wraps and truncates. A phrase is what a reader would recognise as the claim.
  const phrases = [
    "could have written this",
    "anyone can prove it",
    "verified anywhere in this repo",
    "identical cover",
    "spending the same invites",
  ];
  for (const pkg of FRONT_ENDS) {
    for (const file of sourcesOf(pkg)) {
      for (const phrase of phrases) {
        assert.ok(!codeOf(file.text).includes(phrase),
          `${file.path} states "${phrase}" itself. Claims come from claims/src/warnings.ts so the `
          + "two front ends cannot disagree — this one has its own copy again.");
      }
    }
  }
});

test("every claim cites what settled its wording", () => {
  // A claim with a `because` can be checked against the thing it cites. A claim without one is a
  // sentence, and a sentence is what drifted three times.
  for (const w of WARNINGS) {
    assert.ok(w.because.length > 20, `${w.id} has no source for its wording`);
    assert.ok(w.full.length > 0 && w.short.length > 0, `${w.id} is missing a rendering`);
    // `short` must not claim more than `full` does — a status bar is where a hedge gets dropped.
    assert.ok(!/\bcan prove\b/.test(w.short) || /\bcan prove\b/.test(w.full.join(" ")),
      `${w.id}'s short form claims proof its full text does not`);
  }
});
