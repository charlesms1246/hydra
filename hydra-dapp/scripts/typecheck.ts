#!/usr/bin/env node
/**
 * Run `tsc` over the whole workspace and fail on anything that is not a fixture.
 *
 * **A TSCONFIG NOBODY RUNS IS A MECHANISM NOBODY CALLS.** `packages/adversary/tsconfig.json`
 * already includes every package's sources with `noEmit`, added after E-CLI1 for exactly this purpose — and
 * nothing invoked it. `node --test` strips types without checking them, so a type error could sit
 * in the tree, pass every test here, and only surface in another session's build, which is how
 * `TS2769` in `statement.ts` reached the web lane.
 *
 * IT CANNOT BE A BARE `tsc --noEmit`, which is the reason it was never wired up: the
 * `*-must-not-compile.ts` fixtures exist to fail, so a plain run always exits non-zero. Their
 * errors are filtered here and asserted route-by-route by their own guards, which is where that
 * belongs — this only has to answer "is anything ELSE broken".
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = import.meta.dirname;
const PROJECT = join(HERE, "..", "packages", "adversary", "tsconfig.json");
/**
 * Every `node_modules/.bin` from `packages/identity` upward, which is Node's own lookup.
 *
 * It was two hard-coded paths, and `packages/*` is exactly where npm STOPS putting things once
 * a workspace root exists: `npm install` hoists `tsc` to `hydra-dapp/node_modules/.bin`, both
 * candidates miss, and this exits 1 saying "run `npm i -D typescript` in packages/identity" on a
 * tree where typescript is installed and working. Measured on a fresh clone with `workspaces`
 * declared, before this was derived.
 *
 * Deriving it also retires a candidate that was already dead: `packages/adversary/node_modules`
 * has held no `tsc` for some time and the list still named it first.
 */
function findTsc(): string | null {
  let at = join(HERE, "..", "packages", "identity");
  for (;;) {
    const bin = join(at, "node_modules", ".bin", "tsc");
    if (existsSync(bin)) return bin;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}
const tsc = findTsc();
// A missing type-checker is a FAILURE, not a skip: an unrun check reported as green is how a
// build-time guarantee stops being one.
if (!tsc) {
  console.error("no tsc — run `npm install` in hydra-dapp/");
  process.exit(1);
}

let out = "";
try {
  execFileSync(tsc, ["--noEmit", "-p", PROJECT], { encoding: "utf8" });
} catch (e) {
  out = String((e as { stdout?: string }).stdout ?? "");
}

const errors = out.split("\n").filter((l) => /error TS/.test(l));
const fixtures = errors.filter((l) => /must-not-compile/.test(l));
const real = errors.filter((l) => !/must-not-compile/.test(l));

if (real.length) {
  console.error(real.join("\n"));
  console.error(`\n${real.length} type error(s) outside the must-not-compile fixtures.`);
  process.exit(1);
}
// The fixtures must still be failing. Zero errors from them means they started compiling, which
// would make three invariants' build gates silently vacuous — and their own tests say which route.
if (fixtures.length === 0) {
  console.error("no errors from the must-not-compile fixtures at all — they exist to fail, so "
    + "zero means the build gate stopped gating. See i5/i6/i8's route checks.");
  process.exit(1);
}
console.log(`typecheck clean (${fixtures.length} expected fixture errors)`);
