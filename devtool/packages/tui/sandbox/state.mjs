/**
 * The world singleton, shared between the fake modules and the runner.
 *
 * The loader only rewrites specifiers; the fakes themselves load in the ordinary main
 * thread module graph, so a plain module-scoped value is enough to share state with them.
 */

let current = null;

export function setWorld(w) {
  current = w;
  current.fixed ??= new Set();
  return current;
}

export function world() {
  if (!current) throw new Error("sandbox world not initialised — start via sandbox/run.mjs");
  return current;
}
