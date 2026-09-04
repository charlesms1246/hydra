/**
 * The help text lists every command the CLI has.
 *
 * **THE REACHABILITY CLASS ONE LAYER UP: a mechanism reachable from code and not from a person.**
 * `post`, `fetch`, `audit` and `lookup` all existed and none appeared in `usage()`, so the product's
 * third surface — the one that days earlier existed in neither direction — was undiscoverable from
 * the interface. Nothing tells a user what a program does except its help.
 *
 * The cause was a hardcoded `slice(3, 30)` over the file's own header comment: adding commands
 * pushed the last ones past the cut, silently. A magic number that has to be updated in step with
 * the text above it is a number nobody updates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "..", "..", "cli", "src", "cli.ts");
const source = readFileSync(CLI, "utf8");

/** The header comment, which is what `usage()` prints. */
const help = source.split("\n").slice(3, source.split("\n").findIndex((l) => l.trim() === "*/"))
  .join("\n");

/** Every command the switch actually handles. */
const commands = [...source.matchAll(/^  case "([a-z-]+)":/gm)].map((m) => m[1]);

test("EVERY COMMAND THE CLI HANDLES IS IN ITS HELP", () => {
  assert.ok(commands.length > 15, `only ${commands.length} commands parsed — the scan is broken`);
  const missing = commands.filter((c) => !new RegExp(`hydra ${c}\\b`).test(help));
  assert.deepEqual(missing, [],
    `${missing.join(", ")} exist and the help does not mention them, so a user cannot find them. `
    + "A capability reachable from code and not from a person is unfinished in the same way as "
    + "one reachable from a test and not from an entry point.");
});

test("the help does not promise a command that is not there", () => {
  // The other direction, and the cheaper mistake to make: renaming a command and leaving the old
  // name in the text sends somebody to something that will only print the help again.
  const listed = [...help.matchAll(/^\s*hydra ([a-z-]+)/gm)].map((m) => m[1])
    .filter((c) => c !== "init");
  const absent = [...new Set(listed)].filter((c) => !commands.includes(c));
  assert.deepEqual(absent, [], `the help lists ${absent.join(", ")}, which the switch does not handle`);
});

test("the help renders to the end of its own comment, not to a line number", () => {
  // The mechanism that failed. Asserted directly so the magic number cannot come back: the last
  // command in the block must survive whatever length the block reaches.
  // Matched against CODE, not prose: the comment above `usage()` quotes the old `slice(3, 30)`
  // while explaining why it went, and the first version of this assertion fired on that. Sixth
  // time an accurate explanation has broken a guard here — the rule is the same every time, and
  // it is that a guard must measure the code and never the writing about it.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/slice\(3, \d+\)/.test(code),
    "usage() slices a hardcoded line range again — commands added below the cut vanish silently");
  assert.match(help, /hydra status/, "the last line of the help block is not being rendered");
});
