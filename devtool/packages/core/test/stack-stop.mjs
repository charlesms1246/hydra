/**
 * `stopStack()` reports a stop only when it stopped something.
 *
 * The bug these reproduce: two different no-ops both returned `{ ok: true, killed: [] }`, and
 * every one of the three call sites renders that as `signalled nothing` beside a success.
 *
 *  - `readState()` synthesises a record from `HYDRA_RPC` so read commands work with no stack,
 *    so `if (!st)` could never fire. No state file at all plus an override reported success.
 *  - A record whose pids are dead reported success too, and this one needs no override — it is
 *    what `down` did after any stack died on its own. That path deletes `state.json`, which is
 *    what made this worth fixing rather than noting.
 *
 * The property is NOT "it refuses under an override". Refusing whenever `HYDRA_RPC` is set
 * would break stopping a real stack from a shell that happens to export it, so the last case
 * asserts a real record with a LIVE pid is still stopped with the override present. A guard
 * that only checked the override would pass every other check here.
 *
 * The live-pid cases use a real child process the test spawns and reaps itself. A fake pid
 * cannot distinguish "signalled it" from "found it dead", which is the whole distinction.
 */

import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOME = mkdtempSync(join(tmpdir(), "hydra-stopstack-"));
process.env.HYDRA_HOME = HOME;
const FILE = join(HOME, "state.json");

const { stopStack } = await import("../src/stack.mjs");

let failed = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (e) {
    console.log(`FAIL  ${name}  — ${e.message}`);
    failed++;
  }
};

const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const reset = () => { if (existsSync(FILE)) rmSync(FILE); delete process.env.HYDRA_RPC; };
const record = (s) => writeFileSync(FILE, JSON.stringify(s));

/** A process that ignores nothing and outlives the check unless signalled. */
function sleeper() {
  const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  return c;
}
const gone = (c) => new Promise((r) => c.once("exit", () => r(true)));

await check("no state file and an override is not a recorded stack", async () => {
  reset();
  process.env.HYDRA_RPC = "https://rpc.example.org/x";
  const r = await stopStack();
  eq(r.ok, false, "ok");
  eq(r.reason, "no recorded stack", "reason");
  return "ok: false — the guard `if (!st)` could not reach this before";
});

await check("no state file and no override still refuses", async () => {
  reset();
  const r = await stopStack();
  eq(r.ok, false, "ok");
  eq(r.reason, "no recorded stack", "reason");
  return "the path that always worked, unchanged";
});

await check("a record whose pids are dead is not a stop", async () => {
  reset();
  const c = sleeper();
  const dead = c.pid;
  c.kill("SIGKILL");
  await gone(c);
  record({ indexerPid: dead, devnetPid: dead, devnetUrl: "http://127.0.0.1:5050" });
  const r = await stopStack();
  eq(r.ok, false, "ok");
  eq(r.cleared, true, "cleared");
  eq(existsSync(FILE), false, "stale record removed");
  return "ok: false, cleared: true — tidied without claiming a stop";
});

await check("a live recorded pid is signalled and reported as a stop", async () => {
  reset();
  const c = sleeper();
  const exited = gone(c);   // attached BEFORE the signal: a listener added after it lands never fires
  record({ indexerPid: c.pid, devnetUrl: "http://127.0.0.1:5050" });
  const r = await stopStack();
  eq(r.ok, true, "ok");
  eq(r.killed.length, 1, "killed");
  eq(await exited, true, "the child actually exited");
  eq(existsSync(FILE), false, "state cleared after a real stop");
  return `killed ${r.killed[0]}`;
});

await check("an override does NOT block stopping a real stack", async () => {
  reset();
  process.env.HYDRA_RPC = "https://rpc.example.org/x";
  const c = sleeper();
  const exited = gone(c);
  record({ indexerPid: c.pid, devnetUrl: "http://127.0.0.1:5050" });
  const r = await stopStack();
  eq(r.ok, true, "ok");
  eq(r.killed.length, 1, "killed");
  eq(await exited, true, "the child actually exited");
  return "a guard on `HYDRA_RPC` alone would have failed this";
});

reset();
rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nstack-stop: all checks pass");
process.exit(failed ? 1 : 0);
