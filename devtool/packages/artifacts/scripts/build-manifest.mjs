#!/usr/bin/env node
/**
 * Write `manifest.json`: what each shipped file is, and the hash that identifies it.
 *
 * ## WHY A MANIFEST AT ALL
 *
 * This package ships build outputs. That is the opposite of the argument the rest of this
 * repository makes — claims generated from the code that makes them true — unless the blob can be
 * checked against something. So every file here carries the hash a Starknet node would compute for
 * it, pinned to the commit that produced it, and `scripts/verify.mjs` recomputes them.
 *
 * ## THREE KINDS OF ENTRY, AND CALLING THEM ALL "CLASS HASH" WOULD BE A LIE
 *
 * The brief for this package said "a manifest of expected class hashes", as though that were one
 * thing. It is three:
 *
 *   sierra    `*.contract_class.json`           — `computeContractClassHash`, the value a
 *                                                 `DECLARE` puts on chain and the one an address
 *                                                 is derived from
 *   casm      `*.compiled_contract_class.json`  — `computeCompiledClassHash`, a DIFFERENT function
 *                                                 over a different encoding
 *   index     `*.starknet_artifacts.json`       — neither. It is Scarb's manifest of what it
 *                                                 wrote, has no on-chain meaning, and the only
 *                                                 thing to pin is the bytes
 *
 * A single field named `classHash` holding all three would read as a stronger guarantee than two
 * thirds of it are, which is the defect this repository keeps recording. `kind` is on every entry
 * so a reader can tell what they are being shown.
 *
 * ## `path` IS WHERE THE FILE IS HERE; `dest` IS WHERE IT GOES IN THE CHECKOUT
 *
 * Scarb writes everything under `target/dev/`, and the repository's `.gitignore` excludes
 * `target/` everywhere — correctly, since every other `target/` in the tree is build output nobody
 * should commit. **Git cannot re-include a file whose parent directory is excluded**, so a
 * negation rule would not have worked without restructuring the ignore file that every other lane
 * shares.
 *
 * So the stored copy substitutes `build` for `target/dev` and the manifest carries the real
 * destination beside it. The transform is mechanical and it is recorded per file rather than
 * recomputed by each reader, because a path rule reimplemented at the install site is a second
 * answer to where a file belongs.
 *
 * ## WHERE `starknet` COMES FROM, AND WHY IT IS NOT A DEPENDENCY HERE
 *
 * Computing a class hash needs a Starknet implementation. This package deliberately does not
 * depend on one: it would be a second copy of a library the checkout already has, installed for
 * every user of a package whose runtime job is to hold files. Both scripts resolve it from the
 * upstream checkout, or from anywhere Node can already find it. A verifier who has neither can
 * `npm i starknet` — stated in the README rather than assumed.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FILES = join(ROOT, "artifacts");

/** `starknet`, from wherever it already exists. See the header for why it is not a dependency. */
export function starknet(upstream = process.env.HYDRA_UPSTREAM ?? join(ROOT, "..", "..", "..", ".upstream")) {
  const require = createRequire(import.meta.url);
  for (const from of [join(upstream, "client", "package.json"), join(upstream, "sdk", "package.json")]) {
    try { return createRequire(from)("starknet"); } catch { /* try the next one */ }
  }
  try { return require("starknet"); } catch { /* fall through to the message */ }
  throw new Error(
    "no `starknet` available to compute class hashes with. Set HYDRA_UPSTREAM to the checkout, "
    + "or `npm i starknet` — this package does not depend on one, see scripts/build-manifest.mjs.");
}

/** Which of the three kinds a file is, by the name Scarb gave it. */
export function kindOf(name) {
  if (name.endsWith(".starknet_artifacts.json")) return "index";
  if (name.endsWith(".compiled_contract_class.json")) return "casm";
  if (name.endsWith(".contract_class.json")) return "sierra";
  return null;
}

export function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

/** The hash for one file, and the kind that says what the hash MEANS. */
export const destFor = (rel) => rel.replace(/(^|\/)build\//, "$1target/dev/");

export function entryFor(sn, rel) {
  const abs = join(FILES, rel);
  const kind = kindOf(rel);
  const bytes = readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dest = destFor(rel);
  if (kind === "index") return { path: rel, dest, kind, sha256 };
  const json = JSON.parse(bytes.toString("utf8"));
  const hash = kind === "sierra"
    ? sn.hash.computeContractClassHash(json)
    : sn.hash.computeCompiledClassHash(json);
  return { path: rel, dest, kind, sha256, hash };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sn = starknet();
  const upstreamSha = readFileSync(join(ROOT, "..", "cli", "src", "pins.mjs"), "utf8")
    .match(/UPSTREAM_SHA = "([0-9a-f]{40})"/)?.[1];
  if (!upstreamSha) throw new Error("could not read UPSTREAM_SHA out of packages/cli/src/pins.mjs");

  const files = walk(FILES);
  const unknown = files.filter((f) => !kindOf(f));
  if (unknown.length) throw new Error(`not a Cairo artifact: ${unknown.join(", ")}`);

  const entries = [];
  for (const [i, rel] of files.entries()) {
    process.stderr.write(`\r  ${i + 1}/${files.length} ${rel.slice(-52).padEnd(52)}`);
    entries.push(entryFor(sn, rel));
  }
  process.stderr.write("\n");

  writeFileSync(join(ROOT, "manifest.json"),
    `${JSON.stringify({ upstreamSha, files: entries }, null, 2)}\n`);
  const by = (k) => entries.filter((e) => e.kind === k).length;
  console.log(`wrote manifest.json — ${entries.length} files: `
    + `${by("sierra")} sierra, ${by("casm")} casm, ${by("index")} index, at ${upstreamSha.slice(0, 12)}`);
}
