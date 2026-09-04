/**
 * Neither front end may invent a privacy claim, whatever words it chooses.
 *
 * **THE DRIFT GUARD CATCHES STRINGS; THIS CATCHES CLAIMS.** `claims-not-duplicated.test.ts` fails
 * when a claim is rendered by one interface and not the other, or when a hand-written copy sits
 * beside an imported one. It did **not** catch a fourth copy of the signing lie in the CLI's usage
 * block — *"signed: only you could have, and it is provable"* — because that is a **paraphrase**,
 * and string matching cannot see one. That is the boundary of that instrument, not a defect in it.
 *
 * `web/` already has the structural answer: the site splits its page on `data-generated` and
 * applies a forbidden-word list **only to the prose a person wrote**, so hand-written copy is
 * mechanically prevented from making a privacy claim at all. This is that mechanism for the two
 * clients. Now that `claims/src/warnings.ts` is the single source and both front ends render it,
 * everything else in those files is by definition prose — and prose must not claim.
 *
 * The difference between "the two UIs agree" and "neither UI is allowed to invent one".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { WARNINGS } from "../../claims/src/warnings.ts";
import { codeOf } from "../src/prose.ts";

const PACKAGES = join(import.meta.dirname, "..", "..");
/**
 * Every package that puts a sentence in front of a human — not just the ones a user types into.
 *
 * The boundary was "the front ends", and that was too narrow. `vault-server`'s startup banner is
 * read by an operator; `operator`'s review output is read by somebody deciding to remove a post;
 * `moderation`'s report body is read by the public. A claim that drifts in any of those misleads
 * the person acting on it — and the reviewer case is the sharpest, because the number they are
 * being warned about is the one they would otherwise act on.
 */
const FRONT_ENDS = ["cli", "tui", "client", "vault-server", "operator", "moderation"];

/**
 * Claim-shaped language, extending `web/content.ts`'s vocabulary with the forms these two clients
 * actually produced. Each is an unqualified guarantee with no number behind it, and the generated
 * statement never produces one.
 */
const FORBIDDEN = [
  // The site's list, narrowed to CLAIM FORMS rather than vocabulary. `web/` can match bare words
  // because it scans short marketing prose; scanning source across six packages, the bare word
  // "anonymous" matched `"If you are accepting anonymous submissions"` — a use case, not a claim —
  // and "100%" matched a measured statement about window containment inside a disclosure row.
  // Noise is what gets a check deleted, so it matches the assertion and not the word.
  "is anonymous", "are anonymous", "fully anonymous", "completely anonymous",
  "untraceable", "unbreakable", "military-grade",
  "we cannot see", "nobody can see", "completely private", "fully private",
  // The forms this repo actually shipped. Every one was true of a real string here.
  "anyone can prove", "it is provable", "provable to anyone",
  "cannot be traced", "no one can tell", "impossible to",
  // UNLINKABILITY, which the first version of this list did not contain at all — so it missed the
  // vault banner asserting "two connections cannot be linked to one client", which is the exact
  // shape of claim this exists to stop being written by hand.
  "cannot be linked", "cannot be correlated", "cannot be joined", "nobody can link",
];

/**
 * The disclosure tables, which are the GENERATED side and are exempt for the reason `claims/` is.
 *
 * `web/` draws this line with `data-generated`: the forbidden list applies to prose a person wrote,
 * not to rendered generated content. These files are that content — structured rows, each with its
 * own two-way guard checking it against real captures in both directions. Scanning them would make
 * the single source fail its own check, and the pressure would land on the check.
 */
const GENERATED = ["observations.ts", "node-view.ts", "statement.ts", "warnings.ts"];

const sources = () => FRONT_ENDS.flatMap((pkg) => {
  const dir = join(PACKAGES, pkg, "src");
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !GENERATED.some((g) => f.endsWith(g)))
    .map((f) => ({ path: `${pkg}/src/${f}`, text: readFileSync(join(dir, f), "utf8") }));
});

/** Text a user could see: string and template literals, comments removed. */
const userFacing = (source: string) =>
  [...codeOf(source).matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g)]
    .map((m) => m[0]).join("\n").toLowerCase();

test("NO FRONT END MAKES A PRIVACY CLAIM IN ITS OWN WORDS", () => {
  const found: string[] = [];
  for (const file of sources()) {
    const text = userFacing(file.text);
    for (const phrase of FORBIDDEN) {
      if (text.includes(phrase)) found.push(`${file.path}: "${phrase}"`);
    }
  }
  assert.deepEqual(found, [],
    "these are unqualified guarantees written by hand in a client. A privacy claim is generated "
    + "from claims/src/warnings.ts or from the statement, never asserted — because a sentence "
    + "somebody wrote is a sentence that drifts, and four of these have already been false.");
});

test("THE CHECK IS NOT VACUOUS: the vocabulary matches what actually shipped", () => {
  // A forbidden list that never matched anything is a list nobody can tell is working. Every
  // phrase below was in a real string in this repo, so the check is calibrated against the
  // defects it exists to prevent rather than against imagination.
  const wasReal = ["anyone can prove", "it is provable", "cannot be linked"];
  for (const phrase of wasReal) {
    assert.ok(FORBIDDEN.includes(phrase), `${phrase} shipped and is not in the list`);
  }
  // And the claims module itself is exempt by construction — it is not scanned, because it is
  // where claims are SUPPOSED to live. If it were scanned, the single source would fail its own
  // check and the pressure would be to weaken the check.
  assert.ok(!FRONT_ENDS.includes("claims"));
  assert.ok(WARNINGS.some((w) => /prove/.test(w.full.join(" "))),
    "no claim in the source module discusses proof, so the exemption is doing nothing");
});

test("a claim the source module makes is allowed to reach a user verbatim", () => {
  // The other direction: the check must not make it impossible to SHOW a claim. Rendering
  // `SIGNED.full` puts "can prove you wrote this" on screen, and that is correct — it is
  // generated, qualified two lines later, and the whole point of having one source.
  const signed = WARNINGS.find((w) => w.id === "compose.signed")!;
  assert.match(signed.full.join(" "), /can prove you wrote this/);
  assert.match(signed.full.join(" "), /BUT NOT YET TO ANYONE ELSE/,
    "the qualification that makes the claim true is not in the same block as the claim");
});
