/**
 * Compiling, testing and deploying the pool — the commands, and how to read them.
 *
 * Most of "build" already existed, as *repair*: `pins.mjs` holds the exact commands,
 * `doctor.mjs` turns each artifact into a row carrying `{cmd, cwd}`, and `install.mjs`
 * `runFix` already spawns and streams. But `fixable()` filters on `status !== "ok"`,
 * so a missing artifact could be healed and a present one could not be rebuilt. That
 * is the gap this closes, along with testing, which did not exist at all.
 *
 * Durations below were measured on this machine with a warm cache, and are here so
 * the UI can say "this takes about a minute" instead of appearing to hang.
 *
 * The operation LIST is discovered, not typed: `discoverOperations` reads the
 * workspace manifests, so a package added upstream appears here without an edit.
 * What stays hand-written is the metadata that cannot be read off a manifest — a
 * measured duration, and which artifact proves a build ran. `OPERATIONS` below is
 * what discovery falls back to when there is no checkout to read.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {{id, group, label, cmd, cwd, seconds, mutates, artifact}} Op
 */

/** The operation table. `cwd` is resolved against the upstream checkout by the caller. */
export const OPERATIONS = [
  { id: "pool", group: "build", label: "pool contracts", seconds: 6,
    cmd: "scarb build -p privacy -p vesu_lending_anonymizer -p ekubo_swap_anonymizer -p shadow_account_anonymizer",
    artifact: "target/dev/privacy_Privacy.contract_class.json",
    mutates: "target/dev/*.contract_class.json" },
  { id: "pool-tests", group: "build", label: "pool test targets", seconds: 2,
    cmd: "scarb build -t -p privacy -p shadow_account_anonymizer",
    artifact: "target/dev/privacy_unittest.test.starknet_artifacts.json",
    mutates: "target/dev/*_unittest.*" },
  { id: "e2e-contracts", group: "build", label: "e2e contracts", seconds: 3,
    // vesu pins a different Cairo version; upstream hides this behind `asdf exec scarb`.
    cmd: "(cd e2e/contracts/test-token && scarb build) && (cd e2e/contracts/ekubo && scarb build) && (cd e2e/contracts/vesu && scarb build --ignore-cairo-version)",
    artifact: "e2e/contracts/test-token/target/dev/test_token_TestToken.contract_class.json",
    mutates: "e2e/contracts/*/target/" },
  { id: "discovery-service", group: "build", label: "discovery service", seconds: 2,
    cmd: "cargo build --release -p discovery-service",
    artifact: "target/release/discovery-service", mutates: "target/release/discovery-service" },

  { id: "test-all", group: "test", label: "all packages", seconds: 37, cmd: "snforge test",
    mutates: null },
  { id: "test-privacy", group: "test", label: "privacy", seconds: 33, cmd: "snforge test -p privacy",
    mutates: null },
  { id: "test-shadow", group: "test", label: "shadow_account_anonymizer", seconds: 6,
    cmd: "snforge test -p shadow_account_anonymizer", mutates: null },
  { id: "test-ekubo", group: "test", label: "ekubo_swap_anonymizer", seconds: 3,
    cmd: "snforge test -p ekubo_swap_anonymizer", mutates: null },
  { id: "test-vesu", group: "test", label: "vesu_lending_anonymizer", seconds: 8,
    cmd: "snforge test -p vesu_lending_anonymizer", mutates: null },
];

/**
 * Measured seconds, by package. Read off real runs on this machine; a package with
 * no entry gets no estimate rather than a made-up one, and the UI says "unmeasured".
 */
const MEASURED = {
  privacy: { build: 6, test: 33 },
  shadow_account_anonymizer: { build: 2, test: 6 },
  ekubo_swap_anonymizer: { build: 2, test: 3 },
  vesu_lending_anonymizer: { build: 2, test: 8 },
  test_token: { build: 1 },
  ekubo_contracts: { build: 1 },
  vesu_contracts: { build: 2 },
  "discovery-service": { build: 2 },
  // The whole-workspace runs, measured as themselves. Summing the per-package
  // figures overstates both: one `scarb build` compiles the shared dependency once
  // where four separate ones compile it four times.
  __workspace__: { build: 6, test: 37 },
};

