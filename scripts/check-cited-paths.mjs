#!/usr/bin/env node
/**
 * Every repository path cited in `claude-docs/*.md` is either one a reader can open, or is
 * marked as held.
 *
 * THE THIRD INSTANCE OF ONE DEFECT, WHICH IS WHERE YOU STOP FIXING INSTANCES. `leak` cited eight
 * to ten `findings/*.md` per run that nobody who installs the package can open. The linter printed
 * one under every result and an auditor-key footer. Then `SUBMISSION.md` — the document whose own
 * stated rule is *"Every factual claim names what makes it checkable"* — cited `findings/` three
 * times and pointed its largest single scoring claim at `devtool/packages/linter/src/rules.mjs`
 * for five getter calls that file does not contain, while the file that does perform them sits in
 * `devtool/packages/mcp/`, withheld. Each was found by a person looking. None of the three
 * prevented the next.
 *
 * WHY THIS ONE IS NOT THE OTHER TWO, AND THE DIFFERENCE IS THE READER.
 *
 * `web/test/site.test.ts` asks whether a VISITOR can open a citation. The devtool's
 * `packages/leak/test/cites.mjs` asks whether an INSTALLER can — it resolves against the package
 * root and the checkout root, because those are where its reader is standing. These documents are
 * read by the user, and quoted into a submission form read by a judge who then goes to the public
 * repository. So here **openable means tracked by git**, not present on this disk.
 *
 * That distinction is exactly why the class survived two fixes. `findings/`, `upstream-prs/`,
 * `devtool/packages/mcp/`, `devtool/packages/skills/` and `claude-docs/` itself are all present
 * on this machine and invisible in a clone. **A guard that asked the filesystem would pass on
 * every one of the citations that made this necessary.** It has to ask what a clone contains, and
 * `git ls-files` is that question asked directly of the index.
 *
 * The vacuity check is an ASSERTION THAT EVERY NAMED DOCUMENT WAS FOUND, not a minimum file
 * count. It was a count once and the count was calibrated to a scope that then changed — a
 * threshold which moves with the list is not a check. The assertion catches a renamed or deleted
 * document silently leaving scope, which the count never covered.
 *
 * MEASURED, NOT LISTED. There is no list of held paths here, the same way the devtool's marker
 * has no list of held findings. Trackedness is read from git on every run, so on the day
 * `findings/` is committed every citation to it starts passing on its own — the answer goes stale
 * in the safe direction rather than the reassuring one.
 *
 * VERIFIED IN THE WORLD IT PROTECTS, 2026-09-05. The guard's model of "a clone" is `git ls-files`,
 * and a model is a claim. Checked against an actual `git clone` into `/tmp`, six probes, all six
 * agree: `findings/06-live-corroboration.md`, `devtool/packages/mcp/src/networks.mjs`,
 * `claude-docs/SUBMISSION.md` and `claude-docs/decisions` are held by the guard and absent from
 * the clone; `devtool/packages/linter/src/rules.mjs` and `web/content.ts` are tracked by the
 * guard and present in the clone. **Re-run that comparison if `.gitignore` changes** — it is the
 * one assumption this file rests on and the only one a mutation cannot test.
 *
 * MUTATION-VERIFIED, BOTH DIRECTIONS. Force `isTracked` to true and the vacuity check fires
 * (`no untracked citation seen — nothing exercised the held path`, exit 2) rather than reporting
 * a clean run. Make the held marker never match and the 13 marked citations become 27 failures.
 * A guard that cannot fail is the defect this repository spent a day on.
 *
 * AND IT CAN NEVER RUN IN CI, WHICH IS NOT A GAP TO BE CLOSED LATER.
 *
 * `claude-docs/` is gitignored. On any clone the documents this checks are ABSENT, so a CI run
 * would scan nothing, find nothing and pass. **A guard whose subject is "can a person holding
 * only a clone open this" cannot itself run in that world, because in that world its inputs do
 * not exist.** The vacuity check below turns that into an exit 2 rather than a green tick, which
 * is the most this file can do about it — but the next person to reach for CI should read this
 * paragraph first and not spend an afternoon on a run that passes for the wrong reason. The
 * publishing runbook's checklist is the correct home, and it is the only one.
 *
 * If `claude-docs/decisions/` is ever published, the part of this that matters most could run in
 * CI. That is a reason to publish them, not a reason to fake the coverage.
 *
 * NOTHING RUNS THIS AUTOMATICALLY YET, and saying so is better than implying otherwise. There is
 * no repo-root `package.json`, and `.github/workflows/web.yml` belongs to the site lane. It is a
 * step in the publishing runbook and it exits non-zero, so it is one line away from any CI that
 * wants it. `--all` widens the scope; the default is the outward-facing set below.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not fail a citation whose paragraph says "held" about
 * a path that IS tracked. The devtool's marker check fails in both directions because there the
 * marker is generated and can be compared against reality exactly; here "held" is a word a human
 * wrote in a sentence, and a both-directions check would fail on prose that uses it about
 * something else. Over-marking is reported at the bottom as a note and is not an error. That is a
 * stated limit rather than a silent one.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "claude-docs");

/** What a clone contains. Not what this disk contains — that is the whole point. */
const tracked = new Set(
  execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean)
);

