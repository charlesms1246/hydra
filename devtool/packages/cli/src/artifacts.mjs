/**
 * The optional prebuilt-artifacts package: is it here, is it the right one, and copying it in.
 *
 * `hydra-dev up` otherwise runs five `scarb build` invocations and a user waits ten to fifteen
 * minutes before anything starts. `@hydra/artifacts` holds the outputs of those five builds for
 * one pinned upstream revision, so `up` can copy instead of compile.
 *
 * ## THE VERSION CHECK IS A FAILURE, NOT A WARNING
 *
 * Artifacts correspond to exactly one `UPSTREAM_SHA`. A set built from a different revision is not
 * "slightly stale" — it declares classes whose hashes the checkout's own source does not produce,
 * and the first thing that notices is a `DECLARE` several steps later, or nothing at all. So a
 * mismatch refuses and falls back to building rather than being installed with a note.
 *
 * The `upstream checkout` row one function over uses `WARN` for a drifted checkout, and the
 * difference is worth stating: there, a human chose a revision and the tool declines to overwrite
 * their choice. Here nobody chose anything — a package fetched from a registry simply does not
 * match the source beside it, and using it would be the tool making the wrong call silently.
 *
 * ## BUILDING FROM SOURCE STAYS THE FALLBACK, AND THAT IS THE POINT
 *
 * Everything here is optional. Absent package, wrong revision, unreadable manifest: `up` builds
 * exactly as it did before. A prebuilt blob that became the ONLY path would make the stack
 * unreproducible from source, which is the property the artifacts are a shortcut around rather
 * than a replacement for.
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { UPSTREAM_SHA } from "./pins.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the package is, or null.
 *
 * Resolved rather than assumed: installed as a dependency it is under some `node_modules`, and in
 * this repository it is a workspace sibling. Asking the resolver first and falling back to the
 * sibling path covers both without the caller knowing which it is.
 */
export function artifactsRoot() {
  try {
    return dirname(createRequire(import.meta.url).resolve("@hydra/artifacts/package.json"));
  } catch { /* not installed as a dependency; try the workspace sibling */ }
  const sibling = join(HERE, "..", "..", "artifacts");
  return existsSync(join(sibling, "manifest.json")) ? sibling : null;
}

/**
 * What the package says it is: `{ root, upstreamSha, files, matches }`, or null when absent.
 *
 * `matches` is the whole question a caller has. It is computed here rather than by each caller
 * comparing two strings, because a comparison somebody has to remember to make is one somebody
 * eventually does not.
 */
export function artifactsPackage() {
  const root = artifactsRoot();
  if (!root) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    return {
      root,
      upstreamSha: manifest.upstreamSha,
      files: manifest.files ?? [],
      matches: manifest.upstreamSha === UPSTREAM_SHA,
    };
  } catch {
    // A package whose manifest cannot be read proves nothing about the files beside it.
    return null;
  }
}

/**
 * Copy the artifacts into the checkout, or say why not.
 *
 * **REFUSES ON A REVISION MISMATCH BEFORE COPYING ANYTHING**, rather than copying and reporting.
 * A half-installed wrong-version set is worse than none: the build hints would then see files
 * present and skip, leaving a tree that passes its checks and declares the wrong classes.
 *
 * It does not overwrite. A file already in the checkout was either built there or installed by an
 * earlier run, and a package silently replacing a locally built artifact would make "I rebuilt it"
 * stop being true.
 */
export function installArtifacts(upstreamDir) {
  const pkg = artifactsPackage();
  if (!pkg) return { ok: false, why: "no @hydra/artifacts package" };
  if (!pkg.matches) {
    return {
      ok: false,
      why: `@hydra/artifacts is built from ${pkg.upstreamSha?.slice(0, 12)} and the pin is `
        + `${UPSTREAM_SHA.slice(0, 12)} — not installing artifacts from a different revision`,
    };
  }
  let copied = 0;
  for (const { path, dest } of pkg.files) {
    // `path` is where the file sits in the package, `dest` where the checkout expects it. They
    // differ because `.gitignore` excludes `target/` everywhere and git cannot re-include a file
    // under an excluded directory — see `build-manifest.mjs`. The manifest carries both so this
    // does not reimplement the rule.
    const from = join(pkg.root, "artifacts", path);
    const to = join(upstreamDir, dest);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied++;
  }
  return { ok: true, copied, total: pkg.files.length };
}
