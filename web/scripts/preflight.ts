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
import { isPublicBuild, RESTRICTED } from "./build-mode.ts";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WEB, "..");

const problems: string[] = [];

/**
 * The two restricted assets, checked in opposite directions depending on the build.
 *
 * **The full build fails when they are MISSING. The public build fails when they are PRESENT.**
 * Each mode refuses the mistake available to it — a wordmark silently set in the fallback face,
 * or a licensed font and a third party's trademark served from a public URL because they happened
 * to be sitting in `public/` when somebody ran the build.
 *
 * `font-display: block` means a missing wordmark face renders as nothing rather than as Geist, so
 * without this check the full build's failure mode is an empty hero that looks like a layout bug.
 * And `next build` copies all of `public/` into `out/`, so without the other half the publish
 * failure mode is silent and legal rather than visible and technical — which is worse.
 */
if (isPublicBuild()) {
  const leaked = RESTRICTED.filter((r) => existsSync(join(WEB, r)));
  if (leaked.length) {
    problems.push(
      "HYDRA_PUBLIC=1, but restricted assets are present and would be copied into out/:\n"
      + leaked.map((r) => `    ${r}`).join("\n")
      + "\n  The wordmark face is licensed for personal use and the mark is a third party's\n"
      + "  trademark. Publishing out/ redistributes them exactly as committing them would.\n"
      + "  Move them aside for this build; the public build substitutes both.",
    );
  }
} else {
  const WORDMARK = join(WEB, "public/fonts/NON-Natural-Grotesk-Regular.woff2");
  if (!existsSync(WORDMARK)) {
    problems.push(
      `the wordmark face is missing:\n    ${WORDMARK}\n`
      + "  It is not in the repository on purpose — it is licensed for personal use, which does\n"
      + "  not cover redistribution. Copy your licensed file to that path, or build with\n"
      + "  HYDRA_PUBLIC=1, which substitutes it and is the only build that may be hosted.",
    );
  }
  for (const asset of ["public/hydra.svg", "app/icon.svg"]) {
    if (!existsSync(join(WEB, asset))) {
      problems.push(
        `the mark is missing: ${join(WEB, asset)}\n`
        + "  Not in the repository on purpose — see web/README.md. Or build with HYDRA_PUBLIC=1.",
      );
    }
  }
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
const crossings = boundaryCrossings(ROOT, entryPoints(WEB)).map((c) => c.file);
if (crossings.length) {
  problems.push(
    "a path from web/ into identity or vault-client:\n"
    + crossings.map((a) => `    ${a}`).join("\n")
    + "\n  I6: a browser context may hold neither the pool viewing key nor the vault content\n"
    + "  key. These packages hold the derivation for both.",
  );
}

if (problems.length) {
  console.error(`\npreflight failed (${problems.length}):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}
