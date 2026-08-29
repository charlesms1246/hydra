/**
 * Starting and stopping the stack as a managed child process.
 *
 * `hydra up` holds devnet in its own process and tears it down on SIGTERM, so
 * supervising it is a matter of spawning it and signalling it — not
 * reimplementing any of it here.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readState, clearState, pidAlive } from "./state.mjs";
import { probeDevnet } from "./probe.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "..", "cli", "src", "cli.mjs");

/** A stack is running if state points at a devnet that answers. */
export async function isRunning() {
  const st = await readState();
  if (!st) return false;
  return (await probeDevnet(st.devnetUrl)).up;
}

/**
 * Spawns `hydra up`. Returns the child plus a stop() that signals it and waits.
 * Output is streamed through onLine so a caller can show progress — bringing the
 * stack up takes tens of seconds and silence reads as a hang.
 */
export function startStack(onLine = () => {}) {
  const child = spawn(process.execPath, [CLI, "up"], {
    env: { ...process.env, HYDRA_QUIET: "1", PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const feed = (buf) => {
    for (const line of buf.toString().split("\n")) {
      const t = line.replace(/\r/g, "").trimEnd();
      if (t) onLine(t);
    }
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.on("error", (e) => onLine(`failed to start: ${e.message}`));

  return {
    child,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) return resolve();
        child.once("close", () => resolve());
        child.kill("SIGTERM");
        // up's handler cleans up devnet and the indexer; if it hangs, insist.
        setTimeout(() => child.killed || child.kill("SIGKILL"), 8000);
      }),
  };
}

/** Stops a stack this process did not start, using the pids it recorded. */
export async function stopStack() {
  const st = await readState();
  if (!st) return { ok: false, reason: "no recorded stack" };
  const killed = [];
  for (const [name, pid] of [["indexer", st.indexerPid], ["devnet", st.devnetPid]]) {
    if (pidAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); killed.push(`${name}:${pid}`); } catch { /* gone */ }
    }
  }
  await clearState();
  return { ok: true, killed };
}