const EXT = /\.(md|ts|tsx|mjs|cjs|js|jsx|json|cairo|rs|toml|ya?ml|sh|css|txt|lock)$/;

/**
 * A path a reader would try to open, out of a backticked span.
 *
 * Backticks only, deliberately. Prose is full of slashes that are not paths — "signed/deniable",
 * "CLI/TUI" — and a matcher over bare text produces noise a reader learns to skip, which is how a
 * guard stops being read.
 */
function citations(text, bare = false) {
  const out = [];
  // **BARE TOKENS TOO, IN SOURCE MODE ONLY, AND THE REASON IS WHERE THE WORST ONES LIVE.**
  // Backticks-only is right for prose: a document is full of slashes that are not paths. Source
  // is not prose, and the citations that actually reach a stranger are the ones inside
  // user-facing STRING LITERALS — `console.error("... see decisions/0035.")` — which nobody
  // backticks, because backticks inside a printed sentence are noise to the person reading it.
  //
  // So the first version of this mode scanned 312 files, reported 299 failures, and could not
  // see a single one of the eleven citations that a user of this client was being SHOWN. Those
  // were found by hand. A guard that misses the instances with the most exposed reader is worse
  // than the count suggests, and the count is what makes it look thorough.
  //
  // Narrow on purpose: only the two prefixes this repository actually cites by, so this does not
  // become a matcher over every slash in every string.
  const bareSpans = [];
  if (bare) {
    for (const m of text.matchAll(/\b(?:claude-docs\/[\w./-]+|decisions\/\d{4}[\w.-]*)/g)) {
      out.push({ raw: m[0], path: m[0].replace(/[.,;:)]+$/, ""), index: m.index });
      bareSpans.push([m.index, m.index + m[0].length]);
    }
  }
  // A backticked `decisions/0035` matches both passes. Counted once, by position — a double count
  // inflates the number a reader judges progress by, in the flattering direction.
  const alreadySeen = (at, len) =>
    bareSpans.some(([a, b]) => at < b && a < at + len);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    if (alreadySeen(m.index + 1, m[1].length)) continue;
    let raw = m[1].trim();
    if (/^(https?:|ghcr\.io|0x|npm |node |git |cd |[A-Z_]+=)/.test(raw)) continue;
    // A trailing `:12` or `:12-30` or `:90,962-965` is a line reference, not part of the name.
    const path = raw.replace(/:[\d,\-]+$/, "").replace(/\/$/, "");
    if (!path.includes("/") && !EXT.test(path)) continue;   // a word, not a path
    if (path.startsWith("@") || path.startsWith("-")) continue;  // package name, flag
    if (/[ ()<>{}]/.test(path)) continue;                   // a command or a sentence
    out.push({ raw, path, index: m.index });
  }
  return out;
}

/**
 * Where a reader stands when they resolve a path.
 *
 * `DEVTOOL-PARITY-INVENTORY.md` writes `packages/mcp/src/server.mjs` because its subject is the
 * devtool; `SUBMISSION.md` writes the same file with `devtool/` on the front. Both are how a
 * person cites, and a guard that only understood one of them would report the other as broken.
 */
const BASES = ["", "devtool/", "hydra-dapp/", "web/", "claude-docs/"];

/**
 * The one path this candidate names, or null if it names nothing that exists.
 *
 * `from` is the directory of the document doing the citing, tried FIRST and for the same reason
 * `BASES` exists at all: it is where that document's reader is standing. `devtool/packages/leak/
 * README.md` writes `src/leak.mjs` and means its own `src/`, which no repo-root base can find —
 * and a guard that reported those as broken would be wrong about every nested README at once,
 * which is the fastest way to get a guard switched off.
 */
function resolve(path, from = "") {
  for (const base of (from ? [from, ...BASES] : BASES)) {
    const full = base + path;
    /*
     * NORMALISED before it is returned, because the caller compares it against `git ls-files`.
     *
     * `web/README.md` cites `../hydra-dapp` — correct, since Vercel's root directory is `web/` and
     * that is where its reader stands. With `from` this existed on disk, and then `isTracked`
     * refused it: the string was `web/../hydra-dapp`, and no tracked path starts with that.
     * `isTracked` already handles a directory by prefix-matching; it was being handed a spelling
     * no prefix could match. A guard that resolves a path one way and looks it up another is
     * wrong about every `..` in the repository.
     */
    if (existsSync(join(ROOT, full))) return relative(ROOT, join(ROOT, full));
    // `findings/06` and `decisions/0012` are prefixes of a filename, which is how people cite
    // numbered write-ups. Accept the prefix if exactly the directory it names exists.
    const slash = full.lastIndexOf("/");
    if (slash > 0 && existsSync(join(ROOT, full.slice(0, slash)))) {
      const stem = full.slice(slash + 1);
      try {
        const hit = readdirSync(join(ROOT, full.slice(0, slash))).find((e) => e.startsWith(stem));
        if (hit) return full.slice(0, slash + 1) + hit;
      } catch { /* not a directory */ }
    }
  }
  return null;
}

/**
 * Openable means TRACKED, not present.
 *
 * The whole class survived two fixes because every one of these files exists on the machine
 * doing the checking. `git ls-files` is the only question whose answer is what a clone holds.
 */
