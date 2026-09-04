#!/usr/bin/env node
/**
 * Checks that must pass before a build starts, with a message that says what to do.
 *
 * Run by `npm run build` ahead of `next build`. Everything here is a condition that would
 * otherwise produce a page that looks fine and is wrong — a wordmark silently set in the
 * fallback face, or a bundle that reaches key-handling code. Both are the kind of failure a
 * person only notices by comparing against something they no longer have.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { boundaryCrossings, entryPoints } from "./module-graph.ts";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WEB, "..");

const problems: string[] = [];

/**
 * The wordmark face.
 *
 * NON Natural Grotesk is licensed to the author for personal use. That covers building this
 * site and does not cover redistributing the file, so the binary is gitignored and is not in the
 * repository — see `web/README.md`. `font-display: block` means a missing file renders the
 * wordmark as nothing rather than as Geist, so without this check the failure mode is an empty
 * hero that looks like a layout bug.
 *
 * Failing loudly here is the whole point: a fallback would be a design nobody chose, shipped
 * without anybody deciding to.
 */
const WORDMARK = join(WEB, "public/fonts/NON-Natural-Grotesk-Regular.woff2");
if (!existsSync(WORDMARK)) {
  problems.push(
    `the wordmark face is missing:\n    ${WORDMARK}\n`
    + "  It is not in the repository on purpose — it is licensed for personal use, which does\n"
    + "  not cover redistribution. Copy your licensed file to that path. If you do not have one,\n"
    + "  see web/README.md for what to change instead of shipping a fallback nobody chose.",
  );
}

/** The open faces, which ARE in the repository because their licence permits it. */
for (const face of [
  "Geist-Variable-latin.woff2",
  "GeistMono-Variable-latin.woff2",
  "InstrumentSerif-Regular-latin.woff2",
]) {
  const path = join(WEB, "public/fonts", face);
  if (!existsSync(path)) problems.push(`missing font: ${path}`);
}

/**
 * The mark, and the favicon generated from it.
 *
 * Gitignored for the same reason as the wordmark face and a stronger one: it is a third party's
 * trademark rather than a licence anybody here holds. Same failure mode too — a missing favicon
 * is invisible and a missing nav mark is an empty box, so it is checked rather than noticed.
 */
for (const asset of ["public/hydra.svg", "app/icon.svg"]) {
  if (!existsSync(join(WEB, asset))) {
    problems.push(
      `the mark is missing: ${join(WEB, asset)}\n`
      + "  It is not in the repository on purpose — see web/README.md. `app/icon.svg` is the\n"
      + "  same file recoloured to the accent; copy `public/hydra.svg` and re-tint it.",
    );
  }
}

/** The art the hero draws behind itself. Copied from the TUI — see `app/page.tsx`. */
if (!existsSync(join(WEB, "art.txt"))) {
  problems.push(`missing art.txt in ${WEB}`);
}

/**
 * I6, before the bundler runs rather than after.
 *
 * `test/site.test.ts` owns the full version of this check, including the list of crossings that
 * already exist upstream. This is the cheap half — it stops a build that has grown a NEW path
 * into key-handling code, so the failure arrives at the moment somebody adds the import rather
 * than at the end of a test run.
 */
const KNOWN = [
  "hydra-dapp/packages/identity/src/domains.ts",
  "hydra-dapp/packages/vault-client/src/blobs.ts",
  "hydra-dapp/packages/vault-client/src/buckets.ts",
];
const added = boundaryCrossings(ROOT, entryPoints(WEB))
  .map((c) => c.file)
  .filter((c) => !KNOWN.includes(c));
if (added.length) {
  problems.push(
    "a new path from web/ into identity or vault-client:\n"
    + added.map((a) => `    ${a}`).join("\n")
    + "\n  I6: a browser context may hold neither the pool viewing key nor the vault content\n"
    + "  key. These packages hold the derivation for both.",
  );
}

if (problems.length) {
  console.error(`\npreflight failed (${problems.length}):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}
