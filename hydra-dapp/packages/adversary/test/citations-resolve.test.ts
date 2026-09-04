/**
 * Every citation in the generated statement resolves to a file a reader can open.
 *
 * **A STATEMENT WHOSE CITATIONS DO NOT RESOLVE IS THE DISCLOSURE METHOD FAILING AT ITS OWN CENTRAL
 * PROMISE.** The whole argument for generating claims from code rather than writing them is that a
 * reader can go and check; a path that does not resolve makes that offer and does not keep it.
 *
 * Nothing checked this until a citation audit found four broken ones at once:
 *
 *   - `i3-cover-traffic.test.ts` with no `adversary/test/` prefix — on the claim the site quotes
 *     most, the 20% / 2.8% cover-traffic pair.
 *   - Three claims citing `claude-docs/` paths, **two of them the auditor claims the site sets in
 *     the largest type on the page after the wordmark**. That directory is gitignored by standing
 *     decision, so those were uncheckable BY CONSTRUCTION rather than by accident: clone the
 *     repository, open the path, and it is not there — ever.
 *
 * The check lives here, beside the table, rather than in `web/`: the site renders these, so a
 * failure there fires in somebody else's lane for a defect committed in this one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { statement } from "../../claims/src/statement.ts";

const PACKAGES = join(import.meta.dirname, "..", "..");
const REPO = join(PACKAGES, "..", "..");

const claims = () => {
  const s = statement();
  return [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee];
};

/**
 * The openable paths in a `from`.
 *
 * A `from` is a comma-separated list, and an entry may carry a `(symbol)` or `(sym1\nsym2)` suffix
 * naming what in the file to look at, or a `:line`. The first version of this parser kept the
 * parenthetical and reported fifty resolving citations as broken — a guard wrong about its own
 * input is worse than no guard, because the noise is what gets it deleted.
 */
const paths = (from: string) => from
  .replace(/\([^)]*\)/g, "")
  .split(",")
  .map((p) => p.trim().split(":")[0].trim())
  // A CITATION IS ANYTHING THAT LOOKS LIKE A FILE, with or without a directory. Requiring a `/`
  // silently skipped bare filenames — which is exactly the defect that prompted this guard: the
  // cover-traffic claim cited `i3-cover-traffic.test.ts` with its `adversary/test/` prefix
  // missing, and a check that ignores unprefixed names cannot see that.
  .filter((p) => /\.(ts|tsx|js|md|cairo|toml|json)$/.test(p));

test("EVERY CITED PATH RESOLVES", () => {
  const all = claims();
  assert.ok(all.length > 40, `only ${all.length} claims — the statement did not generate`);
  const broken: string[] = [];
  for (const c of all) {
    for (const p of paths(c.from)) {
      // Cited relative to `hydra-dapp/packages`, which is how every other entry reads.
      if (!existsSync(join(PACKAGES, p)) && !existsSync(join(REPO, p))) broken.push(`${p}`);
    }
  }
  assert.deepEqual([...new Set(broken)], [],
    "these citations do not resolve, so the offer to go and check is not kept");
});

test("NO CITATION POINTS AT A PATH THAT CAN NEVER BE IN THE REPOSITORY", () => {
  // The sharper half, and the reason the three `claude-docs` ones survived: they named real files
  // on this machine, so an existence check run here would have passed. What makes them
  // uncheckable is that git will never hold them — `.gitignore` is a standing decision of the
  // user's, so it is not a state that gets fixed later.
  const ignored = ["claude-docs/", "findings/", "upstream-prs/", "packages/skills", "packages/mcp"];
  for (const c of claims()) {
    for (const p of paths(c.from)) {
      for (const dir of ignored) {
        assert.ok(!p.includes(dir),
          `"${c.says.slice(0, 60)}…" cites ${p}, which is gitignored and will never be in a `
          + "clone. A citation is a promise a reader can follow; put it in `decides` instead.");
      }
    }
  }
});

test("every cited path is tracked by git, not merely present on this machine", () => {
  // Existence is the weaker check: a file can be here and untracked, which is exactly the state
  // of everything in `.gitignore`. This is the one that would have caught all three at once.
  let tracked: Set<string>;
  try {
    tracked = new Set(execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
      .split("\n").filter(Boolean));
  } catch {
    // A missing git is a FAILURE, not a skip — an unrun check reported as green is how a
    // guarantee stops being one.
    assert.fail("git is not available, so this check cannot run and must not report success");
  }
  const untracked: string[] = [];
  for (const c of claims()) {
    for (const p of paths(c.from)) {
      const candidates = [`hydra-dapp/packages/${p}`, `hydra-dapp/${p}`, p];
      if (!candidates.some((q) => tracked.has(q))) untracked.push(p);
    }
  }
  assert.deepEqual([...new Set(untracked)], [],
    "these cited paths are not tracked by git, so a reader who clones cannot open them");
});

test("a claim with no source cannot be published, and `decides` is not a citation", () => {
  for (const c of claims()) {
    assert.ok(c.from.trim().length > 0, `"${c.says.slice(0, 50)}…" has no source`);
    assert.ok(paths(c.from).length > 0, `"${c.says.slice(0, 50)}…" cites nothing openable`);
    // `decides` points at a document a reader outside this machine cannot open. It exists so the
    // reference is not lost, and it must stay out of the rendered citation.
    if (c.decides) assert.ok(!c.from.includes(c.decides), `${c.decides} leaked into a citation`);
  }
});
