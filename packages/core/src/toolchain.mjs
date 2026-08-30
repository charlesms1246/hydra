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
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
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
 * Is the deployed pool older than the artifact on disk?
 *
 * The only deploy path in this repo is `hydra up`: `sdk/src/testing/devnet.ts` reads
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
