/**
 * Assert that `out/` carries the assets it is supposed to carry — and refuses the ones it is not.
 *
 * ⛔ **THIS GATE INVERTS; IT DOES NOT GET DELETED.** One environment variable chooses which of two
 * failures it is looking for, and both are real:
 *
 *   `HYDRA_ASSETS=licensed`   the restricted files must be ABSENT, and `data-build="public"` must
 *                             be stamped. This is the posture that protects a third party's
 *                             trademark and a personal-use font licence from being redistributed
 *                             by a static host.
 *   `HYDRA_ASSETS=restricted` the restricted files must be PRESENT. A build that silently lost
 *                             them substitutes a fallback face and a plain glyph and **succeeds**,
 *                             which is the same class of silent-wrong-artefact failure in the
 *                             other direction and nothing else would catch it.
 *
 * ## Why it is on `restricted` today
 *
 * The user's decision, 2026-09-05, after being told the concern: *"ship it anyway (will replace
 * once commissioned work returns, currently we need it to verify the UI/UX and the rest)."* The
 * mark is Marvel's HYDRA insignia and the wordmark face is licensed for personal use. **This is a
 * held position pending commissioned art, not an oversight**, and it is the user's project and
 * their exposure to weigh.
 *
 * Reverting is one token here plus two elsewhere — see the block at the top of `.gitignore`, which
 * lists all three so nobody changes one and believes they are done.
 *
 * ## Why this is a script and not inline CI shell
 *
 * The same assertion guards the GitHub check and the host's build command. A copy in each is a
 * copy that drifts, and the one that drifts is the one nobody watches.
 */

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
