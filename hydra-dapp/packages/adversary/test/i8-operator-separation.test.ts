/**
 * I8 — the operator surface and the user surface never share a binary, a package, or a
 * dependency path.
 *
 * `decisions/0036`. Written BEFORE the operator surface exists, which is the whole point: an
 * audit of `decisions/0035`'s pipeline found that zero of its eight steps have any way to be
 * performed, `moderation/src` has no callers outside its own tests, and both front ends in this
 * repo — `cli` and `tui` — are user clients. The cheap fix for eight missing steps is eight
 * subcommands on `hydra`, and that is the one thing that must not happen: a client and an
 * operator tool have opposite trust assumptions.
 *
 * Both directions are guarded because both are real and neither implies the other. A user client
 * that can take posts down is a censorship tool wearing a messenger's clothes; an operator tool
 * that depends on `identity` makes a reviewer's machine key-bearing for no reason.
 *
 * NO `i8-must-not-compile.ts`, and `0036` argues it rather than assuming it. A fixture is
 * type-checked by `packages/adversary/tsconfig.json`, which includes every package by
 * construction, so no import inside it can fail for the reason I8 cares about. I6's fixture works
 * because I6's invariant is carried by a type; I8's is carried by the module graph, and tsc's
 * instrument for that is a per-package tsconfig that lands with the package.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { uncoveredRoutes } from "../src/must-not-compile.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");
const DECISION = join(PACKAGES, "..", "..", "claude-docs", "decisions",
  "0036-the-operator-surface.md");

/**
 * What a user runs. `adversary` is absent because it is the test package and must see everything;
 * `vault-server` is absent because it is the operator's service rather than their tool, and is
 * already covered by `no-key-in-server`.
 */
const USER_PACKAGES = ["cli", "tui", "client", "identity", "vault-client",
  "channel", "handshake", "claims"];

/** Where an operator tool would live. None of these exist yet — see the third test. */
const OPERATOR_TOOL = ["operator", "review", "moderator"];

function sourcesIn(pkg: string): { path: string; text: string }[] {
  const dir = join(PACKAGES, pkg, "src");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => ({ path: `${pkg}/src/${f}`, text: readFileSync(join(dir, f), "utf8") }));
}

