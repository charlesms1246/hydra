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

import { readFileSync } from "node:fs";

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
): { uncovered: Route[]; orphans: number[]; routes: Route[] } {
  const errorLines = tscOutput.split("\n")
    .filter((l) => /error TS/.test(l) && l.includes(fixtureName))
    .map((l) => Number(l.match(/\((\d+),/)?.[1]))
    .filter((n) => Number.isFinite(n));
  const routes = routesIn(fixturePath);
  return {
    routes,
    uncovered: routes.filter((r) => !errorLines.some((n) => n >= r.from && n < r.to)),
    // An error outside every route means the fixture has drifted from its own numbering and some
    // errors are being credited to the wrong attempt.
    orphans: errorLines.filter((n) => !routes.some((r) => n >= r.from && n < r.to)),
  };
}
