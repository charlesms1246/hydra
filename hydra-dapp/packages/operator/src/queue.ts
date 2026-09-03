/**
 * THE ONLY FILE IN THIS PACKAGE THAT MAY IMPORT `moderation`, and the only one that touches disk.
 *
 * `decisions/0036` measured what enforces I8's module-graph half, and the honest answer is a
 * source scan rather than a compile-time check: `rootDir` rejects every file outside the root
 * including allow-listed ones, so tsc cannot say "this sibling yes, that sibling no". Since the
 * enforcement is a scan, the useful thing left to do is make the surface small enough to read —
 * one file, one direction, checked by `i8-operator-separation.test.ts`. A chokepoint is not a
 * boundary, but it makes the dependency something somebody chose.
 *
 * PERSISTENCE IS WHY THIS EXISTS AT ALL. `Reports` is a live object, and a queue that only exists
 * inside one process is not an operator surface — the audit that found zero of eight moderation
 * steps operable would find the same thing again with a tool that forgets between invocations.
 *
 * What is written down is `DECISIONS-NEEDED.md` D8's stated default and no more: decisions carry
 * `blobId, outcome, category, at` and never a reporter. Report bodies are written only for reviews
 * that are still OPEN, because `decide` drops them — a body is retained exactly as long as a human
 * still has to read it. How long decisions themselves live is still open and rides with D7, so
 * this deliberately implements **no expiry**: a retention period invented here would become the
 * answer by inertia.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Reports, summarise, type Snapshot, type Decision, type Review }
  from "../../moderation/src/reports.ts";
import { report as transparencyReport, type Period } from "../../moderation/src/transparency.ts";

export type { Decision, Review, Period };
export { summarise, transparencyReport };

/**
 * Load the queue, or start an empty one.
 *
 * A missing file is an empty queue and not an error: the first `decide` a new operator runs should
 * not require them to have created a file first. A CORRUPT file is an error, loudly, because the
 * alternative is starting empty and silently discarding a queue of real reports.
 */
export function load(path: string): Reports {
  if (!existsSync(path)) return new Reports();
  let parsed: Snapshot;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  } catch (e) {
    throw new Error(`${path} is not readable as a queue (${(e as Error).message}). Refusing to `
      + "start from an empty one — that would discard every pending review without saying so.");
  }
  return Reports.restore(parsed);
}

/**
 * Write the queue back.
 *
 * VIA A TEMPORARY FILE AND A RENAME, because the alternative loses the queue rather than the
 * change: a process interrupted mid-write leaves a truncated JSON file, `load` then refuses it as
 * corrupt — correctly — and the operator has no queue at all. `rename` is atomic within a
 * filesystem, so a reader sees the old file or the new one.
 */
export function save(path: string, q: Reports): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.writing`;
  writeFileSync(tmp, `${JSON.stringify(q.snapshot(), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
