/**
 * Client for the control API that `hydra up` exposes.
 *
 * Every call runs a real transaction against the local pool: proving, the
 * 10-block maturity advance, and an outside execution. They take seconds, not
 * milliseconds, so callers must show progress.
 */

import { readState } from "./state.mjs";
import { fetchJson } from "./probe.mjs";

async function control(path, body, timeoutMs = 180000) {
  const st = await readState();
  if (!st?.controlUrl) {
    return { ok: false, error: "no running stack — start one with `hydra up` (or u in the TUI)" };
  }
  const r = await fetchJson(`${st.controlUrl}/${path}`, { method: "POST", body: body ?? {}, timeoutMs });
  if (!r.ok) return { ok: false, error: r.json?.error ?? r.error ?? `http ${r.status}` };
  return r.json;
}

export const register = (who = "bob") => control("register", { who });
export const shield = (opts) => control("shield", opts);
export const transfer = (opts) => control("transfer", opts);
export const notes = (who = "alice") => control("notes", { who });
export const advance = (blocks = 11) => control("advance", { blocks });

/** Is a stack running that can actually transact? */
export async function transactAvailable() {
  const st = await readState();
  return Boolean(st?.controlUrl);
}
