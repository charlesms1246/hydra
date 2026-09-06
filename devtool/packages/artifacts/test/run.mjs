/**
 * The prebuilt artifacts are the set the pinned revision produces, and the manifest describes them
 * truthfully.
 *
 * ## WHAT RUNS EVERY TIME AND WHAT DOES NOT, SAID RATHER THAN SKIPPED
 *
 * Recomputing all 84 hashes takes about eighty seconds, because a Sierra class hash is ~1.3s and
 * there are 58 of them. Putting that in every `npm test` would buy one guarantee and cost the
 * suite its usability, and a slow suite is one people stop running.
 *
 * So: the structural checks run always, and the hashes are recomputed for **three files chosen to
 * cover all three kinds** — enough to prove the machinery works and the manifest's own numbers are
 * reachable. `HYDRA_VERIFY_ALL=1` does all 84.
 *
 * **THE MODE IS PRINTED.** `test-run.mjs` states the rule this obeys — *"a suite that quietly
 * skips lets the gate pass having tested less than it claims"* — so a reader of the output learns
 * that 3 of 84 were hashed rather than being left to assume 84.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { walk, kindOf, entryFor, starknet } from "../scripts/build-manifest.mjs";
import { UPSTREAM_SHA } from "../../cli/src/pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  — ${detail}`);
  if (!ok) failed++;
};

// The revision is the whole basis for the files being usable at all: a set from another commit
// declares classes this checkout's source does not produce.
check("the manifest is pinned to the same revision as the CLI",
  manifest.upstreamSha === UPSTREAM_SHA,
  `manifest ${manifest.upstreamSha?.slice(0, 12)} · pin ${UPSTREAM_SHA.slice(0, 12)}`);

// BOTH DIRECTIONS. Listed-but-absent is the obvious half; present-but-unlisted is the half that
// would let an unaccounted file ship, which is the shape of the `doctor` defect this was built
// alongside — an index checked for itself while the classes it names went unexamined.
const onDisk = new Set(walk(join(ROOT, "artifacts")));
const listed = new Set(manifest.files.map((f) => f.path));
const unlisted = [...onDisk].filter((f) => !listed.has(f));
const absent = [...listed].filter((f) => !onDisk.has(f));
check("every shipped file is in the manifest and every listed file is shipped",
  unlisted.length === 0 && absent.length === 0,
  `${onDisk.size} on disk · ${listed.size} listed`
  + (unlisted.length ? ` · unlisted: ${unlisted[0]}` : "")
  + (absent.length ? ` · absent: ${absent[0]}` : ""));

// A `kind` that disagreed with the filename would mean a hash computed by the wrong function —
// and a CASM file hashed as Sierra produces a number, not an error.
const miskinded = manifest.files.filter((f) => f.kind !== kindOf(f.path));
check("every entry's kind matches what its name says it is",
  miskinded.length === 0,
  miskinded.length ? `${miskinded[0].path} listed as ${miskinded[0].kind}` : "58 sierra · 15 casm · 11 index");

// An index has no on-chain identity, so it carries bytes only. A `hash` on one would be a number
// with no meaning presented beside numbers that have one.
check("indexes carry bytes only, and classes carry a hash",
  manifest.files.every((f) => (f.kind === "index" ? f.hash === undefined : typeof f.hash === "string")),
  "no index has a class hash; every sierra and casm does");

const all = process.env.HYDRA_VERIFY_ALL === "1";
const sample = all
  ? manifest.files
  : ["sierra", "casm", "index"].map((k) => manifest.files.find((f) => f.kind === k)).filter(Boolean);

// Vacuity: a sample that found nothing would agree with the manifest trivially.
check("the hash sample covers every kind", all || sample.length === 3,
  all ? `all ${sample.length}` : sample.map((f) => f.kind).join(", "));

let sn = null;
try { sn = starknet(); } catch { /* reported below */ }
if (!sn) {
  check("a starknet implementation is available to recompute hashes with", false,
    "none found — set HYDRA_UPSTREAM or `npm i starknet`; hashes were NOT checked");
} else {
  const wrong = [];
  for (const want of sample) {
    if (!existsSync(join(ROOT, "artifacts", want.path))) continue;
    const got = entryFor(sn, want.path);
    if (got.sha256 !== want.sha256 || got.hash !== want.hash) wrong.push(want.path);
  }
  check(`recomputed hashes match the manifest`, wrong.length === 0,
    `${sample.length} of ${manifest.files.length} recomputed${all ? "" : " — HYDRA_VERIFY_ALL=1 for all"}`
    + (wrong.length ? ` · first mismatch ${wrong[0]}` : ""));
}

console.log(`\n${failed ? `${failed} failed` : "all artifact checks pass"}`);
process.exit(failed ? 1 : 0);
