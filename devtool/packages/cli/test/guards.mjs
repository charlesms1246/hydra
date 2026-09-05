/**
 * Every write path refuses an `--rpc` override, asserted against source.
 *
 * **`LOCAL_ONLY` IS THE THING STANDING BETWEEN THE OVERRIDE AND EVERY MUTATING OPERATION**, and
 * until now it was a hand-maintained list of five command names with nothing checking it. Add a
 * write command, forget the list, and the class reopens **silently** — no behavioural test fails,
 * because the failure is an omission. That is the same reason the platform lane asserts its
 * front-end parity against source: *no behavioural test can assert the absence of a call that was
 * never written.*
 *
 * **AND THE OMISSION WAS ALREADY THERE.** `wallets.mjs:13` defines `REFUSAL_TEXT` with the comment
 * *"One wording, three call sites."* It has **one**. `faucet` refuses the override; `addToken`,
 * `removeToken` and `exportWallets` do not, and all three are reachable from the shipped TUI
 * (`keymap.mjs:101-104`), which is not in `LOCAL_ONLY` because it is one command that contains
 * many. Driven through the installed tarball with `--rpc` pointed at mainnet:
 *
 *     addToken under --rpc: ACCEPTED
 *     resulting state.json, with no env var set:
 *       devnetUrl: https://api.cartridge.gg/x/starknet/mainnet
 *
 * The override is **persisted into the state file**, so `hydra-dev devnet` then reports mainnet as
 * `● devnet up` — on a later run, with nothing set. A read-only escape hatch became durable
 * configuration by way of a write path that never refused it.
 *
 * The checks below are structural on purpose: they read the source and require that every
 * `writeState(` call site sits in a function that first consults `rpcOverride`. A guard that
 * checked behaviour would need to know which functions exist, which is exactly what an omission
 * hides.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = join(HERE, "..", "..");

let failed = 0;
const check = (name, fn) => {
  try {
    const detail = fn();
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (e) {
    console.log(`FAIL  ${name}  — ${e.message}`);
    failed++;
  }
};

/** Every `.mjs` under packages/, excluding installed dependencies and test doubles. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "sandbox" || e.name === "fixtures") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs") && statSync(p).size > 0) out.push(p);
    }
  };
  walk(PKGS);
  return out.sort();
}

const rel = (f) => f.slice(f.indexOf("packages"));

/** Source with block comments and whole-line `//` removed — a comment is not a call. */
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

// The instrument before the finding: if this reads nothing, everything below passes vacuously.
check("the scanner reads every source file it claims to scan", () => {
  const files = sources();
  if (files.length < 20) throw new Error(`only ${files.length} sources found — the scan is broken`);
  for (const f of files) {
    if (readFileSync(f, "utf8").length === 0) throw new Error(`${rel(f)} read as empty`);
  }
  return `${files.length} files`;
});

