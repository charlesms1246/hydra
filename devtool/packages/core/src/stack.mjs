/**
 * Starting and stopping the stack as a managed child process.
 *
 * `hydra-dev up` holds devnet in its own process and tears it down on SIGTERM, so
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
 * Spawns `hydra-dev up`. Returns the child plus a stop() that signals it and waits.
 * Output is streamed through onLine so a caller can show progress — bringing the
 * stack up takes tens of seconds and silence reads as a hang.
 */
export function startStack(onLine = () => {}, env = {}) {
  const child = spawn(process.execPath, [CLI, "up"], {
    env: { ...process.env, ...env, HYDRA_QUIET: "1", PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
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
        // up's handler cleans up devnet and the indexer; if it hangs, insist.
        // Gated on actual liveness, not on child.killed: Node sets `killed` the
        // moment a signal is DELIVERED, so `child.killed || kill("SIGKILL")` was
        // always short-circuit-true after the SIGTERM above and never escalated —
        // a child that ignores SIGTERM outlived the TUI and was reparented.
        const hard = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 8000);
        child.once("close", () => { clearTimeout(hard); resolve(); });
        child.kill("SIGTERM");
      }),
  };
}

/**
 * Stops a stack this process did not start, using the pids it recorded.
 *
 * `ok` MEANS A STACK WAS STOPPED, and it did not used to. Two paths returned
 * `{ ok: true, killed: [] }` for a no-op, and the caller could not tell them from a stop:
 *
 *  - **Nothing recorded at all.** `if (!st)` cannot fire when `HYDRA_RPC` is set, because
 *    `readState()` synthesises a record from the override so read commands work with no
 *    stack. Reproduced: no state file plus an override gave `{ ok: true, killed: [] }`.
 *  - **A record whose pids are already dead.** Nothing to signal, and this one needs no
 *    override to reach — it is what `hydra-dev down` did after any stack died on its own.
 *
 * The second is the one that deletes a file, so it still clears: a stale record left behind
 * makes the next `stack_status` report a stack that is gone, which is why `clearState()` was
 * unconditional in the first place. Clearing it is safe — every pid in it is dead, so nobody's
 * stack is being taken away. **The defect was never the delete; it was reporting it as a
 * stop.** `cleared` says the record was tidied and `ok: false` says nothing was running, so
 * `packages/mcp/src/control.mjs:220`'s warning — *"if another shell started that stack, this
 * stopped theirs"* — now describes only the path where that is actually true.
 *
 * Guarded here rather than at the three call sites. `hydra-dev down` already refuses
 * `HYDRA_RPC` outright (cli.mjs:32, `LOCAL_ONLY`); MCP `stack_stop` demands `confirm: true`
 * but never looks at the override; the TUI's `p` has no guard at all, and MCP is withheld from
 * the distribution, so `p` is the one unguarded route in the PUBLISHED package. Three surfaces,
 * three different answers to one question that belongs to the function owning the state file.
 */
export async function stopStack() {
  const st = await readState();
  if (!st || st.synthesised) return { ok: false, reason: "no recorded stack" };
  const killed = [];
  for (const [name, pid] of [["indexer", st.indexerPid], ["devnet", st.devnetPid]]) {
    if (pidAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); killed.push(`${name}:${pid}`); } catch { /* gone */ }
    }
  }
  await clearState();
  if (!killed.length) return { ok: false, reason: "a recorded stack, already gone — cleared the stale record", cleared: true };
  return { ok: true, killed };
}
