
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "out");

/**
 * Which posture this build is in. Defaults to `restricted`, matching the current decision — a
 * default of `licensed` would fail every ordinary build and teach people to pass the flag without
 * reading why it exists.
 */
const MODE = process.env.HYDRA_ASSETS === "licensed" ? "licensed" : "restricted";

/** Files that are a licence question. Named once; both modes read the same list. */
const RESTRICTED = [
  "fonts/NON-Natural-Grotesk-Regular.woff2",
  "hydra.svg",
  "icon.svg",
];

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

const index = readFileSync(join(OUT, "index.html"), "utf8");
const files = walk(OUT);
const found = new Map(
  RESTRICTED.map((r) => [r, files.filter((f) => f.endsWith(`/${r}`))] as const),
);

/* Vacuity: an empty output directory would satisfy an absence check by having nothing in it. */
if (files.length < 10) {
  fail(`out/ holds ${files.length} files — too few for this check to mean anything.`);
  process.exit(1);
}

if (MODE === "licensed") {
  if (!index.includes('data-build="public"')) {
    fail(
      'out/index.html carries no data-build="public" — it was produced by `build`, not '
      + "`build:public`. Refusing to publish: a silent fallback to the local build is the "
      + "licensing exposure with an automation in front of it.",
    );
  }
  for (const [name, hits] of found) {
    for (const f of hits) fail(`${f} reached out/ — refusing to publish ${name}.`);
  }
} else {
  if (index.includes('data-build="public"')) {
    fail(
      'out/index.html carries data-build="public" — it was produced by `build:public`, which '
      + "substitutes the wordmark face and the mark. This build is meant to carry the real ones; "
      + "either drop HYDRA_PUBLIC or set HYDRA_ASSETS=licensed.",
    );
  }
  for (const [name, hits] of found) {
    if (hits.length === 0) {
      fail(
        `${name} is missing from out/. The build succeeded without it, which means the page is `
        + "showing a fallback face or a substitute glyph while claiming to show the real one — "
        + "the same silent-wrong-artefact failure this gate catches in the other direction.",
      );
    }
  }
}

if (process.exitCode) process.exit(1);
console.log(
  MODE === "licensed"
    ? `out/ is the public build and carries none of the ${RESTRICTED.length} restricted assets.`
    : `out/ carries all ${RESTRICTED.length} restricted assets, as HYDRA_ASSETS=restricted requires.`,
);
