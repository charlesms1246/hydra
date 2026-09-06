/**
 * Run the suites, and say plainly which ones did not run.
 *
 * **THE GATE WAS SATISFIED BY NOT LOOKING.** This was a `for` loop in `package.json` wrapped in
 * `if [ -f "$t" ]`: a test file that was absent produced no output, no counter and no exit code.
 * `packages/mcp` is withheld from git and from `package.json:files`, so on a fresh clone — and in
 * every published install — `packages/mcp/test/run.mjs` vanished from the run in silence, at the
 * step immediately before `npm publish`. Eight of nine files ran and nothing said so.
 *
 * `test-preflight.mjs` states the principle two lines earlier and this contradicted it four lines
 * later: *"a suite that quietly skips lets the gate pass having tested less than it claims"*.
 *
 * **THE DEFECT IS THE SILENCE, NOT THE SKIP**, and that is what makes the two lanes agree.
 * `hydra-dapp` fails on an absent directory because its absences mean something is wrong and the
 * red suite is fixable. Here `mcp` is absent *by policy*: a contributor with a clone, or anyone
 * with an install, cannot obtain it and cannot fix it, so failing would report a defect where
 * there is a decision. The rule that covers both is narrower than either — **never silently test
 * less than you claim.**
 *
 * **WITHHELD AND MISSING ARE DIFFERENT, AND THE MANIFEST DECIDES WHICH.** A package absent from
 * `package.json:files` is not distributed, so its tests are not expected to be here. A package
 * that IS distributed and has lost its tests is a broken checkout, and that still fails. Deriving
 * it from `files` rather than naming `mcp` is what stops this decaying: add a package to the
 * distribution and its tests become mandatory without anybody remembering to come back here.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every suite, in the order it runs.
 *
 * Hand-kept, and deliberately not a glob: `packages/leak/test/cites.mjs` is a module `run.mjs`
 * imports rather than a suite, and `packages/tui/test/drive.mjs` is an interactive driver that
 * takes argv. A glob would run both. The risk a hand-kept list carries is that it shrinks
 * silently, and that is the thing this file exists to stop.
 */
const FILES = [
  "packages/artifacts/test/run.mjs",
  "packages/cli/test/guards.mjs",
  "packages/cli/test/up.mjs",
  "packages/core/test/blocks.mjs",
  "packages/core/test/flows.mjs",
  "packages/leak/test/run.mjs",
  "packages/linter/test/run.mjs",
  "packages/mcp/test/run.mjs",
  "packages/tui/test/fakes.mjs",
  "packages/tui/test/render.mjs",
];

/** The `files` globs decide what ships, so they decide what is expected to be present. */
const distributed = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files ?? [];
const isWithheld = (file) =>
  !distributed.some((f) => !f.startsWith("!") && file.startsWith(`${f}/`));

const withheld = [];
let ran = 0;

/**
 * COVERAGE, NOT COMPLETION. Each suite prints its own tally and none of them is a total, so a
 * dropped file used to show up only as a smaller number that still read as success.
 *
 * **PRINTED ON THE WAY OUT WHATEVER HAPPENS**, including a failing run. The first version
 * returned early on a failure and so withheld the coverage line exactly when a reader is trying
 * to work out what the suite did — which is this file's own defect one layer up.
 */
function summarise(code) {
  console.log(`\n${ran} of ${FILES.length} test files ran.`);
  for (const file of withheld) {
    console.log(`  not run: ${file} — withheld from this distribution, so it is not here to run`);
  }
  process.exit(code);
}

for (const file of FILES) {
  if (!existsSync(join(ROOT, file))) {
    // Absent and undistributed: expected, and named rather than passed over.
    if (isWithheld(file)) { withheld.push(file); continue; }
    // Absent and distributed: this checkout is broken, and that is not a skip.
    console.error(`\n  ${file} is missing, and its package ships in package.json:files.`);
    console.error("  This checkout is incomplete — the suite cannot say what it did not run.");
    summarise(1);
  }
  console.log(`--- ${file}`);
  if (spawnSync(process.execPath, [file], { cwd: ROOT, stdio: "inherit" }).status !== 0) {
    summarise(1);
  }
  ran++;
}

summarise(0);
