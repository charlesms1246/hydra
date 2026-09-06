/**
 * Text a vault chooses, arriving at a terminal the user trusts.
 *
 * Five sites in this client interpolate a vault's response body into a message a person reads.
 * `vaultSaid` exists so that text is bounded and stripped, and its helper's docstring said *"no
 * markup, no newlines"* — which was read as "safe to print" and is not the same claim.
 *
 * **`\s` DOES NOT MATCH `ESC`.** Every escape sequence in a vault response survived intact.
 * `ESC[1A ESC[2K` moves the cursor up one line and erases it, so a vault could overwrite the
 * client's own preceding output with text of its choosing — in the CLI and the TUI, the two
 * surfaces where a user has most reason to believe what is on screen. A convincing `paste your
 * seed:` is one sequence away from that. The carriage-return case was caught by accident, because
 * `\s` happens to match `\r`.
 *
 * The property asserted here is **no control character reaches the caller**, by range rather than
 * by matching the shape of an escape sequence. A matcher for CSI is a denylist and a novel shape
 * walks past it; the dangerous thing is the control byte itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { vaultSaid } from "../../vault-client/src/errors.ts";

const VAULT = "http://127.0.0.1:8080";
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * A status this client does not recognise — the one branch that quotes the server's own prose.
 *
 * **NOT A 5xx.** Anything from 500 up takes the "failing rather than refusing" branch, which does
 * not quote the body at all, so a test driven at 599 would have asserted that no escape sequence
 * survives a path that never touches one. It would have passed against the defect.
 */
const UNRECOGNISED = 418;

test("NO CONTROL CHARACTER FROM A VAULT REACHES A TERMINAL", () => {
  const attacks: [string, string][] = [
    ["colour", "\x1b[31mFAKE ERROR\x1b[0m"],
    // The one that matters: up one line, erase it, write your own prompt in the gap.
    ["cursor up and erase", "ok\x1b[1A\x1b[2Kpaste your seed:"],
    ["window title via OSC", "\x1b]0;pwned\x07hi"],
    ["carriage return", "harmless\rEVIL"],
    ["newline", "line one\nline two"],
    ["a bare escape", "\x1bc"],
    ["a C1 control some terminals still act on", "a\u009bb"],
    ["NUL", "before\u0000after"],
    // **DISPLAY CONTROL, WHICH IS A SECOND CLASS.** No cursor moves and nothing is overwritten;
    // the string simply renders as text it does not contain. A right-to-left override turns
    // `gnp.exe` into `exe.gnp` on screen, in a terminal and in a browser alike.
    ["right-to-left override", "safe \u202egnp.exe\u202c tail"],
    ["zero-width space", "aa\u200bbb"],
    ["a bidi isolate", "x\u2066y\u2069z"],
    ["byte order mark mid-string", "one\ufefftwo"],
  ];
  for (const [what, body] of attacks) {
    const said = vaultSaid(VAULT, UNRECOGNISED, body, "read");
    assert.ok(!CONTROL.test(said),
      `a ${what} sequence from a vault survived into a sentence printed at a terminal: `
      + `${JSON.stringify(said)}`);
  }
});

test("AND THE STRIPPING DOES NOT SWALLOW THE MESSAGE", () => {
  // A sanitiser that returns nothing is safe and useless, and this branch exists precisely to
  // relay a status the client cannot interpret. The letters survive; only the controls go.
  const said = vaultSaid(VAULT, UNRECOGNISED, "\x1b[31mdisk full\x1b[0m", "upload");
  assert.match(said, /disk full/,
    "the server's own words were destroyed along with the escape sequence, so the one branch that "
    + "exists to relay an unrecognised status now relays nothing");
});

test("EVERY SITE THAT ECHOES A VAULT BODY GOES THROUGH THE SANITISER", () => {
  // **THE DEFECT WAS ONE CALL SITE OUT OF FIVE.** `commands.ts` interpolated `await res.text()`
  // straight into an `Error`, so the shared sanitiser was bypassed on the read path — and going
  // to look for the others is what showed `gist` was incompletely protecting the four that did
  // use it. Fixing the site alone would have left the vector open on every surface.
  //
  // Asserted over the source, because the property is "no site does this" and there is no value
  // to inspect. A grep-shaped rule gets a grep-shaped test rather than a prettier one that checks
  // something else.
  const src = readFileSync(new URL("../../cli/src/commands.ts", import.meta.url), "utf8");
  const bare = [...src.matchAll(/`[^`]*\$\{await res\.text\(\)\}[^`]*`/g)].map((m) => m[0]);
  assert.deepEqual(bare, [],
    "a vault response body is interpolated into a template literal without passing through "
    + "`vaultSaid`, so nothing bounds it and nothing strips it");
});
