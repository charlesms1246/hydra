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
import { join, dirname } from "node:path";
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
function citations(text) {
  const out = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
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

/** The one path this candidate names, or null if it names nothing that exists. */
function resolve(path) {
  for (const base of BASES) {
    const full = base + path;
    if (existsSync(join(ROOT, full))) return full;
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

const HELD = /\bheld\b|\bwithheld\b|not in the public repository|pending (private )?disclosure/i;

/**
 * WHICH DOCUMENTS, AND THIS IS THE SCOPE DECISION RATHER THAN A DEFAULT.
 *
 * Run over all 75 files in `claude-docs/` this reports 1,382 unmarked citations, and almost all
 * of them are session notes citing a sibling note. That reader HAS `claude-docs/`; nothing is
 * hidden from them, and a guard that shouts about it is one people learn to skip — which is the
 * same failure as not having it.
 *
 * The defect was never in the session logs. It was in the documents whose sentences are QUOTED
 * OUTWARD — into a submission form, into a video script, into a message to StarkWare — and read
 * by somebody holding a clone and nothing else. That is the reader whose citations have to
 * resolve, so that is the list. `--all` scans everything for anyone who wants the noise.
 */
const OUTWARD = [
  "SUBMISSION.md",
  "DEMO-VIDEO.md",
  "RECORDING-RUNBOOK.md",
  "DISCLOSURE-STATEMENT.md",
  "STARKWARE-MESSAGE.md",
  "PUBLISHING-RUNBOOK.md",
  "SITE-COPY-SPEC.md",
];

const all = process.argv.includes("--all");
const files = (all
  ? readdirSync(DOCS, { recursive: true }).filter((f) => String(f).endsWith(".md")).map(String)
  : OUTWARD)
  .map((f) => join(DOCS, f))
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
  for (const c of citations(text)) {
    const full = resolve(c.path);
    // Names nothing in this tree — a shape that looked like a path and is not, or a file that
    // has been deleted. The second is a real defect and a different one; the site's citation
    // test is what covers dangling paths. Counted, so the number is visible rather than hidden.
    if (full === null) { unresolvable++; continue; }
    // Build outputs and installed dependencies are ARTEFACTS being described, not sources being
    // cited: `node_modules/.bin contains one entry`, `pages.yml publishes web/out/`. A reader is
    // not being sent to open them, and flagging them is the noise that gets a guard skipped.
    if (/(^|\/)(node_modules|out|dist|target|build)(\/|$)/.test(full)) { unresolvable++; continue; }
    const marked = HELD.test(paragraphAt(text, c.index));
    if (isTracked(full)) {
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
const problems = [];
if (files.length < 5) problems.push(`only ${files.length} documents scanned`);
if (unresolvable > 400) problems.push(`${unresolvable} candidates resolved to nothing — the matcher is too loose`);
if (ok + markedHeld + unmarked < 20) problems.push(`only ${ok + markedHeld + unmarked} citations found`);
if (ok === 0) problems.push("no citation resolved to a tracked file — the resolver is broken");
if (markedHeld === 0 && unmarked === 0) problems.push("no untracked citation seen — nothing exercised the held path");
if (tracked.size < 100) problems.push(`git ls-files returned only ${tracked.size} paths`);

console.log(`scanned  ${files.length} documents in claude-docs/`);
console.log(`tracked  ${ok} citations resolve to a file a clone contains`);
console.log(`held     ${markedHeld} are untracked and say so`);
console.log(`unmarked ${unmarked} are untracked and do not`);
console.log(`skipped  ${unresolvable} backticked spans name nothing in this tree`);

if (problems.length) {
  console.log("\nGUARD IS VACUOUS:");
  for (const p of problems) console.log(`  ${p}`);
  process.exit(2);
}

if (failures.length) {
  console.log("\nCitations a reader of the repository cannot open, and which do not say so:\n");
  const by = new Map();
  for (const f of failures) {
    if (!by.has(f.file)) by.set(f.file, new Set());
    by.get(f.file).add(f.path);
  }
  for (const [f, paths] of [...by].sort()) {
    console.log(`  ${f}`);
    for (const p of [...paths].sort()) console.log(`      ${p}`);
  }
  console.log("\nEither cite something a clone contains, or say it is held and name the route a");
  console.log("reader can take instead. Removing the citation is the wrong fix: a pointer to a");
  console.log("write-up they cannot read yet is still information, provided it says so.");
}

if (overMarked.length) {
  console.log(`\nNote — ${overMarked.length} citation(s) sit in a paragraph mentioning "held" but are`);
  console.log("tracked and openable. Not an error (see the header), but worth a look:");
  for (const o of [...new Set(overMarked)].sort().slice(0, 10)) console.log(`  ${o}`);
}

process.exit(failures.length ? 1 : 0);
