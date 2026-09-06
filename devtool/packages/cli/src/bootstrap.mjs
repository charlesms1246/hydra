/**
 * `hydra-dev bootstrap` — install the node dependencies the packages need.
 *
 * A fresh clone has no node_modules, so the TUI died with a raw
 * ERR_MODULE_NOT_FOUND stack trace naming 'ink'. That is the first thing a new
 * user saw. This makes the fix one command, and cli.mjs points at it when an
 * import fails.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";


const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Packages with real dependencies, in the order a user is likely to need them. */
// cli has no dependencies: it reaches the SDK through the resolved upstream
// path, not a package import. It used to declare a file: dep it never used,
// which left a broken symlink in every fresh clone.
export const NEEDS_INSTALL = ["tui", "linter", "mcp"];

/**
 * Packages whose dependencies are not installed.
 *
 * ⚠ WALKS `node_modules` RATHER THAN TESTING A DIRECTORY OR AN IMPORT, and both of the simpler
 * versions were wrong in a way that only showed up under a real install.
 *
 * It was `!existsSync(join(dir, "node_modules"))`, a proxy for the question rather than the
 * question. That stopped being correct the moment this package declared `workspaces`: npm hoists
 * to `devtool/node_modules`, `packages/tui/node_modules` is never created, and the check reported
 * `tui` and `linter` as missing **forever** on a fresh clone where both were installed and
 * working. Measured before the rewrite.
 *
 * The obvious replacement — `createRequire(pkg).resolve(dep)` — is wrong in the other direction
 * and I shipped it for exactly one test run. `@modelcontextprotocol/sdk` publishes an `exports`
 * map with no `"."` entry, so the bare specifier is unresolvable **by design** while
 * `@modelcontextprotocol/sdk/server/mcp.js` imports fine. It reported `mcp` as missing on a
 * machine with the SDK sitting in `packages/mcp/node_modules`.
 *
 * So it asks the thing it actually wants to know: is the dependency's directory on the resolution
 * path from this package? That is hoist-tolerant like the import, and blind to `exports` maps,
 * which are a statement about what may be imported and not about what is installed.
 */
export function missingDeps() {
  return NEEDS_INSTALL.filter((name) => {
    const dir = join(REPO, "packages", name);
    const pkg = join(dir, "package.json");
    if (!existsSync(pkg)) return false;
    const deps = Object.keys(JSON.parse(readFileSync(pkg, "utf8")).dependencies ?? {});
    if (deps.length === 0) return false;
    return deps.some((dep) => !installed(dir, dep));
  });
}

/** Node's own lookup, for a directory rather than an entry point: every ancestor's node_modules. */
function installed(from, dep) {
  let at = from;
  for (;;) {
    if (existsSync(join(at, "node_modules", dep, "package.json"))) return true;
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
}

/**
 * One `npm install` at the devtool root, because `workspaces` makes that the whole job.
 *
 * It used to loop `NEEDS_INSTALL` running `npm install` with `cwd` set to each package. That was
 * the only way to do it without a workspace declaration, and it is the wrong way with one: npm
 * resolves the workspace root from any package inside it, so three installs would do the same
 * work three times and race each other over one lockfile.
 *
 * `only` is still honoured — `hydra-dev bootstrap tui` is in the help — but it now selects with
 * `--workspace`, which is npm's own way of saying the same thing.
 *
 * ⚠ THIS IS NO LONGER THE ONLY WAY IN. A user who ran `npm install` at `devtool/` after cloning
 * has already done this, and `missingDeps()` will agree because it asks whether the dependency is
 * on the resolution path rather than whether this command was the one that put it there. That is
 * the point of the change: the step people already know to run is now the step that works.
 */
export function bootstrap(only) {
  const args = ["install", "--no-fund", "--no-audit"];
  for (const name of only ?? []) {
    if (existsSync(join(REPO, "packages", name, "package.json"))) args.push("--workspace", `packages/${name}`);
  }
  console.log(`\n  installing${only?.length ? ` packages/${only.join(", packages/")}` : ""}…`);
  const r = spawnSync("npm", args, { cwd: REPO, stdio: "inherit" });
  const ok = r.status === 0;
  console.log(ok ? "\n  ready — run `hydra-dev` for the TUI\n" : "\n  install failed\n");
  return ok;
}