/** The file whose existence proves a package built. Only the ones doctor also checks. */
const ARTIFACT = {
  privacy: "target/dev/privacy_Privacy.contract_class.json",
  test_token: "e2e/contracts/test-token/target/dev/test_token_TestToken.contract_class.json",
  "discovery-service": "target/release/discovery-service",
};

const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };

/** `members = [ "a", "b" ]` out of a workspace manifest. Not a TOML parser. */
function members(text) {
  const m = /\[workspace\][\s\S]*?members\s*=\s*\[([^\]]*)\]/.exec(text ?? "");
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** `[package] name = "x"` — the first `name` at the top level, which is the package's. */
function packageName(text) {
  const m = /\[package\][\s\S]*?\bname\s*=\s*"([^"]+)"/.exec(text ?? "");
  return m ? m[1] : null;
}

/** The `starknet = "2.17.0"` a manifest pins, workspace-level or package-level. */
function cairoDep(text) {
  const m = /^\s*starknet\s*=\s*"([^"]+)"/m.exec(text ?? "");
  return m ? m[1] : null;
}

/**
 * Every buildable and testable component in the checkout, read from its manifests.
 *
 * Three sources, because upstream has three: the Cairo workspace's `members`, the
 * standalone `e2e/contracts/*` packages (each its own workspace, which is why they
 * cannot be built from the root), and the Cargo workspace's crates — of which only
 * the ones with a `src/main.rs` produce a binary worth building.
 *
 * Returns `OPERATIONS` unchanged when there is no readable checkout, so the Build
 * page has something to show before `hydra-dev bootstrap` has ever run.
 */
