/**
 * Refuse to run the suites when the dependencies they import are absent.
 *
 * **`npm test` ON A FRESH CLONE DIED WITH `ERR_MODULE_NOT_FOUND: typescript` AND EXIT 1** — at
 * the step immediately before `npm publish`, where the natural reading is that the package is
 * broken. It is not: `typescript` is declared in `packages/linter/package.json`, a nested
 * `private: true` manifest that npm does not read on install, so `npm install` in this directory
 * does not and cannot provide it in a TARBALL INSTALL. The root manifest declares no dependencies.
 *
 * IT NOW DECLARES `workspaces`, AND THAT CHANGES ONE OF THE TWO CASES. In a CLONE, `npm install`
 * at this directory installs every nested package's dependencies, so the situation this file was
 * written to report no longer arises there — which is the point of the three-step setup. In a
 * TARBALL INSTALL nothing changes: npm applies `workspaces` only to the project you run it in,
 * never to a package being installed as a dependency. Verified by packing and installing the
 * tarball — one package, `hydra-dev` runs, `packages/tui/node_modules` still absent.
 *
 * So this file is still needed and its subject has narrowed: it is about the tarball case now.
 *
 * **THE PRODUCT ALREADY HANDLES THIS SITUATION CORRECTLY AND THE TEST RUNNER DID NOT.** From a
 * clean tarball install, `hydra-dev lint` prints *"linter dependencies not installed — run:
 * hydra-dev bootstrap linter"*, and `bootstrap linter` fixes it. Same product, same missing
 * dependency, two qualities of message. This gives the runner the runtime's message.
 *
 * **IT REFUSES RATHER THAN SKIPPING, and that is the point.** `npm test` is the gate before
 * `npm publish`; a suite that quietly skips lets the gate pass having tested less than it claims,
 * which is the vacuity failure this repository catalogues everywhere else. A gate that cannot be
 * satisfied by not looking.
 *
 * **BOTH SUITES, NOT THE ONE THAT CRASHED.** `packages/tui/test/render.mjs:17` imports `ink` and
 * has exactly the same latent failure; it was invisible only because `|| exit 1` aborts at the
 * linter first and never reaches it. Checking `missingDeps()` covers every package that declares
 * dependencies, including any added later.
 *
 * `missingDeps()` is imported rather than reimplemented — one definition of "installed", shared
 * with the `lint` command that already uses it.
 */

import { missingDeps } from "../packages/cli/src/bootstrap.mjs";

// No special case for the withheld `mcp` package: `missingDeps()` returns false for a package
// whose manifest is absent, so a fresh clone — which has no `packages/mcp` at all — reports
// exactly `tui, linter`, measured in both trees.
const missing = missingDeps();

if (missing.length) {
  console.error(`\n  dependencies not installed: ${missing.join(", ")}`);
  console.error(`  run:  node packages/cli/src/cli.mjs bootstrap ${missing.join(" ")}`);
  console.error("\n  These are declared in nested private manifests, so `npm install` here does");
  console.error("  not provide them. The suites import them directly and would fail with a raw");
  console.error("  ERR_MODULE_NOT_FOUND naming a package rather than a thing to do.\n");
  process.exit(1);
}
