/**
 * Refuse to publish anything but the public build.
 *
 * ⛔ **`next build` copies `public/` into `out/`, and the build SUCCEEDS while doing it.** On any
 * developer's machine that directory holds `NON-Natural-Grotesk-Regular.woff2`, licensed for
 * personal use, and `hydra.svg`, a third party's trademark. Publishing `out/` redistributes both
 * exactly as committing them would. The page looks correct either way; nothing fails, nothing
 * warns. That is the whole reason this file exists.
 *
 * `build:public` substitutes both and stamps `data-build="public"` on the document. This asserts
 * the stamp is there and that neither asset reached the output.
 *
 * **It is a script rather than inline CI shell because it must run in two places.** The same
 * assertion guards the GitHub Actions check and the host's build command; a copy in each is a copy
 * that drifts, and the one that drifts is the one nobody watches.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "out");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const fail = (msg: string) => {
  // `::error::` is GitHub Actions' annotation prefix and plain text everywhere else, so one line
  // serves both hosts.
  console.error(`::error::${msg}`);
  process.exitCode = 1;
};

if (!existsSync(join(OUT, "index.html"))) {
  fail(`${OUT}/index.html is missing — nothing was built.`);
  process.exit(1);
}

if (!readFileSync(join(OUT, "index.html"), "utf8").includes('data-build="public"')) {
  fail(
    'out/index.html carries no data-build="public" — it was produced by `build`, not ' +
    "`build:public`. Refusing to publish: a silent fallback to the local build is the licensing " +
    "exposure with an automation in front of it.",
  );
}

const RESTRICTED = /NON-Natural|^hydra\.svg$|^icon\.svg$/i;
for (const file of walk(OUT)) {
  const name = file.split("/").pop() ?? "";
  if (RESTRICTED.test(name)) fail(`${file} reached out/ — refusing to publish a restricted asset.`);
}

if (process.exitCode) process.exit(1);
console.log("out/ is the public build and carries no restricted asset.");
