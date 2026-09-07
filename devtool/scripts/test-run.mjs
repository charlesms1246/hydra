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
import { spawn } from "node:child_process";
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
  "packages/cli/test/guards.mjs",
  "packages/cli/test/up.mjs",
  "packages/core/test/blocks.mjs",
  "packages/core/test/flows.mjs",
  "packages/core/test/stack-stop.mjs",
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
const counted = [];

/**
 * ONE NUMBER FOR THE RUN, BECAUSE THE ALTERNATIVE WAS MEASURED AND IT IS WRONG TWICE.
 *
 * `summarise()` said how many FILES ran and nothing said how many CHECKS did — true of suites
 * ("each suite prints its own tally and none of them is a total") but it leaves the run with no
 * number, so anyone quoting one derives it from whichever line is loudest. `render.mjs`'s
 * `all 76 checks pass` is the loudest, and 76 reached a shields.io badge as the repository's
 * total. Corrected by hand to 133 — and **133 is also wrong**: it counts `PASS` lines, and
 * `packages/mcp/test/run.mjs` prints `  ok    …`, contributing 31 checks that both hand-counts
 * missed. Two careful derivations, same direction, same cause.
 *
 * **THE COUNTER IS A PROXY AND IS TREATED AS ONE.** Counting lines that look like results is not
 * counting results; a suite that invents a third format contributes silently zero, which is
 * exactly how mcp's 31 hid. So a suite that ran, exited 0 and produced NO recognised result line
 * is reported by name rather than folded into the total — the same rule as the withheld files
 * above, one layer in: **never silently count less than you ran.**
 */
const RESULT = /^(?:PASS|FAIL) |^ {2}(?:ok|fail) {2}/gm;
const SKIPPED = /^SKIP |^ {2}skip {2}/gm;

/**
 * COVERAGE, NOT COMPLETION. Each suite prints its own tally and none of them is a total, so a
 * dropped file used to show up only as a smaller number that still read as success.
 *
 * **PRINTED ON THE WAY OUT WHATEVER HAPPENS**, including a failing run. The first version
 * returned early on a failure and so withheld the coverage line exactly when a reader is trying
 * to work out what the suite did — which is this file's own defect one layer up.
 */
function summarise(code) {
  const checks = counted.reduce((n, c) => n + c.checks, 0);
  const skips = counted.reduce((n, c) => n + c.skips, 0);
  console.log(`\n${checks} checks across ${ran} of ${FILES.length} test files${skips ? ` (${skips} skipped)` : ""}.`);
  for (const file of withheld) {
    console.log(`  not run: ${file} — withheld from this distribution, so it is not here to run`);
  }
  // Ran, PASSED, and said nothing this counter recognises. Named, not absorbed: a zero here means
  // the total above is smaller than the work done, which is the failure that put 76 in a badge.
  //
  // `status === 0` is load-bearing. Without it this fires on a suite that CRASHED before printing
  // anything — seen in a published install, where the linter's deps are absent by design and the
  // report claimed it "prints results in a shape this counter does not know". A message whose
  // premise is narrower than the condition that triggers it, which is the defect this whole file
  // is about. A failing suite is already reported by its own output and the non-zero exit.
  for (const { file } of counted.filter((c) => c.checks === 0 && c.status === 0)) {
    console.log(`  counted 0 checks in ${file} — it ran and passed, but prints results in a shape this counter does not know, so the total above is short`);
  }
  process.exit(code);
}

/** Forwards the child's output as it arrives — the suites take ~35s and silence reads as a hang — and counts it on the way past. */
function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: ["inherit", "pipe", "inherit"] });
    let checks = 0, skips = 0, tail = "";
    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      // A result line split across two chunks would be missed by both, so the last partial line
      // is carried forward rather than counted where it broke.
      const text = tail + d.toString();
      const cut = text.lastIndexOf("\n") + 1;
      const whole = text.slice(0, cut);
      tail = text.slice(cut);
      checks += (whole.match(RESULT) ?? []).length;
      skips += (whole.match(SKIPPED) ?? []).length;
    });
    child.on("close", (status) => {
      checks += (tail.match(RESULT) ?? []).length;
      skips += (tail.match(SKIPPED) ?? []).length;
      counted.push({ file, checks, skips, status });
      resolve(status);
    });
  });
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
  ran++;
  if (await runFile(file) !== 0) summarise(1);
}

summarise(0);
