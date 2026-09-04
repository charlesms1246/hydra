/**
 * An append-only record of what this machine actually did.
 *
 * Nothing recorded any of it before. The TUI's log is `useState([])` and is cleared
 * on every flow, fix and startup; its ledger is in memory; `state.json` is a flat
 * snapshot that `hydra-dev down` deletes; the control API's log dies with the process.
 * So "recent failures" and "tool history" were unanswerable — not hard to render,
 * unanswerable — and a Tools page claiming to show them would have been inventing.
 *
 * JSONL, appended, never rewritten: a crashed process leaves a truncated last line
 * and every line before it still parses. Capped by line count on read rather than
 * by rotation, because the file is small and losing history to a rotation bug is a
 * worse failure than reading a long file.
 */

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HYDRA_HOME } from "./state.mjs";

/**
 * Resolved per call, not once at import.
 *
 * `HYDRA_HOME` is read from the environment when state.mjs is first evaluated, so a
 * caller that sets it later — the sandbox does, and so does any test — would have
 * been writing to the wrong directory while believing otherwise. A path is cheap;
 * a file written somewhere nobody looks is not.
 */
const file = () => join(process.env.HYDRA_HOME ?? HYDRA_HOME, "history.jsonl");

/** Kinds a caller may record. Anything else is a typo, and is rejected loudly. */
export const KINDS = ["stack", "flow", "fix", "build", "test"];

/**
 * Record one outcome. Never throws: history is a diagnostic, and a tool that fails
 * because it could not write its own audit line is worse than one with a gap in it.
 */
export async function record({ kind, name, ok, ms, detail }) {
  if (!KINDS.includes(kind)) return { ok: false, error: `unknown kind: ${kind}` };
  const line = JSON.stringify({
    at: new Date().toISOString(),
    kind,
    name: String(name ?? "").slice(0, 120),
    ok: Boolean(ok),
    ms: Number.isFinite(ms) ? Math.round(ms) : null,
    detail: detail === undefined ? undefined : String(detail).slice(0, 400),
  });
  try {
    await mkdir(process.env.HYDRA_HOME ?? HYDRA_HOME, { recursive: true });
    await appendFile(file(), line + "\n");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * The most recent entries, newest first.
 *
 * A truncated final line — a process killed mid-append — is dropped rather than
 * throwing, which is the whole point of choosing JSONL over one JSON array.
 */
export async function history({ limit = 200, kind = null } = {}) {
  let text;
  try {
    text = await readFile(file(), "utf8");
  } catch {
    return { available: true, entries: [], file: file() };
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!kind || e.kind === kind) entries.push(e);
    } catch {
      /* truncated tail — ignore */
    }
  }
  entries.reverse();
  return { available: true, entries: entries.slice(0, limit), file: file() };
}

/** Per-name rollup: how often, how recently, and how it went last time. */
export async function summary(kind = null) {
  const { entries } = await history({ limit: 2000, kind });
  const by = new Map();
  for (const e of entries) {
    const k = `${e.kind}:${e.name}`;
    const cur = by.get(k) ?? { kind: e.kind, name: e.name, runs: 0, failures: 0, lastAt: null, lastOk: null, lastMs: null };
    cur.runs++;
    if (!e.ok) cur.failures++;
    if (!cur.lastAt) { cur.lastAt = e.at; cur.lastOk = e.ok; cur.lastMs = e.ms; }
    by.set(k, cur);
  }
  return [...by.values()].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}
