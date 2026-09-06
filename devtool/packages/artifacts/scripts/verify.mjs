#!/usr/bin/env node
/**
 * Recompute every hash in `manifest.json` from the files beside it, and refuse on any difference.
 *
 * **THIS IS THE WHOLE JUSTIFICATION FOR THE PACKAGE EXISTING.** Shipping build outputs saves a
 * user ten to fifteen minutes of Cairo compilation and, done without this, replaces a thing they
 * could have derived with a thing they have to trust. The hashes here are the ones a Starknet node
 * computes: if `privacy_Privacy.contract_class.json` in this package declares to a different class
 * hash than the one upstream's source builds to, that is detectable here rather than at a
 * `DECLARE` three steps later.
 *
 * **BOTH DIRECTIONS, AND THE SECOND IS THE ONE THAT MATTERS.** Every manifest entry must have a
 * file, AND every file must have an entry. Checking only the first would pass a package that
 * quietly gained a 85th artifact nobody listed — which is the shape of the `doctor` defect this
 * package was written alongside: an index checked for its own existence while the 29 classes it
 * references went unexamined.
 *
 * It does not need a network and does not touch the upstream checkout except to borrow a
 * `starknet` implementation. See `build-manifest.mjs` for why that is not a dependency.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { starknet, entryFor, walk, kindOf } from "./build-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function verify({ sn = starknet() } = {}) {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const problems = [];

  // A manifest with no entries would satisfy every comparison below by having nothing to compare.
  // The floor is well under 84 on purpose: it asserts "this ran", not a count somebody defends.
  if (!(manifest.files?.length >= 50)) {
    return { ok: false, problems: [`the manifest lists ${manifest.files?.length ?? 0} files, so nothing here measured anything`] };
  }

  const onDisk = new Set(walk(join(ROOT, "artifacts")));
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const f of onDisk) if (!listed.has(f)) problems.push(`shipped but not in the manifest: ${f}`);
  for (const f of listed) if (!onDisk.has(f)) problems.push(`in the manifest but not shipped: ${f}`);

  for (const want of manifest.files) {
    if (!onDisk.has(want.path)) continue;      // already reported above
    if (want.kind !== kindOf(want.path)) {
      problems.push(`${want.path} is listed as ${want.kind} and its name says ${kindOf(want.path)}`);
      continue;
    }
    const got = entryFor(sn, want.path);
    if (got.sha256 !== want.sha256) problems.push(`${want.path}: bytes differ from the manifest`);
    // `hash` is absent for an index, and its absence is meaningful rather than missing data.
    if (want.hash !== got.hash) {
      problems.push(`${want.path}: ${want.kind} hash is ${got.hash ?? "absent"}, manifest says ${want.hash ?? "absent"}`);
    }
  }
  return { ok: problems.length === 0, problems, checked: manifest.files.length, upstreamSha: manifest.upstreamSha };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = verify();
  if (!r.ok) {
    console.error(`\n  ${r.problems.length} problem(s):`);
    for (const p of r.problems.slice(0, 20)) console.error(`    ${p}`);
    process.exit(1);
  }
  console.log(`all ${r.checked} artifacts match the manifest, at ${r.upstreamSha.slice(0, 12)}`);
}
