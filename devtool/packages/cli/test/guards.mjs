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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { check as doctorCheck, upstreamPath } from "../src/doctor.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = join(HERE, "..", "..");

let failed = 0;
const check_rows = () => doctorCheck().length;

const check = (name, fn) => {
  try {
    const detail = fn();
    // A check whose precondition does not hold reports SKIP, never PASS — counting an unexercised
    // path as green is the false-coverage failure this repo keeps finding. `render.mjs` already
    // does this; without it here a `{ skip }` return printed `PASS … [object Object]`.
    if (detail && typeof detail === "object" && detail.skip) {
      console.log(`SKIP  ${name}  — ${detail.skip}`);
      return;
    }
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

/**
 * The README states how many rows `doctor` prints. Run it and compare.
 *
 * ⚠ THIS IS A NUMBER IN PROSE ASSERTING SOMETHING THE CODE PRODUCES, which is the class this
 * repository keeps finding — and these two were wrong the moment a pin was added. `cargo` joined
 * `PINS` because `BUILD_HINTS.discoveryService` is `cargo build --release` and nothing checked
 * that the tool was present; the counts silently became eight and fourteen while the README still
 * said seven and thirteen.
 *
 * `web/test/site.test.ts` has the same shape for the website — "no hand-written sentence asserts a
 * number the code did not produce" — but it compares against a number produced in the same build.
 * This one is produced by RUNNING A COMMAND on a machine, and it differs by whether a checkout is
 * present, so the honest version runs it both ways.
 */
check("the README's doctor row counts are the counts doctor prints", () => {
  /*
   * Two preconditions, both reported as SKIP rather than failed — and the second one cost the
   * whole suite once. `test-run.mjs` aborts at the FIRST failing file and this is the first file
   * in its list, so a check that goes red on a missing precondition rather than a real defect
   * takes the other eight suites with it. It printed "0 of 9 test files ran".
   *
   * `README.md` sits at the repository root, above this package. A `git archive HEAD devtool`
   * does not contain it (the published package gets it from `prepack`).
   *
   * And the counts differ by whether an upstream checkout exists — that is what the sentence is
   * about — so with no checkout the "with" number cannot be produced at all. It printed 8/8 and
   * the guard read that as the README lying.
   */
  const readmePath = join(PKGS, "..", "..", "README.md");
  if (!existsSync(readmePath)) return { skip: "no README.md above this package" };
  if (!existsSync(join(upstreamPath(), "Scarb.toml"))) {
    return { skip: "no upstream checkout, so the with-checkout count cannot be produced" };
  }
  const readme = readFileSync(readmePath, "utf8");
  const words = { seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16 };
  const withText = /\*\*(\w+)\*\* once it does/.exec(readme)?.[1];
  const withoutText = /\*\*(\w+)\*\* before the checkout exists/.exec(readme)?.[1];
  if (!withText || !withoutText) throw new Error("the README no longer states both counts");

  const saved = process.env.HYDRA_UPSTREAM;
  let withRows, withoutRows;
  try {
    withRows = check_rows();
    // A path that cannot exist, so the `upstream checkout` row and the six artifact rows drop.
    process.env.HYDRA_UPSTREAM = join(PKGS, "..", "no-such-checkout-for-this-test");
    withoutRows = check_rows();
  } finally {
    if (saved === undefined) delete process.env.HYDRA_UPSTREAM;
    else process.env.HYDRA_UPSTREAM = saved;
  }

  if (words[withoutText] !== withoutRows || words[withText] !== withRows) {
    throw new Error(`README says ${withoutText}/${withText}, doctor prints ${withoutRows}/${withRows}`);
  }
  return `${withoutRows} without a checkout, ${withRows} with — as stated`;
});

console.log(failed ? `\n${failed} failed` : "\nall guards pass");
process.exit(failed ? 1 : 0);
