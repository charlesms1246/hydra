/**
 * Where a running stack records itself, so any later process — an agent command,
 * the TUI, another shell — can find it. Without this, `hydra-dev up` and
 * `hydra-dev indexer --status` are unrelated programs.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const HYDRA_HOME = process.env.HYDRA_HOME ?? join(homedir(), ".hydra");
const STATE = join(HYDRA_HOME, "state.json");

export async function writeState(s) {
  await mkdir(HYDRA_HOME, { recursive: true });
  await writeFile(STATE, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * `HYDRA_RPC` points the READ commands at any Starknet node.
 *
 * core/src/chain.mjs was always RPC-generic — it reads whatever URL the state carries, and
 * `devnetUrl` is a name rather than a constraint. Verified against Sepolia and mainnet.
 * Without this there was no supported way to say so: reaching a public node meant
 * hand-writing a state file, so a real capability was unreachable from the README.
 *
 * `rpcOverride` is carried on the state so WRITE paths can refuse it. A flag that let
 * `faucet` or the control API address a public node would be a shipped footgun, and
 * "the RPC would reject it anyway" is not a defence — see wallets.mjs and transact.mjs.
 */
export function rpcOverride() {
  return process.env.HYDRA_RPC || null;
}

export async function readState() {
  const override = rpcOverride();
  let st = null;
  try {
    st = JSON.parse(await readFile(STATE, "utf8"));
  } catch {
    st = null;
  }
  if (!override) return st;
  // Usable with no stack at all: reading a public node needs a URL and nothing else.
  return { ...(st ?? {}), devnetUrl: override, rpcOverride: override };
}

export async function clearState() {
  await rm(STATE, { force: true });
}

/** A pid we recorded is only meaningful if that process still exists. */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
