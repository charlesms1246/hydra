import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as res } from "node:path";

/**
 * `claims/src/statement.ts` is bundled into a browser, so nothing it reaches may be Node-only.
 *
 * **THE STATEMENT IS QUOTED ON A PAGE, AND A PAGE IS A BUNDLE.** `constants.ts` exists because
 * quoting a cover rate reached `identity/src/domains.ts` — key derivation, to name five bucket
 * sizes. This is the same shape one step along: quoting the jitter window reached
 * `channel/src/schedule.ts`, which imports `node:crypto` for the draw, so **a display value
 * dragged a random source into the browser** and the build failed on it.
 *
 * Not I6 — `schedule.ts` holds no key material — which is exactly why a separate guard is needed:
 * the boundary test would not have caught it and the failure was a bundler error nobody sees until
 * somebody builds the site.
 *
 * Walked rather than asserted per-file, because the edge that broke this was two hops away and a
 * check on `statement.ts`'s own imports would have passed.
 */
function closure(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f) || !existsSync(f)) return;
    seen.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)) {
      if (m[1]!.startsWith(".")) walk(res(dirname(f), m[1]!));
    }
  };
  walk(entry);
  return [...seen];
}

const nodeImports = (f: string) =>
  [...readFileSync(f, "utf8").matchAll(/from\s+"(node:[^"]+)"/g)].map((m) => m[1]!);

test("`constants.ts` IMPORTS NOTHING, WHICH IS THE WHOLE OF ITS PURPOSE", () => {
  // Asserted rather than assumed, because every other guard in this file leans on it: the fix for
  // a browser-unsafe edge is "quote the value from `constants.ts`", and that remedy is only true
  // while this holds. The file's own header says it — *"THIS FILE IMPORTS NOTHING, AND THAT IS ITS
  // ENTIRE PURPOSE"* — and a stated purpose with nothing checking it is a comment.
  const here = new URL("../../channel/src/constants.ts", import.meta.url).pathname;
  assert.deepEqual(closure(here), [here],
    "`channel/src/constants.ts` now imports something. Every claim that quotes a value from it "
    + "inherits whatever that reaches, which is the failure the file was created to end");
});

for (const entry of ["claims/src/statement.ts", "tui/src/view.ts", "channel/src/constants.ts"]) {
  test(`NOTHING ${entry} REACHES IS NODE-ONLY`, () => {
    const files = closure(new URL(`../../${entry}`, import.meta.url).pathname);
    // Not a floor of "more than one": `constants.ts` legitimately resolves to itself, and a guard
    // that demanded otherwise would be demanding the opposite of what that file is for.
    assert.ok(files.length >= 1, `${entry} resolved to nothing — the walk is broken`);
    const offenders = files.flatMap((f) => nodeImports(f).map((n) => `${f.split("/packages/")[1]} -> ${n}`));
    assert.deepEqual(offenders, [],
      `${entry} is bundled into a browser and reaches a Node-only module. It is not a key-material `
      + "problem, which is why the I6 boundary test does not catch it — it is a build failure that "
      + "appears only when somebody builds the site. Quote the VALUE from `channel/src/constants.ts` "
      + "rather than importing the module that implements the mechanism.");
  });
}
