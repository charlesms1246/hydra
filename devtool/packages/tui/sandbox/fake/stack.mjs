/**
 * `startStack`/`stopStack` without spawning anything.
 *
 * The real ones fork `hydra-dev up`, which is exactly what the sandbox exists to avoid.
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

/** Devnet fixes its account set at spawn, so a restart is the only way to get more. */
function grow(w, want) {
  while (w.accounts.length < want) {
    const i = w.accounts.length;
    const address = `0x${(0xacc0 + i).toString(16)}`;
    w.accounts.push({ name: `account-${i}`, address });
    w.balances[address] = Object.fromEntries(Object.values(w.tokens).map((t) => [t, 0n]));
  }
}

export async function isRunning() {
  return world().running;
}

/**
 * `env` is honoured, not merely accepted.
 *
 * It was previously not even in the signature, so `app.mjs:711` — the wallets page's `+`,
 * which restarts with one more devnet account — passed `{ HYDRA_ACCOUNTS: n }` into a double
 * that dropped it, and the sandbox reported success for a restart that changed nothing. A
 * fake that cannot disagree with the code cannot test it. `packages/tui/test/fakes.mjs` now
 * compares this signature against the real one so the next drift fails instead of passing.
 */
export function startStack(onLine = () => {}, env = {}) {
  const w = world();
  const want = Number(env.HYDRA_ACCOUNTS);
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.exitCode = 0; child.emit("close", 0); return true; };

  let i = 0;
  const timer = setInterval(() => {
    if (i < BOOT.length) return onLine(BOOT[i++]);
    clearInterval(timer);
    if (Number.isInteger(want) && want > w.accounts.length) grow(w, want);
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
