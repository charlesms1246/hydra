/**
 * `startStack`/`stopStack` without spawning anything.
 *
 * The real ones fork `hydra up`, which is exactly what the sandbox exists to avoid.
 * `startStack` returns a real EventEmitter as `child` because app.mjs attaches a
 * `close` listener to it and clears its busy state from there — a plain object would
 * leave the TUI stuck on "starting…" forever, which is the bug this shape prevents.
 */

import { EventEmitter } from "node:events";
import { world } from "../state.mjs";

const BOOT = [
  "starting devnet and deploying the privacy pool…",
  "Predeployed accounts using class Custom",
  "Devnet running at: http://127.0.0.1:46507",
  "  starting local discovery service…",
  "  starting control API…",
  "  STACK UP — nothing here is hosted.",
];

export async function isRunning() {
  return world().running;
}

export function startStack(onLine = () => {}) {
  const w = world();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.exitCode = 0; child.emit("close", 0); return true; };

  let i = 0;
  const timer = setInterval(() => {
    if (i < BOOT.length) return onLine(BOOT[i++]);
    clearInterval(timer);
    w.running = true;
    w.headAgeSecs = 0;
    w.note("stack up (sandbox)");
  }, 350);

  return {
    child,
    stop: async () => {
      clearInterval(timer);
      w.running = false;
      w.note("stack stopped (sandbox)");
      if (child.exitCode === null) { child.exitCode = 0; child.emit("close", 0); }
    },
  };
}

export async function stopStack() {
  const w = world();
  if (!w.running) return { ok: false, reason: "no recorded stack" };
  w.running = false;
  w.note("stack stopped (sandbox)");
  return { ok: true, killed: ["devnet", "indexer"] };
}
