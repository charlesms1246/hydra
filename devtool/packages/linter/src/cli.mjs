#!/usr/bin/env node
/**
 * hydra-dev lint — reports what a STRK20 configuration discloses.
 *
 * Exit codes: 0 clean or info-only, 1 findings at warn or above, 2 bad invocation.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { analyzeSource } from "./analyze.mjs";
import { AUDITOR_KEYS, ERROR, WARN, INFO, UNKNOWN } from "./rules.mjs";
// One notion of "can the reader open this", shared with packages/leak — the linter makes the
// same promise on the same citations and must not answer it differently.
import { citeLabel, isHeldCite } from "../../leak/src/facts.mjs";

const EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"]);
const SKIP = new Set(["node_modules", "dist", "build", ".git", "coverage", "target"]);

function walk(p, out = []) {
  const st = statSync(p);
  if (st.isFile()) {
    if (EXTS.has(extname(p)) && !p.endsWith(".d.ts")) out.push(p);
    return out;
  }
  for (const e of readdirSync(p)) {
    if (SKIP.has(e)) continue;
    walk(join(p, e), out);
  }
  return out;
}

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
if (args.length === 0) {
  console.error("usage: hydra-dev lint <file-or-dir>... [--json]");
  process.exit(2);
}

const files = args.flatMap((a) => walk(a));
const findings = files.flatMap((f) => {
  try {
    return analyzeSource(f, readFileSync(f, "utf8"));
  } catch (e) {
    console.error(`skipped ${f}: ${e.message}`);
    return [];
  }
});

if (asJson) {
  // `finding` stays the raw path — it is an identifier, and marking it would corrupt it for
  // anything matching on it. The held set is reported alongside instead, so a consumer of
  // --json is told what a person at a terminal is told. Present only when true.
  const held = [...new Set(findings.map((f) => f.finding))].filter(isHeldCite);
  console.log(JSON.stringify({
    filesScanned: files.length,
    ...(held.length ? { heldCitations: held } : {}),
    findings,
  }, null, 2));
  process.exit(findings.some((f) => f.severity === ERROR || f.severity === WARN) ? 1 : 0);
}

const ORDER = { [ERROR]: 0, [WARN]: 1, [UNKNOWN]: 2, [INFO]: 3 };
const MARK = { [ERROR]: "ERROR ", [WARN]: "WARN  ", [UNKNOWN]: "UNKNOWN", [INFO]: "INFO  " };

console.log(`\nhydra-dev lint — scanned ${files.length} file(s)\n`);

if (findings.length === 0) {
  console.log("  No findings.");
  console.log("  This means no *checked pattern* matched. It is not a privacy claim:");
  console.log("  indirection this tool cannot resolve is invisible to it.\n");
  process.exit(0);
}

/** Both `detail` and `fix` are prose and both can be long; one wrapper, so they cannot diverge. */
const wrap = (text) => String(text).replace(/(.{1,92})(\s|$)/g, "$1\n        ").trimEnd();

findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.file.localeCompare(b.file));

for (const f of findings) {
  const loc = `${relative(process.cwd(), f.file)}:${f.line}:${f.col}`;
  console.log(`${MARK[f.severity]} ${f.rule}  ${loc}`);
  console.log(`        ${f.title}`);
  console.log(`        ${wrap(f.detail)}`);
  if (f.evidence) console.log(`        evidence: ${f.evidence}`);
  console.log(`        fix: ${wrap(f.fix)}`);
  console.log(`        source: ${citeLabel(f.finding)}\n`);
}

const counts = findings.reduce((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {});
console.log(
  `${counts[ERROR] ?? 0} error, ${counts[WARN] ?? 0} warn, ` +
    `${counts[UNKNOWN] ?? 0} undetermined, ${counts[INFO] ?? 0} info`
);
const KEYS_CITE = citeLabel("findings/06-live-corroboration.md");
console.log(`\nLive auditor keys (${KEYS_CITE}):`);
console.log(`  mainnet ${AUDITOR_KEYS.mainnet}`);
console.log(`  sepolia ${AUDITOR_KEYS.sepolia}\n`);

process.exit(counts[ERROR] || counts[WARN] ? 1 : 0);
