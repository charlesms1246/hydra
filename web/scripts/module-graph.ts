/**
 * The module graph this site's bundle is built from, walked statically.
 *
 * Used by `scripts/preflight.ts` (which fails the build) and by `test/site.test.ts` (which
 * fails the suite). It exists because I6 stopped being free.
 *
 * **What changed.** Before Next.js, `web/` was a 107-line generator that emitted HTML and one
 * stylesheet, and its author wrote: *"a page that ships no code at all cannot hold a key by any
 * route, including the ones nobody thought to add a check for."* That was true, and it made a
 * dependency check unnecessary — I6 held as a property of the artifact. A bundler makes
 * accidental inclusion easy again, so the check has to be real now.
 *
 * `FRONTEND-SCAFFOLD.md` originally asked for a check that `web/package.json` never lists
 * `identity` or `vault-client`. That check would pass today and prove nothing: this package
 * reaches `hydra-dapp` by relative path, not by dependency, so `package.json` never mentions any
 * of it. The graph is where the answer is.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

/** Every specifier this file imports, re-exports included. Comments stripped first. */
function specifiersOf(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const out: string[] = [];
  // `import ... from "x"`, `export ... from "x"`, `import "x"`, and dynamic `import("x")`.
  const patterns = [
    /\bimport\s+[^;'"]*?\bfrom\s*["']([^"']+)["']/g,
    /\bexport\s+[^;'"]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/** Resolve a relative specifier the way the bundler is configured to, `.ts` extensions included. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // bare specifier: a package, not our source
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Every first-party file reachable from `entries`, as absolute paths.
 *
 * Only relative specifiers are followed. A bare specifier is a package from `node_modules`, and
 * the thing this guards against is reaching sideways into this repository's own key-handling
 * code — which is always a relative path from here.
 */
export function reachableFrom(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const spec of specifiersOf(source)) {
      const target = resolveSpecifier(file, spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

/**
 * Packages this site must never reach, and why each one.
 *
 * I6: no pool viewing key and no vault content key may enter a browser context. These are the
 * two packages that hold that material — `identity` derives and stores the pool viewing key,
 * `vault-client` holds the content key it seals blobs under. A presentation layer has no
 * business importing either, and the point of a graph check rather than a code review is that
 * nobody has to notice.
 */
export const FORBIDDEN = ["packages/identity/", "packages/vault-client/"] as const;

export type Crossing = { file: string; via: string };

/** Every reachable file that lives in a forbidden package, relative to the repo root. */
export function boundaryCrossings(root: string, entries: string[]): Crossing[] {
  const out: Crossing[] = [];
  for (const file of reachableFrom(entries)) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const via = FORBIDDEN.find((f) => rel.includes(f));
    if (via) out.push({ file: rel, via });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** The files the bundler starts from. Everything either page renders is reachable from these. */
export function entryPoints(webRoot: string): string[] {
  return [
    resolve(webRoot, "app/layout.tsx"),
    resolve(webRoot, "app/page.tsx"),
    resolve(webRoot, "app/disclosures/page.tsx"),
  ];
}

/**
 * The files that actually reach a BROWSER, as opposed to the build.
 *
 * Every component here is a server component except one, so almost nothing in the graph above is
 * sent to a reader — `statement()` and its imports run at build time on the machine doing the
 * build. That distinction is the only reason the known crossings below are survivable, and it is
 * a distinction one `"use client"` directive erases without an error or a warning.
 *
 * So this returns the client boundary: every file carrying the directive, plus everything it
 * imports. Those are the modules webpack ships.
 */
export function clientReachable(webRoot: string): Set<string> {
  const roots = [...reachableFrom(entryPoints(webRoot))].filter(
    (f) => f.startsWith(webRoot) && /^\s*["']use client["']/m.test(readFileSync(f, "utf8")),
  );
  return roots.length ? reachableFrom(roots) : new Set<string>();
}
