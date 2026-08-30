/**
 * Expectation tests. Each fixture declares exactly which rules must fire.
 * The false-positive fixture is as important as the others: a linter that
 * over-reports trains people to ignore it.
 */

import { readFileSync } from "node:fs";
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
console.log(failed === 0 ? "\nall fixtures behave as specified" : `\n${failed} fixture(s) failed`);
process.exit(failed === 0 ? 0 : 1);
