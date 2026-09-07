/**
 * Reading a `*-must-not-compile.ts` fixture's result, once, for every invariant that has one.
 *
 * Three invariants use the same instrument — I1's key domains, I5's blob separation, and X3DH's
 * cross-domain handshake — and all three had the same defect in it, because the instrument was
 * copied rather than shared.
 *
 * THE DEFECT, and it survived two attempts to fix it. A fixture lists numbered routes that must
 * each fail to type-check. The first guard counted ERRORS against routes: eight errors across
 * seven routes passes while one route silently compiles. The second counted DISTINCT ERRORING
 * LINES, which is the same hole one level down — two errors on two lines of route 1 and none in
 * route 7 still totals seven. Both compare an aggregate against an aggregate, and no total can
 * say WHICH route was rejected.
 *
 * `i1-key-domains.test.ts` was fixed in isolation. The other two were not, and the reason is
 * worth keeping: `x3dh.test.ts` cited `i5-blob-separation.test.ts` as the precedent for counting
 * lines, so the wrong lesson propagated BY CITATION — while `i5-blob-separation.test.ts:141`
 * had the right property written in prose one line above the code that did not check it. A test
 * that names its property and then checks something else is worse than one that says nothing,
 * because the prose is what a reviewer reads.
 *
 * So it lives here, and a fourth invariant that wants this instrument gets the fixed one.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One numbered route in a fixture: its label and the lines it owns. */
export type Route = { readonly label: string; readonly from: number; readonly to: number };

/**
 * The routes a fixture declares, as line ranges.
 *
 * A route owns everything from its own `// N.` comment to the next one, so an error anywhere in
 * its body counts for it and for nothing else. `3b` is a label, not a number — the fixtures use
 * suffixes for a route that was split.
 */
export function routesIn(fixturePath: string): Route[] {
  const src = readFileSync(fixturePath, "utf8").split("\n");
  const marks: { label: string; from: number }[] = [];
  src.forEach((line, i) => {
    const m = line.match(/^\/\/ (\d+[a-z]?)\./);
    if (m) marks.push({ label: m[1], from: i + 1 });   // tsc lines are 1-based
  });
  return marks.map((m, i) => ({
    label: m.label, from: m.from, to: marks[i + 1]?.from ?? src.length + 1,
  }));
}

/**
 * Which routes the compiler did NOT reject — the ones that compile, and the whole point.
 *
 * Returns labels rather than a count, so the failure message names the route a reader has to go
 * and look at. That is the difference this module exists to make: "one of them compiles" sends
 * somebody hunting; "route 7 compiles" does not.
 */
export function uncoveredRoutes(
  tscOutput: string,
  fixtureName: string,
  fixturePath: string,
): { uncovered: Route[]; orphans: number[]; routes: Route[]; unusable: string[] } {
  const all = tscOutput.split("\n").filter((l) => /error TS/.test(l));
  /*
   * Errors with no `file(line,col):` prefix are the COMPILER failing, not code being judged.
   *
   * ⚠ THIS IS THE VACUITY FLOOR FOR A PER-LINE ASSERTION, and without it the whole family of
   * must-not-compile guards inverts. `uncovered` is computed from the ABSENCE of an error on a
   * route's lines, so a tsc that never resolved emits one global error, no per-route errors, and
   * every route reports as compiling. Observed: `error TS2688: Cannot find type definition file
   * for 'node'` under a workspace layout the tsconfig's `typeRoots` did not reach — all eight I8
   * routes reported as compiling, on a tree where none of them does.
   *
   * It failed loudly, which is the right direction, but it failed *as an I8 violation*. A reader
   * goes hunting for a route that hands a user removal authority, finds nothing, and the tempting
   * fix is an exemption. **Negative evidence requires proof that the instrument was working**, so
   * callers must assert `unusable` is empty before they may read anything into `uncovered`.
   */
  const unusable = all.filter((l) => !/^\S+\(\d+,\d+\):/.test(l.trim()));
  const errorLines = all
    .filter((l) => l.includes(fixtureName))
    .map((l) => Number(l.match(/\((\d+),/)?.[1]))
    .filter((n) => Number.isFinite(n));
  const routes = routesIn(fixturePath);
  return {
    routes,
    unusable,
    uncovered: routes.filter((r) => !errorLines.some((n) => n >= r.from && n < r.to)),
    // An error outside every route means the fixture has drifted from its own numbering and some
    // errors are being credited to the wrong attempt.
    orphans: errorLines.filter((n) => !routes.some((r) => n >= r.from && n < r.to)),
  };
}


/**
 * Is this tsc line the noise a missing `.upstream/` makes, and nothing else?
 *
 * **SHARED RATHER THAN COPIED, because the thing it filters is already triplicated.** I5, I6 and
 * I8 each end with the same `assert.deepEqual(other, [], "type errors outside the fixtures")`, and
 * a predicate written into one of them and not the others is the defect this module was created
 * to stop — three copies of an instrument, fixed in one.
 *
 * `live-lifecycle.test.ts` imports StarkWare's SDK by path, out of `.upstream/`, which is a
 * vendored checkout and gitignored. A clone does not have it, so tsc raises TS2307 and all three
 * route checks fail — **measured in a real `git clone` on 2026-09-07: 5 failures, 3 of them this
 * one line.** They fail as invariant violations, which sends a reader hunting for a route that
 * hands away removal authority when the actual cause is a directory nobody checked out.
 *
 * ⚠ NARROW, and every clause is load-bearing: only TS2307, only a specifier under `.upstream/`,
 * and only when `.upstream/` is genuinely absent. On a machine that HAS the tree, this same error
 * means the SDK moved — which is a real finding and must still fail. The same predicate, for the
 * same reason, is in `scripts/typecheck.ts`; that one runs first and prints its suppression count.
 */
const UPSTREAM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".upstream");

export function absentUpstreamNoise(line: string): boolean {
  return !existsSync(UPSTREAM) && /error TS2307/.test(line) && /[./]\.upstream\//.test(line);
}