check("every writeState call site is in a file that consults rpcOverride", () => {
  const offenders = [];
  for (const f of sources()) {
    const code = codeOf(readFileSync(f, "utf8"));
    if (!/\bwriteState\s*\(/.test(code)) continue;
    // `up.mjs` is the stack lifecycle itself and is refused at the CLI boundary by LOCAL_ONLY;
    // it is the one file whose whole job is to create the state an override would contradict.
    if (rel(f).endsWith("cli/src/up.mjs")) continue;
    if (!/rpcOverride/.test(code)) offenders.push(rel(f));
  }
  if (offenders.length) {
    throw new Error(`writes state without ever consulting rpcOverride: ${offenders.join(", ")}`);
  }
  return "wallets.mjs";
});

check("EVERY exported function that writes state refuses the override first", () => {
  // The finer check, and the one that catches the real defect: a FILE can mention `rpcOverride`
  // while individual functions in it do not. `wallets.mjs` did exactly that — `faucet` refused
  // and `addToken`/`removeToken` wrote regardless.
  const offenders = [];
  for (const f of sources()) {
    const code = codeOf(readFileSync(f, "utf8"));
    if (!/\bwriteState\s*\(/.test(code)) continue;
    if (rel(f).endsWith("cli/src/up.mjs")) continue;
    // `state.mjs` DEFINES `writeState`; it is the primitive, not a caller of it.
    if (rel(f).endsWith("core/src/state.mjs")) continue;
    // Split on export boundaries, so each function is judged on its own body.
    const parts = code.split(/(?=^export\s+(?:async\s+)?function\s)/m);
    for (const part of parts) {
      const name = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/m.exec(part)?.[1];
      if (!name || !/\bwriteState\s*\(/.test(part)) continue;
      if (!/rpcOverride/.test(part)) offenders.push(`${rel(f)}:${name}`);
    }
  }
  if (offenders.length) {
    throw new Error(`write state without refusing an --rpc override: ${offenders.join(", ")}`);
  }
  return "all write paths refuse";
});

check("LOCAL_ONLY names every CLI command that reaches a write path", () => {
  const cli = codeOf(readFileSync(join(PKGS, "cli", "src", "cli.mjs"), "utf8"));
  const listed = /LOCAL_ONLY\s*=\s*\[([^\]]*)\]/.exec(cli)?.[1];
  if (!listed) throw new Error("LOCAL_ONLY is gone or no longer a literal array");
  const names = [...listed.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const required of ["up", "down", "init", "bootstrap", "faucet"]) {
    if (!names.includes(required)) throw new Error(`${required} left LOCAL_ONLY`);
  }
  return names.join(" ");
});

check("EVERY exported function that writes a file under HYDRA_HOME refuses the override", () => {
  // `writeState` is not the only way to persist. `exportWallets` writes `wallets-*.json` into
  // $HYDRA_HOME, and under `--rpc` with no stack it produced a document titled "wallets" holding
  // zero accounts and `devnetUrl: <the mainnet endpoint>`. A narrower check than the state one,
  // scoped to files this tool places in its own home directory.
  // NARROWED, AND THE NARROWING IS THE INTERESTING PART. The first version flagged
  // `flows.mjs:saveFlow` and `forgetFlow`, and they are NOT defects: a saved flow is deliberately
  // independent of any stack — `flows.mjs:4-6` says it is kept out of `state.json` precisely so
  // that `hydra-dev down` cannot destroy it. A flow is the user's own document, not a description
  // of a chain, so an override has nothing to contradict. `state.mjs:writeState` is the primitive.
  //
  // What is in scope is a file whose CONTENT describes the stack. `exportWallets` writes
  // `devnetUrl` and `poolAddress` into it, which is exactly the thing an override falsifies.
  const DESCRIBES_THE_STACK = /devnetUrl|poolAddress/;
  const offenders = [];
  for (const f of sources()) {
    const code = codeOf(readFileSync(f, "utf8"));
    if (!/writeFile\s*\(/.test(code) || !/HYDRA_HOME/.test(code)) continue;
    if (rel(f).endsWith("core/src/state.mjs")) continue;
    const parts = code.split(/(?=^export\s+(?:async\s+)?function\s)/m);
    for (const part of parts) {
      const name = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/m.exec(part)?.[1];
      if (!name || !/writeFile\s*\(/.test(part)) continue;
      if (!DESCRIBES_THE_STACK.test(part)) continue;
      if (!/rpcOverride/.test(part)) offenders.push(`${rel(f)}:${name}`);
    }
  }
  if (offenders.length) {
    throw new Error(`write a file describing the stack without refusing an override: ${offenders.join(", ")}`);
  }
  return "all file writes refuse";
});

check("the refusal wording is shared, and its comment matches its use", () => {
  // `REFUSAL_TEXT`'s comment claimed "three call sites" while having one. A comment that counts
  // its own uses is checkable, and this one was wrong in the direction that hid a gap.
  const src = readFileSync(join(PKGS, "core", "src", "wallets.mjs"), "utf8");
  const claimed = /One wording, (\w+) call sites/.exec(src)?.[1];
  if (!claimed) return "no count claimed";
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const uses = (codeOf(src).match(/REFUSAL_TEXT\(/g) ?? []).length;
  if (words[claimed] !== uses) {
    throw new Error(`comment says ${claimed} call sites, source has ${uses}`);
  }
  return `${uses} call sites, as claimed`;
});

console.log(failed ? `\n${failed} failed` : "\nall guards pass");
process.exit(failed ? 1 : 0);