const isTracked = (full) => {
  if (tracked.has(full)) return true;
  for (const f of tracked) if (f.startsWith(full + "/")) return true;   // a directory
  return false;
};

/** The paragraph a citation sits in, which is the unit a "held" marker applies to. */
function paragraphAt(text, index) {
  const start = text.lastIndexOf("\n\n", index) + 2;
  const end = text.indexOf("\n\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

/**
 * Test a marker against prose, not against its line breaks.
 *
 * **A HARD-WRAPPED MARKER DID NOT MATCH, AND IT FAILED SILENTLY IN THE PASSING DIRECTION.**
 * `not in the public repository` written across a wrap is `public\nrepository`, which the pattern
 * below does not match — so a marker a human had written, and could read, marked nothing. Every
 * document here is hard-wrapped at 100 columns, so the phrase alternatives in {@link HELD} were
 * effectively single-word-only by accident. Second time today a guard has required a phrase to be
 * contiguous on one line; the first cost two attempts on a README count.
 */
const marks = (para) => HELD.test(para.replace(/\s+/g, " "));

/**
 * Is this path marked held ANYWHERE in this document, by a sentence that names it?
 *
 * **THE PARAGRAPH WAS THE WRONG UNIT FOR THE DOCUMENTS THAT MOST NEED THE MARKER, AND IT WAS THE
 * WRONG UNIT IN TWO DIFFERENT SHAPES.** `linter/README.md` cites four withheld findings from eight
 * cells of one table, and a markdown table has no blank line in it — so the whole table is one
 * paragraph and a caption beneath it is a different one, unreachable. `leak/README.md` cites the
 * same four findings from a table and five separate prose paragraphs. Under a paragraph rule the
 * only ways to satisfy this check were to repeat the same clause in eight table cells and five
 * paragraphs, or to hide it in an HTML comment — which would satisfy the check by saying it to
 * nobody, and this rule exists to make a reader told.
 *
 * So the unit is the **document and the path together**: a paragraph that says "held" AND names
 * `findings/02` marks every `findings/02` in that file. **The marker still has to name the path**,
 * which is what keeps this from becoming "the word held appears somewhere in this document" — an
 * unrelated sentence about a held position cannot mark anything, and that case is real: the note
 * at the bottom of this report exists because `web/README.md` says "a held position pending
 * commissioned art" about three files that are committed.
 *
 * A reader who is told once that a set of documents is withheld does not need telling seven times;
 * a reader who is never told is the failure this file is about.
 */
function heldInDocument(text, citePath) {
  const needle = citePath.toLowerCase();
  return text.split("\n\n").some((para) =>
    marks(para) && para.toLowerCase().includes(needle));
}

const HELD = /\bheld\b|\bwithheld\b|not in the public repository|pending (private )?disclosure/i;

/**
 * WHICH DOCUMENTS, AND THIS IS THE SCOPE DECISION RATHER THAN A DEFAULT.
 *
 * Run over all 75 files in `claude-docs/` this reports 1,382 unmarked citations, almost all of
 * them session notes citing a sibling note. That reader HAS `claude-docs/`; nothing is hidden
 * from them, and a guard that shouts about it is one people learn to skip — which is the same
 * failure as not having it, plus the appearance of coverage.
 *
 * THE TEST IS NOT "DOES THIS DOCUMENT LOOK OFFICIAL". IT IS "DOES ITS CONTENT LEAVE THE
 * REPOSITORY". The first version of this list had seven files, picked by the first test, and
 * three were wrong: `PUBLISHING-RUNBOOK.md` is an operator checklist the user runs,
 * `RECORDING-RUNBOOK.md` is production discipline for whoever holds the camera, and
 * `SITE-COPY-SPEC.md` is written for another session. Every one of those readers has
 * `claude-docs/` open. Their six sibling-document citations were judged individually before this
 * list was narrowed and not one was a defect — `RECORDING-RUNBOOK.md:237` telling the recordist
 * that the `tx` output must match `SUBMISSION.md` field by field is a useful instruction to a
 * person who can open both, and deleting it would remove a cross-check.
 *
 * **Narrowing a guard is how you hide a finding, so this is written down rather than done
 * quietly, and it was checked before it was done.** Nothing real is lost: the only substantive
 * citation in the three removed files is `SITE-COPY-SPEC.md`'s `decisions/0012`, and
 * `DEMO-VIDEO.md` cites the same record in content that IS spoken aloud, so the finding survives
 * where it has a reader who cannot open it. `--all` scans everything for anyone who disagrees.
 *
 * `DISCLOSURE-STATEMENT.md` stays in scope and is generated — `statement.ts` writes it and its
 * own header says do not edit. If it ever fails here the fix is to regenerate, never to edit.
 */
const OUTWARD = [
  "SUBMISSION.md",           // quoted into the submission form, read by a judge with a clone
  "DEMO-VIDEO.md",           // its blockquotes are spoken aloud in the video
  "STARKWARE-MESSAGE.md",    // sent to a named third party
  "DISCLOSURE-STATEMENT.md", // generated; a failure here means regenerate, never edit
];

/**
 * Every tracked markdown file, DERIVED — and its absence was a guard describing a corpus larger
 * than the one it walked.
 *
 * The comment at `--source` below has always said the ruling covers *"printed CLI output, the
 * generated documents, README"*. `DOCS` is `claude-docs/` and `OUTWARD` names four files inside
 * it, so the README was in the stated scope and never in the walked one. **The comment has been
 * asserting the wider coverage the whole time.**
 *
 * What that cost: root `README.md` told a new user to run
 * `hydra() { node packages/cli/src/cli.mjs "$@"; }` — a path that moved under `devtool/` in the
 * repo split. The first command in the quick start was `MODULE_NOT_FOUND`.
 *
 * ⚠ AND WIDENING THE CORPUS ALONE WOULD NOT HAVE CAUGHT IT — measured, by putting the old path
 * back and re-running. `BASES` tries `devtool/`, so `packages/cli/src/cli.mjs` resolves to a file
 * a clone contains and this half of the guard passes it, correctly: **a reader CAN open it.** The
 * defect was that a reader cannot RUN it, which is a different question, and the prefix tolerance
 * that makes the first question answerable is exactly what blinds it to the second. See
 * `runnable` below, which is the half that catches it.
 *
 * DERIVED FROM `git ls-files`, NOT LISTED, and that is the fix rather than adding `README.md` to
 * the array above. A hand-kept list of documents is what produced this: it cannot notice a
 * document that is added, and a new nested README would sit unchecked exactly as this one did.
 * `claude-docs/` is gitignored, so these two sets do not overlap — `OUTWARD` names the untracked
 * documents, and this is everything a clone actually contains.
 */
const TRACKED_DOCS = [...tracked].filter((f) => f.endsWith(".md"));

/**
 * `--source`: THE SAME QUESTION ASKED OF THE OTHER CORPUS, AND THE ONE THAT HAS A STRANGER FOR A
 * READER.
 *
 * Everything above asks whether a document in `claude-docs/` cites a path a clone contains. This
 * asks the inverse, and it is the direction that was never checked: **does shipped source cite
 * `claude-docs/`?** It does, in 95 tracked files, and every one of those pointers promises a reader
 * a document that is not in the repository and can never be, because `claude-docs/` is gitignored
 * by a standing decision.
 *
 * **NO `held` ESCAPE IN THIS MODE, DELIBERATELY.** Above, marking a citation as held is a real
 * answer: the reader is being told a route exists and is closed to them, which is information. In
 * source it is not. A comment that says "the argument for this is in a file you cannot open" gives
 * a reader nothing they can act on and costs them the belief that the codebase explains itself.
 * The ruling is that the pointers come out — the reason gets inlined where it carries the load,
 * the pointer gets dropped where it is decorative, and an argument too long to inline belongs in a
 * comment beside the code it constrains rather than in a file nobody can reach.
 *
 * **THIS FILE EXEMPTS ITSELF, AND THAT IS A CLAIM WORTH SEEING RATHER THAN A CONVENIENCE.** Its
 * subject IS `claude-docs/`; naming the directory it audits is not a promise to a reader that they
 * can open it. Nothing else is exempt.
 */
const SELF = "scripts/check-cited-paths.mjs";

/**
 * Citation formats this repository defines, as opposed to any string that happens to hold a slash.
 *
 * An unresolved one of these is a broken promise. An unresolved `foo/bar` is probably not a path
 * at all, which is why the two are handled differently below.
 */
const DEFINED_FORMAT = /^(?:claude-docs\/|decisions\/\d{4})/;

/**
 * Whether a citation sits in code rather than in a comment — which is the difference between a
 * citation a USER meets and one only a developer does.
 *
 * The user's ruling is scoped to what a reader actually meets: printed CLI output, the generated
 * documents, README. Internal comments stay cited for now. So the guard has to tell them apart, or
 * it is either red on 173 lines nobody agreed to change — which is how a guard gets ignored — or
 * silent on the ones that matter.
 *
 * Line-oriented and therefore approximate: a citation inside a string that begins mid-line after
 * `//` would be misread. It errs toward calling things comments, which is the direction that
 * under-reports rather than the one that cries wolf, and the outward-facing set was established by
 * rendering the surfaces rather than by trusting this.
 */
function inCode(lines, index, text) {
  const line = text.slice(0, index).split("\n").length - 1;
  return !/^\s*(\/\/|\*|\/\*)/.test(lines[line] ?? "");
}
const SOURCE_EXT = /\.(md|ts|tsx|mjs|cjs|js|jsx|cairo|rs|toml|ya?ml|sh|css)$/;

const all = process.argv.includes("--all");
const source = process.argv.includes("--source");
const files = (source
  ? [...tracked].filter((f) => SOURCE_EXT.test(f) && f !== SELF).map((f) => join(ROOT, f))
  : (all
    ? readdirSync(DOCS, { recursive: true }).filter((f) => String(f).endsWith(".md")).map(String)
    : OUTWARD).map((f) => join(DOCS, f)).concat(TRACKED_DOCS.map((f) => join(ROOT, f))))
  .filter((f) => existsSync(f) && statSync(f).isFile())
  .sort();

let unresolvable = 0;
let unmarked = 0;
let markedHeld = 0;
let ok = 0;
let overMarked = [];
const failures = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const rel = file.slice(ROOT.length + 1);
  const from = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
  for (const c of citations(text, source)) {
    const full = resolve(c.path, from);
    // **A CITATION IN A FORMAT THIS REPOSITORY DEFINES IS NEVER "not a path".** `decisions/NNNN`
    // and `claude-docs/…` are ours; one that resolves to nothing is a defect, not an unrecognised
    // shape, and the discard below is exactly the branch that swallowed it.
    //
    // THE DISCARD IS RIGHT IN A CLONE AND THAT IS WHY IT WAS INVISIBLE. `resolve` asks the
    // filesystem, so on this machine `claude-docs/decisions/0035` exists and resolves. In a clone
    // it does not — so **every citation this guard exists for resolved to nothing and every one
    // was discarded**, and the run reported problems that were not citations. Measured on a fresh
    // clone: 193 extracted, 193 discarded, 0 reported. A guard that cannot fail in the world it
    // protects is the one shape this repository has spent a week on.
    if (DEFINED_FORMAT.test(c.path)) {
      if (!isTracked(full ?? c.path)) {
        unmarked++;
        failures.push({ file: file.slice(ROOT.length + 1), path: c.path, full: full ?? c.path,
          inCode: inCode(lines, c.index, text) });
      } else { ok++; }
      continue;
    }
    // Names nothing in this tree — a shape that looked like a path and is not, or a file that has
    // been deleted.
    //
    // **AND THE DEFERRAL HERE USED TO NAME A SCOPE IT DOES NOT HAVE.** It said "the site's
    // citation test is what covers dangling paths". `citations-resolve.test.ts` does catch
    // `claude-docs/` citations and its forbidden list is the right shape — but its subject is
    // `claims()`, the generated claim set, not the source tree. All-source coverage and
    // this-format coverage live in different tools, and a deferral to a scope narrower than the
    // reader assumes is how both of these stayed invisible. Dangling paths in source are covered
    // by nothing; that is a gap, stated rather than deferred.
    if (full === null) { unresolvable++; continue; }
    // Build outputs and installed dependencies are ARTEFACTS being described, not sources being
    // cited: `node_modules/.bin contains one entry`, `pages.yml publishes web/out/`. A reader is
    // not being sent to open them, and flagging them is the noise that gets a guard skipped.
    // `.upstream` joins them for the same reason and not as a special case: it is the upstream
    // clone the tooling creates and then LOCATES — "then the in-repo `.upstream/`, then a sibling
    // `../.upstream/`" is a description of a search order, not a document a reader is being sent
    // to open. Marking it "held" would have been the alternative and it would have been false:
    // nothing is withholding it, it is a clone you make.
    if (/(^|\/)(node_modules|out|dist|target|build|\.upstream)(\/|$)/.test(full)) { unresolvable++; continue; }
    // In source mode "held" is not an answer — see the flag's note above.
    // The document-wide rule answers "is this held", so it is asked only of paths that are not
    // here. Asking it of a TRACKED path would widen the over-marking note below to every mention
    // of, say, `test/run.mjs` in a file whose marker paragraph names it as the route to take
    // instead — turning a report about false held markers into a report about correct ones.
    const tracked = isTracked(full);
    const marked = !source
      && (marks(paragraphAt(text, c.index)) || (!tracked && heldInDocument(text, c.path)));
    if (tracked) {
      ok++;
      if (marked) overMarked.push(`${file.slice(ROOT.length + 1)}  ${c.path}`);
    } else if (marked) {
      markedHeld++;
    } else {
      unmarked++;
      failures.push({ file: file.slice(ROOT.length + 1), path: c.path, full });
    }
  }
}

// Vacuity. A matcher that silently found nothing would pass every check above, which is the
// failure mode a guard of this shape actually has.
/**
 * Commands in a shell block are RUN, not opened — so no base tolerance.
 *
 * `resolve` asks whether a path names something a reader can open, and answers yes for
 * `packages/cli/src/cli.mjs` because `devtool/packages/cli/src/cli.mjs` exists. That is the right
 * answer to that question and the wrong one here: a reader who types the command is standing at
 * the repository root, and there is no `packages/` there. The quick start was `MODULE_NOT_FOUND`
 * for a year of commits while every citation in it resolved.
 *
 * So this checks the one thing the rest of the file deliberately does not: the literal string,
 * from the root, exactly as typed. Only interpreter invocations, because those are the ones whose
 * argument is unambiguously a path in this repository — a bare command name is on PATH or is not,
 * which is a different problem with its own guard.
 */
const RUNNER = /(?:^|[|&;({]\s*|\$\s*)(?:node|bash|sh)\s+(\.{0,2}[\w./-]+\.(?:mjs|cjs|js|ts|sh))/;
const REPO_DIR = ROOT.slice(ROOT.replace(/\/$/, "").lastIndexOf("/") + 1).replace(/\/$/, "");
const unrunnable = [];
/*
 * ⚠ DEFAULT MODE ONLY, and the reason is a cost this imposed on other lanes before it was scoped.
 *
 * `hydra-dapp`'s `npm test` runs `check:citations` — this script in `--source` mode — FIRST, so
 * anything red here exits the whole suite before a single test runs. An in-progress version of
 * this check fired during a `--source` run and took `hydra-dapp` to exit 2 for whoever else was
 * in the tree.
 *
 * Shell blocks in markdown are not what `--source` is asking about: that mode asks whether
 * shipped SOURCE cites `claude-docs/`. Gating a test suite on a command in a README is the wrong
 * coupling however correct the check is.
 */
for (const file of (source ? [] : files)) {
  const rel = file.slice(ROOT.length + 1);
  // Only documents a clone contains: `claude-docs/` is gitignored, so its shell blocks are
  // instructions to us rather than to a reader standing in a checkout.
  if (!tracked.has(rel)) continue;
  const text = readFileSync(file, "utf8");
  for (const block of text.matchAll(/```(?:bash|sh|console|shell)\n([\s\S]*?)```/g)) {
    /*
     * A block is read top to bottom and `cd` moves the reader, so the working directory has to be
     * tracked rather than assumed. `devtool/archive/README.md` says `cd packages/gui && node
     * src/server.mjs`, which is correct from there and was the one false positive the first
     * version produced.
     *
     * ⚠ WHERE THE DIRECTORY BECOMES UNKNOWN, THIS STOPS CHECKING rather than guessing. A `cd`
     * into somewhere that is not this repository — a clone of upstream, a temp dir — means the
     * guard cannot know what a relative path resolves against, and a guard that keeps checking
     * past the point it knows the answer is the shape this whole file argues against. It
     * under-reports there, which is the direction that does not cry wolf.
     *
     * `cd <reponame>` is the exception and it is the case this guard exists for: the quick start
     * is `git clone …/hydra.git && cd hydra`, after which the reader is standing at ROOT.
     */
    let cwd = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
    let known = true;
    for (const line of block[1].split("\n")) {
      const cd = /(?:^|[|&;]\s*)cd\s+([\w./-]+)/.exec(line);
      if (cd) {
        if (cd[1] === REPO_DIR) { cwd = ""; known = true; }
        else if (existsSync(join(ROOT, cwd + cd[1]))) cwd = cwd + cd[1].replace(/\/?$/, "/");
        else known = false;
      }
      if (!known) continue;
      const m = RUNNER.exec(line);
      if (!m) continue;
      const arg = m[1];
      if (arg.startsWith("<") || arg.includes("$")) continue; // a placeholder, not a path
      /*
       * Accepted if it resolves from the tracked cwd OR from the repository root, and reported
       * only when it resolves from NEITHER.
       *
       * Both conventions are in use and the document does not always say which:
       * `devtool/packages/leak/README.md` writes `node src/cli.mjs` meaning its own package, and
       * `devtool/experiments/07-client-discovery-cost/README.md` says outright "all paths below
       * are from the repository root". A guard that picked one would be wrong about the other
       * half of the repository's READMEs. Requiring failure under both readings means every
       * report is unambiguously broken — which is the only kind worth waking someone for, and it
       * still catches the case this exists for: `packages/cli/src/cli.mjs` resolves from neither.
       */
      if (!existsSync(join(ROOT, cwd + arg)) && !existsSync(join(ROOT, arg))) {
        unrunnable.push({ file: rel, arg, cwd: cwd || "." });
      }
    }
  }
}

const problems = [];
// Not "at least N files" — that was calibrated to a scope which has since changed, and a
// threshold that moves with the list is not a check. Every named document must have been found:
// a renamed or deleted one silently leaving scope is the failure this catches.
if (!all && !source) {
  const missing = OUTWARD.filter((f) => !files.some((x) => x.endsWith("/" + f)));
  if (missing.length) problems.push(`named but not scanned: ${missing.join(", ")}`);
  // The derived half needs its own vacuity check, and it cannot be a count: `git ls-files` IS the
  // list, so comparing it to itself proves nothing. What can go wrong is the corpus silently
  // emptying — a bad filter, a `tracked` that failed to populate — so require the one document
  // whose absence started this, by name.
  const docs = TRACKED_DOCS.filter((f) => files.some((x) => x === join(ROOT, f)));
  if (docs.length !== TRACKED_DOCS.length) {
    problems.push(`${TRACKED_DOCS.length - docs.length} tracked document(s) derived but not scanned`);
  }
  if (!TRACKED_DOCS.includes("README.md")) {
    problems.push("README.md is not in the derived corpus — the walk is not seeing tracked markdown");
  }
}
if (!source && unrunnable.length) {
  problems.push(`${unrunnable.length} shell command(s) name a path that does not exist in `
    + `the directory their block is run from: `
    + unrunnable.map((u) => `${u.file} (in ${u.cwd}) -> ${u.arg}`).join(", "));
}
if (source && files.length < 50) {
  problems.push(`only ${files.length} tracked source files scanned — the corpus is wrong`);
}
// Source is mostly code, so backticked identifiers that name nothing are the common case rather
// than a sign the matcher slipped. The ceiling is per-corpus for that reason.
// Source is mostly code, so backticked identifiers that name nothing are the common case rather
// than a sign the matcher slipped. The ceiling is per-corpus for that reason — and the source one
// was 40,000 against an observed 773, which is fifty times headroom and therefore not a guard at
// all. Set from the measurement, with room for the tree to grow and not for it to change shape.
if (unresolvable > (source ? 2_000 : 400)) problems.push(`${unresolvable} candidates resolved to nothing — the matcher is too loose`);
if (ok + markedHeld + unmarked < 10) problems.push(`only ${ok + markedHeld + unmarked} citations found`);
if (ok === 0) problems.push("no citation resolved to a tracked file — the resolver is broken");
if (!source && markedHeld === 0 && unmarked === 0) problems.push("no untracked citation seen — nothing exercised the held path");

/**
 * **THE SOURCE-MODE FLOOR, AND IT IS A SELF-TEST RATHER THAN A COUNT.**
 *
 * The held-path floor above was written for a corpus that HAS a held concept and was then gated
 * off in source mode, which does not — without anybody asking what the equivalent floor would be
 * there. That is the shape worth naming: an exclusion justified by one real difference between two
 * corpora, applied to a check whose PURPOSE survived the difference. The result was a mode that
 * would pass a repository in which every file cited a document no reader can open.
 *
 * The obvious repair — require `unmarked > 0` in source mode — is a landmine, because the whole
 * point of the cleanup is to drive that number to zero, and the day it succeeds the guard starts
 * failing and somebody deletes it. So the floor does not ask the corpus anything. It runs a known
 * bad citation through the same extractor and classifier the loop uses and asserts it comes out a
 * failure. That cannot go stale, and it fails if either half is broken.
 */
if (source) {
  const sample = "a comment citing `decisions/9999-invented.md` and claude-docs/NO-SUCH-FILE.md";
  const found = citations(sample, true).filter((c) => DEFINED_FORMAT.test(c.path));
  if (found.length < 2) {
    problems.push(`the extractor found ${found.length} of 2 citations in a known-bad sample — `
      + "it would not see a real one either");
  } else if (found.some((c) => isTracked(resolve(c.path) ?? c.path))) {
    problems.push("a known-bad citation classified as tracked — the classifier passes anything");
  }
}
if (tracked.size < 100) problems.push(`git ls-files returned only ${tracked.size} paths`);

console.log(source
  ? `scanned  ${files.length} tracked source files`
  // Names both halves, because "documents in claude-docs/" was true of the corpus this walked
  // before the tracked ones were added and would now understate it by seven — a summary line that
  // describes a smaller scope than the walk is the same defect this extension was fixing.
  : `scanned  ${files.length} documents (${OUTWARD.length} in claude-docs/, `
    + `${TRACKED_DOCS.length} tracked)`);
console.log(`tracked  ${ok} citations resolve to a file a clone contains`);
console.log(`held     ${markedHeld} are untracked and say so`);
console.log(`unmarked ${unmarked} are untracked and do not`);
console.log(`skipped  ${unresolvable} backticked spans name nothing in this tree`);

if (problems.length) {
  console.log("\nGUARD IS VACUOUS:");
  for (const p of problems) console.log(`  ${p}`);
  process.exit(2);
}

// **SPLIT, AND ONLY ONE HALF FAILS.** A citation in a printed string is one a USER meets; one in a
// comment is one only a developer does. The ruling covers the first and defers the second, so a
// guard that fails on both is red on 173 lines nobody agreed to change, and a guard that is always
// red is one people stop reading — which is one of the two ways this went unnoticed.
/**
 * A test file's code is code a DEVELOPER meets and a user never does.
 *
 * The third category, and it is not a nicety: 13 of these are assertion messages — the string
 * printed when a test fails. A developer running the suite reads them; nobody else can. Same
 * standing as a comment under the ruling, and lumping them with printed CLI output would have made
 * the guard red on lines the ruling deliberately defers.
 */
const isTest = (f) => /(^|\/)tests?\/|\.test\.[cm]?[jt]sx?$/.test(f);

const inCodeFailures = source
  ? failures.filter((f) => f.inCode && !isTest(f.file))
  : failures;
const inTests = source ? failures.filter((f) => f.inCode && isTest(f.file)) : [];
const inComments = source ? failures.filter((f) => !f.inCode) : [];

if (source) {
  console.log(`printed  ${inCodeFailures.length} sit in shipped code — a user can meet these`);
  console.log(`tests    ${inTests.length} sit in test code — a developer meets these`);
  console.log(`comments ${inComments.length} sit in comments`);
}

const deferred = [...inComments, ...inTests];
if (deferred.length) {
  const by = new Set(deferred.map((f) => f.file));
  console.log(`\nDeferred: ${inComments.length} in comments and ${inTests.length} in test code, `
    + `across ${by.size} files.`);
  console.log("Counted rather than failed: the ruling covers what a reader meets. See");
  console.log("`claude-docs/CITATION-CLEANUP.md` for the scope and what remains.");
}

if (inCodeFailures.length) {
  console.log("\nCitations a reader of the repository cannot open, and which do not say so:\n");
  const by = new Map();
  for (const f of inCodeFailures) {
    if (!by.has(f.file)) by.set(f.file, new Set());
    by.get(f.file).add(f.path);
  }
  for (const [f, paths] of [...by].sort()) {
    console.log(`  ${f}`);
    for (const p of [...paths].sort()) console.log(`      ${p}`);
  }
  if (source) {
    console.log("\nShipped source citing a document no reader of this repository can open. Inline");
    console.log("the reason where the citation carries the load; drop the pointer where it is");
    console.log("decorative; put an argument too long to inline in a comment beside the code it");
    console.log("constrains. Do not delete the sentence — a claim with a `because` is checkable");
    console.log("and a bare assertion is not, so stripping pointers alone is the worst of both.");
  } else {
    console.log("\nEither cite something a clone contains, or say it is held and name the route a");
    console.log("reader can take instead. Removing the citation is the wrong fix: a pointer to a");
    console.log("write-up they cannot read yet is still information, provided it says so.");
  }
}

if (overMarked.length) {
  console.log(`\nNote — ${overMarked.length} citation(s) sit in a paragraph mentioning "held" but are`);
  console.log("tracked and openable. Not an error (see the header), but worth a look:");
  for (const o of [...new Set(overMarked)].sort().slice(0, 10)) console.log(`  ${o}`);
}

/*
 * ---------------------------------------------------------------------------
 * Citations from code to TESTS, added 2026-09-06
 * ---------------------------------------------------------------------------
 *
 * **THE SAME PROMISE IN THE SAME SHAPE, AND IT WAS UNCHECKED.** Everything above is code citing a
 * DOCUMENT. `moderation/src/reports.ts` carried "store.test.ts checks that no decided object has a
 * body anywhere in the file, which is the property this comment claims" — and no such file has
 * ever existed here, and nothing asserted the property. The code was correct; nothing held it
 * there.
 *
 * That is the worst version of a stale pointer. An unguarded property is a gap. An unguarded
 * property **carrying a sentence that says it is guarded** turns away the one reader best placed
 * to close it, which is why this is worth a check rather than a fix and a shrug.
 *
 * ## THE RULE, AND WHY IT NEEDS NO ALLOWLIST
 *
 * **A backtick is the citation marker.** A backticked `*.test.ts` is a claim that the file exists;
 * a file discussed BECAUSE it does not exist is written without them. That single convention is
 * what keeps this from needing named exceptions — the three violations found when this was written
 * were all prose describing the missing file, and un-backticking them was the correct fix rather
 * than an escape hatch. Compare `reachability-sweep.test.ts`, which needs an exemption list and a
 * second test to notice when an entry goes stale.
 *
 * ## THE WEAKNESS, WRITTEN DOWN RATHER THAN DISCOVERED
 *
 * **Matched by BASENAME, so this cannot catch a citation pointing at the wrong test that happens
 * to exist.**
 *
 * **THAT IS A CHOICE, AND THE REASON IS NOT "PATHS ARE HARD".** Path-precise matching is stronger
 * and would fail nearly all 173 citations in this client, because bare filenames are the
 * long-standing convention here — `tui-conversation.test.ts`, not `packages/adversary/test/…`. A
 * guard that reports 170 failures on its first run is a guard somebody switches off that week, and
 * **a guard that is switched off catches nothing at all.** A weaker check that runs is worth more
 * than a stronger one that does not, so the weakness buys the thing running.
 *
 * The limit is real and it belongs here rather than with whoever finds it later. If the convention
 * ever changes to full paths, this should tighten with it — and the failure it cannot see today is
 * a citation naming a real test that does not check what the sentence says it checks.
 */
const TEST_CITE = /`([A-Za-z0-9_\/.\-]+\.test\.[cm]?[jt]sx?)`/g;

const testFiles = new Set();
{
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); continue; }
      if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) testFiles.add(entry.name);
    }
  };
  for (const dir of ["hydra-dapp/packages", "web", "devtool/packages"]) {
    try { walk(join(ROOT, dir)); } catch { /* a tree that is not checked out is not a failure here */ }
  }
}

