/**
 * `hydra bootstrap` — install the node dependencies the packages need.
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

export function missingDeps() {
  return NEEDS_INSTALL.filter((name) => {
    const dir = join(REPO, "packages", name);
    const pkg = join(dir, "package.json");
    if (!existsSync(pkg)) return false;
    const deps = JSON.parse(readFileSync(pkg, "utf8")).dependencies ?? {};
    if (Object.keys(deps).length === 0) return false;
    return !existsSync(join(dir, "node_modules"));
  });
}

export function bootstrap(only) {
  const targets = only?.length ? only : NEEDS_INSTALL;
  let failed = 0;
  for (const name of targets) {
    const dir = join(REPO, "packages", name);
    if (!existsSync(join(dir, "package.json"))) continue;
    console.log(`\n  installing packages/${name}…`);
    const r = spawnSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: dir, stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`  packages/${name} failed`);
      failed++;
    }
  }
  console.log(failed === 0 ? "\n  ready — run `hydra` for the TUI\n" : `\n  ${failed} package(s) failed\n`);
  return failed === 0;
}
