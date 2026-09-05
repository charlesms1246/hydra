/**
 * Every command this product tells a user to type must be one the CLI dispatches.
 *
 * **`hydra gui` WAS NAMED THREE TIMES IN ITS OWN MODULE HEADER AND PRINTED IN ITS OWN STARTUP
 * BANNER, AND WAS NOT A COMMAND.** A user read it off the thing they had just started, typed it,
 * and got the CLI's usage text. Two independent, true-sounding sources agreed, and neither of them
 * was the dispatcher.
 *
 * The general form, which is why this is a test rather than a fix: **a verified premise plus a
 * verified consequence is still not a verified path.** The header was right about what the product
 * should be and the banner was right about what was running; the sentence they jointly implied —
 * that typing it works — was true of neither.
 *
 * It scans user-facing text rather than comments, because a comment describing a command that does
 * not exist is a documentation problem and this is a product one: the string reaches a user.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");
const CLI = join(PACKAGES, "cli", "src", "cli.ts");

/** Read tolerantly: `inbox.ts` has a deliberate NUL and a strict decode would skip a whole file. */
const read = (path: string) => readFileSync(path).toString("utf8");

/**
 * Surfaces that print `hydra …` at somebody.
 *
 * `gui/src/main.ts` is here because it is the one that was wrong: it is not the CLI, it names CLI
 * commands, and nothing connected the two.
 */
const SURFACES = [
  join(PACKAGES, "cli", "src", "cli.ts"),
  join(PACKAGES, "gui", "src", "main.ts"),
  join(PACKAGES, "tui", "src", "main.ts"),
  join(PACKAGES, "tui", "src", "view.ts"),
  join(PACKAGES, "tui", "src", "app.ts"),
];

test("EVERY `hydra <command>` A SURFACE PRINTS IS ONE THE CLI DISPATCHES", () => {
  const dispatched = new Set([...read(CLI).matchAll(/case "([a-z-]+)"/g)].map((m) => m[1]!));
  assert.ok(dispatched.size > 10, `only ${dispatched.size} cases found — the scan is broken`);

  const undispatched: string[] = [];
  for (const file of SURFACES) {
    for (const m of read(file).matchAll(/hydra ([a-z][a-z-]*)/g)) {
      const command = m[1]!;
      if (!dispatched.has(command)) undispatched.push(`${file.split("/").slice(-3).join("/")}: hydra ${command}`);
    }
  }
  assert.deepEqual(undispatched, [],
    "these surfaces tell a user to type a command the CLI does not dispatch, so typing it prints "
    + "the usage text. `hydra gui` shipped that way: named in its own header and its own startup "
    + "banner, and not a case in cli.ts");
});
