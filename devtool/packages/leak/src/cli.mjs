#!/usr/bin/env node
/**
 * hydra-dev leak — prints the disclosure set of a planned transaction.
 *
 * Exit codes: 0 report produced, 2 bad invocation. There is deliberately no non-zero
 * "leaky" exit: a disclosure set is a description, not a verdict, and UNKNOWN cells are
 * a normal and expected result rather than a failure.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { whatDoesThisLeak } from "./leak.mjs";
import { FIELDS, PARTIES, UNKNOWN, NA, CLEAR, DECRYPTABLE } from "./facts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "examples");

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const positional = argv.filter((a) => a !== "--json");

function usage(msg) {
  if (msg) console.error(`hydra-dev leak: ${msg}`);
  console.error("usage: hydra-dev leak <tx.json> [--json]");
  console.error("       hydra-dev leak --example <name> [--json]");
  console.error("       hydra-dev leak - [--json]        (read JSON from stdin)");
  let names = [];
  try {
    names = readdirSync(examplesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    /* examples dir is optional */
  }
  if (names.length) console.error(`examples: ${names.join(", ")}`);
  process.exit(2);
}

let source;
let label;
if (positional[0] === "--example") {
  if (!positional[1]) usage("--example needs a name");
  label = `example:${positional[1]}`;
  try {
    source = readFileSync(join(examplesDir, `${positional[1]}.json`), "utf8");
  } catch {
    usage(`no such example: ${positional[1]}`);
  }
} else if (positional[0] === "-") {
  label = "stdin";
  source = readFileSync(0, "utf8");
} else if (positional.length === 1) {
  label = positional[0];
  try {
    source = readFileSync(positional[0], "utf8");
  } catch (e) {
    usage(e.message);
  }
} else {
  usage(positional.length === 0 ? "no input given" : "expected exactly one input");
}

let tx;
try {
  tx = JSON.parse(source);
} catch (e) {
  usage(`input is not valid JSON: ${e.message}`);
}

const report = whatDoesThisLeak(tx);

if (asJson) {
  console.log(JSON.stringify({ input: label, ...report }, null, 2));
  process.exit(0);
}

const COL = 16;
const MARK = {
  [CLEAR]: "CLEAR",
  [DECRYPTABLE]: "DECRYPTABLE",
  NOT_DISCLOSED_BY_THIS_TX: "not-by-this-tx",
  [UNKNOWN]: "UNKNOWN",
  [NA]: "--",
};

const wrap = (s, indent) =>
  s
    .replace(/(.{1,86})(\s|$)/g, `$1\n${" ".repeat(indent)}`)
    .trimEnd()
    .replace(/\n\s*$/, "");

console.log(`\nhydra-dev leak — disclosure set for ${label}`);
console.log(`upstream ${report.upstreamCommit}`);
console.log(
  `config: ${JSON.stringify({
    network: report.config.network ?? UNKNOWN,
    discovery: report.config.discovery ?? UNKNOWN,
    ohttp: report.config.ohttp ?? UNKNOWN,
    proving: report.config.proving ?? UNKNOWN,
  })}`
);

for (const p of report.problems) console.log(`\n  input problem: ${p}`);

for (const d of report.disclosures) {
  const a = d.action;
  const desc = [
    a.token ? `token=${a.token}` : null,
    a.amount !== undefined ? `amount=${a.amount}` : null,
    a.counterparty ? `counterparty=${a.counterparty}` : null,
    a.to ? `to=${a.to}` : null,
    a.contract ? `contract=${a.contract}` : null,
    a.via ? `via=${a.via}` : null,
    a.dapp ? `dapp=${a.dapp}` : null,
    a.opensChannel !== undefined ? `opensChannel=${a.opensChannel}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  console.log(`\n${"=".repeat(96)}`);
  console.log(`action ${d.index}: ${a.type}${desc ? `  (${desc})` : ""}`);
  console.log(`${"=".repeat(96)}`);
  console.log(`${"party".padEnd(28)}${FIELDS.map((f) => f.padEnd(COL)).join("")}`);
  for (const [key, name] of PARTIES) {
    const row = d.byParty[key];
    const cells = FIELDS.map((f) =>
      (MARK[row[f].disclosure] ?? row[f].disclosure).padEnd(COL)
    ).join("");
    console.log(`${name.padEnd(28)}${cells.trimEnd()}`);
  }
  console.log("");
  for (const [key, name] of PARTIES) {
    const row = d.byParty[key];
    // Collapse identical explanations; most party rows say one thing about all fields.
    const seen = new Map();
    for (const f of FIELDS) {
      const c = row[f];
      const k = `${c.disclosure}|${c.why}`;
      if (!seen.has(k)) seen.set(k, { ...c, fields: [] });
      seen.get(k).fields.push(f);
    }
    for (const c of seen.values()) {
      if (c.disclosure === NA) continue;
      console.log(`  ${name} — ${c.fields.join(", ")}: ${c.disclosure}`);
      console.log(`      ${wrap(c.why, 6)}`);
      console.log(`      source: ${c.cites.join("  |  ")}\n`);
    }
  }
}

console.log(`${"=".repeat(96)}`);
console.log("anonymity set");
console.log(`${"=".repeat(96)}`);
for (const s of report.anonymitySets) {
  console.log(`\n  action ${s.index} (${s.action}) — ${s.question}`);
  console.log(`  size: ${s.size}`);
  console.log(`      ${wrap(s.basis, 6)}`);
  console.log(`      source: ${s.cites.join("  |  ")}`);
}

console.log(`\n${"=".repeat(96)}`);
console.log("notes");
console.log(`${"=".repeat(96)}\n`);
for (const n of report.notes) {
  console.log(`  [${n.kind}] ${wrap(n.text, 6)}`);
  console.log(`      source: ${n.cites.join("  |  ")}\n`);
}

console.log(
  `${report.unknownCount} cell(s) are UNKNOWN. UNKNOWN is not a pass: it means this tool could ` +
    `not\ncompute the answer from what you declared, and the answer may be the bad one.\n`
);