/*
 * **SCOPED TO THIS PRODUCT'S SOURCE, AND THE FIRST VERSION WAS NOT.** Run across everything this
 * script already reads, it flagged `devtool/experiments/.../README.md` citing
 * `sdk/tests/internal/parallel-discovery.test.ts` — a DOCUMENT, in a different product, naming a
 * test inside a vendored SDK. Correct as a string and useless as a finding: that tree is not this
 * tree and the file it names is not ours to have.
 *
 * That is precisely the way widening a guard's corpus goes wrong — it starts reporting things that
 * are outside the promise it was built to keep, and a guard whose output has to be filtered by a
 * human is one whose output stops being read. The promise here is narrow: **code in this client
 * claiming a test in this client exists.**
 */
const IN_SCOPE = /hydra-dapp[\\/]packages[\\/].*\.[cm]?[jt]sx?$/;

const testCiteFailures = [];
for (const file of files.filter((f) => IN_SCOPE.test(f))) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(TEST_CITE)) {
    if (!testFiles.has(basename(m[1]))) testCiteFailures.push({ file, cited: m[1] });
  }
}

// VACUITY FLOOR, for the reason every other check here has one: a walker that found no files would
// report zero failures and pass. The number only goes up as the suite grows.
if (testFiles.size < 20) {
  console.log(`\nonly ${testFiles.size} test files found — the test-citation walker is not `
    + "walking, so its zero means nothing");
  process.exit(1);
}

if (testCiteFailures.length) {
  console.log(`\n${testCiteFailures.length} citation(s) name a test file that does not exist:`);
  for (const f of testCiteFailures) console.log(`  ${f.file}\n      ${f.cited}`);
  console.log("\nEither the file was renamed — fix the name — or the test was never written, in");
  console.log("which case write it. A comment claiming a property is guarded, over a property");
  console.log("nothing guards, sends away the reader who would otherwise have added the check.");
  console.log("If you are naming a file precisely because it does NOT exist, drop the backticks:");
  console.log("a backtick is the claim that it resolves.");
}

process.exit(inCodeFailures.length || testCiteFailures.length ? 1 : 0);
