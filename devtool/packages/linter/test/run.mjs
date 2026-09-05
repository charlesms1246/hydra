/**
 * Expectation tests. Each fixture declares exactly which rules must fire.
 * The false-positive fixture is as important as the others: a linter that
 * over-reports trains people to ignore it.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSource } from "../src/analyze.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => join(here, "fixtures", n);

const CASES = [
  ["bad-happy-path.ts", ["HYD001", "HYD007"]],
  ["good.ts", ["HYD007"]], // correctly configured: only the unavoidable auditor note
  ["slow-and-unbounded.ts", ["HYD004", "HYD005", "HYD005", "HYD007"]],
  ["network-mixup.ts", ["HYD006", "HYD007"]],
  ["indirect.ts", ["HYD000", "HYD007"]],
  ["indexer-direct.ts", ["HYD003", "HYD008", "HYD003", "HYD002", "HYD003", "HYD007"]],
  // One cause, five spellings: a shorthand property and a spread both mean "present, and not
  // readable from this file". The first line is the syntax HYD001's own detail quotes, and it
  // used to produce no error and exit 0.
  ["shorthand.ts", ["HYD001", "HYD000", "HYD000", "HYD000", "HYD000", "HYD007"]],
  // `import * as sdk` and a renamed named import. Both were invisible: zero findings, exit 0.
  ["namespace.ts", ["HYD001", "HYD003", "HYD008", "HYD001", "HYD007"]],
  ["false-positive-bait.ts", []],
];

let failed = 0;
for (const [file, expected] of CASES) {
  const got = analyzeSource(fx(file), readFileSync(fx(file), "utf8"))
    .map((f) => f.rule)
    .sort();
  const want = [...expected].sort();
  const ok = got.length === want.length && got.every((r, i) => r === want[i]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${file.padEnd(26)} ${got.join(",") || "(none)"}`);
  if (!ok) {
    console.log(`      expected: ${want.join(",") || "(none)"}`);
    failed++;
  }
}
// Exit codes, driven as real processes because that is the only place an exit code exists.
//
// The default matters as much as the flag. HYD000 means "this may be posting your viewing key
// and I cannot tell", and by default it produces the same green tick as a clean pass — which is
// deliberate, because a gate that fails on every spread gets removed. `indirect.ts` is exactly
// one HYD000 plus one INFO, so it is the file that tells the two behaviours apart.
{
  const CLI = join(here, "..", "src", "cli.mjs");
  const run = (...argv) => spawnSync(process.execPath, [CLI, fx("indirect.ts"), ...argv], { encoding: "utf8" });

  const plain = run();
  if (plain.status !== 0) { console.log(`FAIL  exit/unknown-is-not-a-failure  exit ${plain.status}`); failed++; }
  else if (!plain.stdout.includes("--fail-on-unknown")) {
    console.log("FAIL  exit/default-is-stated  the run does not say undetermined findings did not fail it");
    failed++;
  } else console.log(`PASS  ${"exit: default".padEnd(26)} 0, and says why`);

  const strict = run("--fail-on-unknown");
  if (strict.status !== 1) { console.log(`FAIL  exit/strict-fails-on-unknown  exit ${strict.status}`); failed++; }
  else console.log(`PASS  ${"exit: --fail-on-unknown".padEnd(26)} 1`);

  // Both output paths take the same decision; a flag honoured in one and not the other is the
  // shape this lane has spent the day removing.
  const j = run("--json", "--fail-on-unknown");
  const jPlain = run("--json");
  if (j.status !== 1 || jPlain.status !== 0) {
    console.log(`FAIL  exit/json-matches-human  --json ${jPlain.status}, --json --fail-on-unknown ${j.status}`);
    failed++;
  } else console.log(`PASS  ${"exit: --json agrees".padEnd(26)} 0 and 1, same as the human view`);
}

console.log(failed === 0 ? "\nall fixtures behave as specified" : `\n${failed} fixture(s) failed`);
process.exit(failed === 0 ? 0 : 1);