test("NO USER-FACING PACKAGE IMPORTS `moderation`", () => {
  // Passes today, which is exactly why it is written today. `moderation` currently has no callers
  // at all, so the cost of fixing this later is zero and the cost of writing the rule later is a
  // migration. The first caller will not be the CLI.
  const files = USER_PACKAGES.flatMap(sourcesIn);
  assert.ok(files.length > 20, `only found ${files.length} user sources; the scan is broken`);
  const offenders = files
    .filter((f) => /from ["'][^"']*(packages\/)?moderation\//.test(f.text))
    .map((f) => f.path);
  assert.deepEqual(offenders, [],
    `${offenders.join(", ")} imports moderation code into a package a USER runs. A review queue `
    + "in a client is a queue on a machine that holds keys — see decisions/0036.");
});

test("NO USER-FACING PACKAGE CAN PERFORM A TAKEDOWN", () => {
  // The concrete form of direction 1, and stronger than the import check because it names the
  // mechanism rather than the module: `x-hydra-removal` is the header that removes a public post,
  // and it must not appear in anything a user runs, however it got there.
  const offenders = USER_PACKAGES.flatMap(sourcesIn)
    // Comments are stripped: an accurate explanation of a header must not be able to break a
    // guard about carrying it. This is the fourth time that has come up — see decisions/0034.
    .filter((f) => /x-hydra-removal/i.test(f.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")))
    .map((f) => f.path);
  assert.deepEqual(offenders, [],
    `${offenders.join(", ")} carries the removal header. Taking public content down is the `
    + "operator's authority and must not ship in the binary that holds a user's keys.");
});

test("THE OPERATOR TOOL IS NOT KEY-BEARING — reported as absent rather than passed", () => {
  // I6's dependency check has sat in exactly this state since it was written, and the shape is
  // deliberate: a check that goes green on a directory that does not exist is how a check comes
  // to exist without ever having run. So absence must be announced and must cite the reason.
  const present = OPERATOR_TOOL.filter((p) => existsSync(join(PACKAGES, p)));
  if (present.length === 0) {
    assert.ok(existsSync(DECISION),
      "no operator package to check and no decisions/0036 explaining why — one must be true");
    return;
  }
  for (const pkg of present) {
    const offenders = sourcesIn(pkg)
      .filter((f) => /from ["'][^"']*(packages\/)?(identity|vault-client)\//.test(f.text))
      .map((f) => f.path);
    assert.deepEqual(offenders, [],
      `${offenders.join(", ")} pulls key-handling code into the operator tool. Installing the `
      + "review tool must not make a reviewer's machine key-bearing — see decisions/0036.");
  }
});

test("EXACTLY ONE FILE IN THE OPERATOR TOOL IMPORTS `moderation`", () => {
  // Not a boundary — `0036` is explicit that tsc cannot express one here, because `rootDir`
  // rejects allow-listed siblings along with forbidden ones and there is no selective form. Since
  // the enforcement is a scan, the thing worth enforcing is that the surface stays small enough
  // to read: one file, one direction. A chokepoint makes the dependency something somebody chose
  // rather than something that accumulated across a package.
  const present = OPERATOR_TOOL.filter((p) => existsSync(join(PACKAGES, p)));
  if (present.length === 0) return;   // the previous test is the one that reports absence
  for (const pkg of present) {
    const importers = sourcesIn(pkg)
      .filter((f) => /from ["'][^"']*(packages\/)?moderation\//.test(f.text))
      .map((f) => f.path);
    assert.deepEqual(importers, [`${pkg}/src/queue.ts`],
      `moderation is imported from ${importers.join(", ") || "nowhere"}; it must be reached only `
      + `through ${pkg}/src/queue.ts, which is also the only file that touches disk.`);
  }
});

test("I8 IS WRITTEN DOWN, and says the thing the tests check", () => {
  // The tests above enforce a rule whose REASONS live in prose. A guard whose decision file has
  // drifted is a guard nobody can evaluate — this repo has been bitten by prose that described a
  // property the code below it did not check.
  assert.ok(existsSync(DECISION), "decisions/0036 is missing");
  const text = readFileSync(DECISION, "utf8");
  for (const phrase of ["never share a binary", "opposite trust assumptions", "x-hydra-removal"]) {
    assert.ok(text.includes(phrase), `decisions/0036 no longer says "${phrase}"`);
  }
});

test("NO ROUTE FROM A USER'S VALUE TO REMOVAL AUTHORITY COMPILES", () => {
  const local = join(HERE, "..", "node_modules", ".bin", "tsc");
  const shared = join(HERE, "..", "..", "identity", "node_modules", ".bin", "tsc");
  const tsc = existsSync(local) ? local : existsSync(shared) ? shared : null;
  // A missing type-checker is a FAILURE, not a skip — an unrun build check reported as green is
  // how a build-time guarantee stops being one.
  assert.ok(tsc, "no tsc — run `npm i -D typescript` in hydra-dapp/packages/identity");

  let out = "";
  try {
    execFileSync(tsc!, ["--noEmit", "-p", join(HERE, "..", "tsconfig.json")], { encoding: "utf8" });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const { uncovered, orphans, routes } =
    uncoveredRoutes(out, "i8-must-not-compile", join(HERE, "i8-must-not-compile.ts"));
  assert.ok(routes.length >= 9, `only ${routes.length} numbered routes in the fixture`);
  // Every numbered attempt on its own. A total cannot say WHICH route was rejected, and the one
  // that quietly compiles here is the one that hands a user's client authority over anyone's post.
  assert.deepEqual(uncovered.map((r) => r.label), [],
    "these routes COMPILE:\n"
    + `${uncovered.map((r) => `  route ${r.label} (i8-must-not-compile.ts:${r.from}-${r.to - 1})`).join("\n")}`
    + `\n\nfull tsc output:\n${out}`);
  assert.deepEqual(orphans, [],
    `type errors in the fixture outside any numbered route: lines ${orphans.join(", ")}`);
  const other = out.split("\n").filter((l) => /error TS/.test(l) && !/must-not-compile/.test(l));
  assert.deepEqual(other, [], `type errors outside the fixtures:\n${other.join("\n")}`);
});