export function discoverOperations(upstream) {
  const root = read(join(upstream, "Scarb.toml"));
  if (!root) return OPERATIONS;

  const ops = [];
  const secs = (name, kind) => MEASURED[name]?.[kind] ?? null;

  // ---- the Cairo workspace ------------------------------------------------
  const pkgs = [];
  for (const dir of members(root)) {
    const name = packageName(read(join(upstream, dir, "Scarb.toml")));
    if (name) pkgs.push({ name, dir });
  }
  if (pkgs.length > 1) {
    ops.push({ id: "build:workspace", group: "build", label: "all pool packages", dir: ".",
      cmd: `scarb build ${pkgs.map((p) => `-p ${p.name}`).join(" ")}`,
      seconds: secs("__workspace__", "build"),
      artifact: ARTIFACT.privacy, mutates: "target/dev/*.contract_class.json" });
    ops.push({ id: "build:test-targets", group: "build", label: "test targets", dir: ".",
      cmd: "scarb build -t", seconds: 2,
      artifact: "target/dev/privacy_unittest.test.starknet_artifacts.json",
      mutates: "target/dev/*_unittest.*" });
  }
  for (const p of pkgs) {
    ops.push({ id: `build:${p.name}`, group: "build", label: p.name, dir: ".",
      cmd: `scarb build -p ${p.name}`, seconds: secs(p.name, "build"),
      artifact: ARTIFACT[p.name] ?? null, mutates: "target/dev/" });
  }

  // ---- the e2e contracts, each its own workspace --------------------------
  const rootCairo = cairoDep(root);
  let e2eDirs = [];
  try {
    e2eDirs = readdirSync(join(upstream, "e2e/contracts"), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { e2eDirs = []; }
  for (const d of e2eDirs) {
    const text = read(join(upstream, "e2e/contracts", d, "Scarb.toml"));
    const name = packageName(text);
    if (!name) continue;
    // A package pinning a different Cairo than the workspace will not build without
    // this flag. Derived from the two manifests rather than remembered per package,
    // because the thing that makes it necessary is the mismatch itself.
    const pinned = cairoDep(text);
    const flag = pinned && rootCairo && pinned !== rootCairo ? " --ignore-cairo-version" : "";
    ops.push({ id: `build:e2e:${name}`, group: "build", label: `e2e ${name}`,
      dir: `e2e/contracts/${d}`, cmd: `scarb build${flag}`, seconds: secs(name, "build"),
      artifact: ARTIFACT[name] ?? null, mutates: `e2e/contracts/${d}/target/` });
  }

  // ---- the Cargo workspace ------------------------------------------------
  for (const dir of members(read(join(upstream, "Cargo.toml")))) {
    const name = packageName(read(join(upstream, dir, "Cargo.toml")));
    if (!name) continue;
    // A library crate has nothing to run; `hydra-dev up` spawns the binary, so a build
    // op for a crate with no `src/main.rs` would be a button with no consequence.
    try { statSync(join(upstream, dir, "src/main.rs")); } catch { continue; }
    ops.push({ id: `build:cargo:${name}`, group: "build", label: name, dir: ".",
      cmd: `cargo build --release -p ${name}`, seconds: secs(name, "build"),
      artifact: ARTIFACT[name] ?? null, mutates: `target/release/${name}` });
  }

  // ---- tests --------------------------------------------------------------
  if (pkgs.length) {
    ops.push({ id: "test:all", group: "test", label: "all packages", dir: ".",
      cmd: "snforge test", seconds: secs("__workspace__", "test"),
      artifact: null, mutates: null });
  }
  for (const p of pkgs) {
    ops.push({ id: `test:${p.name}`, group: "test", label: p.name, dir: ".",
      cmd: `snforge test -p ${p.name}`, seconds: secs(p.name, "test"),
      artifact: null, mutates: null });
  }

  return ops.length ? ops : OPERATIONS;
}

/**
 * Is the deployed pool older than the artifact on disk?
 *
 * The only deploy path in this repo is `hydra-dev up`: `sdk/src/testing/devnet.ts` reads
 * `target/dev/privacy_Privacy.contract_class.json` and deploys it inside
 * `Devnet.initialize()`. So "deploy" is a restart, and the fact worth surfacing —
 * which nothing surfaced before — is that the running chain may be executing older
 * code than the file you just rebuilt.
 */
export function deployState(upstream, startedAt) {
  const file = join(upstream, "target/dev/privacy_Privacy.contract_class.json");
  let built;
  try {
    built = statSync(file).mtimeMs;
  } catch {
    return { state: "no-artifact", detail: "pool contracts are not built" };
  }
  if (!startedAt) return { state: "not-running", detail: "no stack — u starts one", builtAt: built };
  const up = Date.parse(startedAt);
  return built > up
    ? { state: "stale", builtAt: built, startedAt: up,
        detail: "the running pool predates this artifact — restart to deploy it" }
    : { state: "current", builtAt: built, startedAt: up, detail: "the running pool is this artifact" };
}

const RE = {
  collected: /^Collected (\d+) test\(s\) from (\S+) package$/,
  pass: /^\[PASS\] (\S+)(?: \(l1_gas: ~(\d+), l1_data_gas: ~(\d+), l2_gas: ~(\d+)\))?$/,
  ignore: /^\[IGNORE\] (\S+)$/,
  fail: /^\[FAIL\] (\S+)$/,
  tests: /^Tests: (\d+) passed, (\d+) failed, (\d+) ignored, (\d+) filtered out/,
  summary: /^Tests summary: (\d+) passed, (\d+) failed, (\d+) ignored, (\d+) filtered out/,
};

/**
 * Parse snforge's stdout. There is no `--json` at 0.63.0 — `--help` offers only
 * `--color`, `--detailed-resources` and `--gas-report` — so this reads the seven
 * line shapes it actually emits.
 *
 * The trap worth naming: a SINGLE-package run prints one `Tests:` line, and a
 * MULTI-package run prints one per package plus a final `Tests summary:`. A parser
 * that knows only `Tests:` reports the last package's numbers as the whole run.
 */
export function parseSnforge(text) {
  const out = { kind: "snforge", packages: [], tests: [], totals: null, failures: [] };
  let pkg = null;
  let inFailures = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\[[0-9;]*m/g, "").trimEnd();
    if (/^Failures:/.test(line)) { inFailures = true; continue; }
    if (inFailures) {
      if (/^\s{4}\S/.test(line)) { out.failures.push(line.trim()); continue; }
      if (line.trim()) inFailures = false;
    }
    let m;
    if ((m = RE.collected.exec(line))) {
      pkg = { name: m[2], collected: Number(m[1]), passed: 0, failed: 0, ignored: 0, filtered: 0 };
      out.packages.push(pkg);
    } else if ((m = RE.pass.exec(line))) {
      out.tests.push({ name: m[1], status: "PASS",
        gas: m[2] ? { l1: Number(m[2]), l1Data: Number(m[3]), l2: Number(m[4]) } : null });
    } else if ((m = RE.ignore.exec(line))) {
      out.tests.push({ name: m[1], status: "IGNORE", gas: null });
    } else if ((m = RE.fail.exec(line))) {
      out.tests.push({ name: m[1], status: "FAIL", gas: null });
    } else if ((m = RE.summary.exec(line))) {
      out.totals = { passed: +m[1], failed: +m[2], ignored: +m[3], filtered: +m[4] };
    } else if ((m = RE.tests.exec(line))) {
      // A `Tests:` line with no `Collected` before it happens when a filter matches
      // nothing; without this the counts are dropped and "nothing ran" loses the
      // number that explains it.
      if (!pkg) { pkg = { name: "(filtered)", collected: 0, passed: 0, failed: 0, ignored: 0, filtered: 0 }; out.packages.push(pkg); }
      Object.assign(pkg, { passed: +m[1], failed: +m[2], ignored: +m[3], filtered: +m[4] });
    }
  }
  if (!out.totals) {
    // No `Tests summary:` means a single-package run; sum what we saw.
    out.totals = out.packages.reduce(
      (t, p) => ({ passed: t.passed + p.passed, failed: t.failed + p.failed,
        ignored: t.ignored + p.ignored, filtered: t.filtered + p.filtered }),
      { passed: 0, failed: 0, ignored: 0, filtered: 0 }
    );
  }
  return out;
}

/**
 * Did this run actually verify anything?
 *
 * snforge exits 0 when a filter matches zero tests, so the exit code alone cannot
 * tell "everything passed" from "nothing ran". Measured, not assumed.
 */
export function verdictOf(result, exitCode) {
  const t = result?.totals ?? { passed: 0, failed: 0, filtered: 0 };
  if (t.failed > 0) return { ok: false, text: `${t.failed} failed` };
  if (t.passed === 0) return { ok: false, text: `nothing ran (${t.filtered} filtered out)` };
  return { ok: exitCode === 0, text: `${t.passed} passed${t.ignored ? `, ${t.ignored} ignored` : ""}` };
}

/**
 * Run one operation, streaming each line.
 *
 * Deliberately mirrors `install.mjs` `runFix` rather than sharing it: that one is
 * bound to a doctor row, and these are bound to the operation table. Both show the
 * exact command first, which is the posture install.mjs sets out and this keeps.
 */
export function runOperation(op, cwd, onLine = () => {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    onLine(`$ ${op.cmd}`);
    const chunks = [];
    const child = spawn(op.cmd, {
      shell: true,
      cwd,
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
    });
    const feed = (buf) => {
      chunks.push(buf.toString());
      for (const l of buf.toString().split("\n")) {
        const t = l.replace(/\r/g, "").trimEnd();
        if (t) onLine(t);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => resolve({ ok: false, code: null, ms: Date.now() - started, error: e.message }));
    child.on("close", (code) => {
      const text = chunks.join("");
      const parsed = op.group === "test" ? parseSnforge(text) : null;
      const verdict = parsed ? verdictOf(parsed, code) : { ok: code === 0, text: code === 0 ? "built" : `exit ${code}` };
      resolve({ ok: verdict.ok, code, ms: Date.now() - started, parsed, verdict });
    });
  });
}
