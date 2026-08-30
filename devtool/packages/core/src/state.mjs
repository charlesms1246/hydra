/**
 * Where a running stack records itself, so any later process — an agent command,
 * the TUI, another shell — can find it. Without this, `hydra up` and
 * `hydra indexer --status` are unrelated programs.
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

export async function readState() {
  try {
    return JSON.parse(await readFile(STATE, "utf8"));
  } catch {
    return null;
  }
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
