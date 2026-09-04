/**
 * I6 — the claims package reaches no key derivation, transitively.
 *
 * `web/` renders `claims/src/statement.ts`, so **every module that file can reach is a module the
 * site's bundler can see.** `statement.ts` quoted a cover rate and a note width, which meant
 * importing `channel/src/cover.ts` and `channel/src/note.ts` — and both import
 * `identity/src/domains.ts`, which holds `POOL_DOMAIN`, `VAULT_DOMAIN` and `derive()`: the
 * derivation for **both** key classes I6 names.
 *
 * Nothing shipped. Every page is a server component, `statement()` runs at build time, and the
 * exported site contains no derivation. **That is a property of the rendering strategy, not of the
 * code** — one `"use client"` erases it silently. I6's point is that the mistake should be
 * uncompilable, and it was merely unrendered.
 *
 * THE SCAFFOLD'S PROPOSED CHECK WOULD HAVE PASSED THROUGHOUT. `FRONTEND-SCAFFOLD.md` asks that
 * `web/package.json` never list these packages — it does not and never will, because `web/` reaches
 * `hydra-dapp` by relative path. A guard whose scope excludes the thing it hunts is green forever,
 * which is the shape this repo has now met seven times. So this walks the actual import graph.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { codeOf } from "../src/prose.ts";

const ENTRY = resolve(import.meta.dirname, "..", "..", "claims", "src", "statement.ts");

/** Key material lives here. Reaching either from a rendered claim is the I6 crossing. */
const FORBIDDEN = ["identity/src/domains.ts", "identity/src/vault-key.ts"];

/** Every file reachable from an entry point, following relative imports. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const walk = (file: string, path: string[]) => {
    if (seen.has(file)) return;
    seen.set(file, path);
    if (!existsSync(file)) return;
    // Comments stripped: a file explaining that it deliberately does NOT import derivation must
    // not be read as importing it. Eighth time that would have mattered.
    const src = codeOf(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      walk(resolve(dirname(file), m[1]), [...path, file]);
    }
  };
  walk(entry, []);
  return seen;
}

const rel = (f: string) => f.slice(f.indexOf("packages/"));

test("NO CLAIM RENDERED BY THE SITE CAN REACH KEY DERIVATION", () => {
  const graph = reachable(ENTRY);
  assert.ok(graph.size > 5, `only ${graph.size} files walked — the graph walk is broken`);

  for (const forbidden of FORBIDDEN) {
    const hit = [...graph.keys()].find((f) => f.endsWith(forbidden));
    if (!hit) continue;
    const how = [...(graph.get(hit) ?? []), hit].map(rel).join("\n  -> ");
    assert.fail(`the claims package reaches ${forbidden}, so the site's bundler can see it:\n  `
      + `${how}\n\nQuote the VALUE, not the module that derives keys — see channel/src/constants.ts.`);
  }
});

test("the constants file it depends on instead imports nothing at all", () => {
  // The property that makes the extraction work rather than move the problem. A constants module
  // that imported anything would just be a longer path to the same place.
  const constants = resolve(import.meta.dirname, "..", "..", "channel", "src", "constants.ts");
  const imports = [...codeOf(readFileSync(constants, "utf8")).matchAll(/^\s*import\b/gm)];
  assert.deepEqual(imports.map((m) => m[0]), [],
    "channel/src/constants.ts imports something — it exists precisely so that quoting a number "
    + "drags nothing behind it");
});

test("the values did not change when they moved, and every old import still works", async () => {
  // A silent renumbering during an extraction would change what the product says about itself,
  // which is the one thing a claims package must not do quietly. Read through the ORIGINAL import
  // paths, because `cover.ts` and `note.ts` re-export so that nothing else had to change.
  const cover = await import("../../channel/src/cover.ts");
  const note = await import("../../channel/src/note.ts");
  const constants = await import("../../channel/src/constants.ts");
  assert.equal(constants.COVER_RATE, 4);
  assert.equal(constants.NOTE_FELTS, 2);
  assert.equal(cover.COVER_RATE, constants.COVER_RATE,
    "the re-export drifted from the value, so two numbers now describe one thing");
  assert.equal(note.NOTE_FELTS, constants.NOTE_FELTS);
  assert.equal(typeof cover.coverLeadMs, "function");
});
