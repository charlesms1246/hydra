/**
 * `RemovalAuthority` — the mint, and the comparison.
 *
 * The type stops a user's value BECOMING an authority; `i8-must-not-compile.ts` proves that and
 * proves it at build time. This file covers what a type cannot: what the mint refuses to read out
 * of a file, and whether the comparison leaks how much of a guess was right.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removalAuthorityFromFile, authorises, MIN_LENGTH }
  from "../../vault-server/src/authority.ts";

const withFile = async (contents: string, fn: (path: string) => void | Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "hydra-auth-"));
  const path = join(dir, "removal.token");
  await writeFile(path, contents);
  try { await fn(path); } finally { await rm(dir, { recursive: true, force: true }); }
};

test("AN EMPTY TOKEN FILE IS REFUSED, not read as an authority", async () => {
  // The case that matters most, because it is the one that looks like it worked. `touch
  // removal.token` produces a file, an empty string, and a server that announces takedown as
  // ENABLED — while matching any caller who sends an empty header. That is E-UNREACHABLE
  // inverted: not a capability that cannot be performed, but one that appears armed and is open
  // to everyone. A whitespace-only file is the same thing with a keystroke in it.
  for (const contents of ["", "\n", "   \n\t "]) {
    await withFile(contents, (path) => {
      assert.throws(() => removalAuthorityFromFile(path), /is 0 characters|guessable/,
        `a token file containing ${JSON.stringify(contents)} was accepted`);
    });
  }
});

test("a secret shorter than the floor is refused, and the message says why", async () => {
  await withFile("short", (path) => {
    assert.throws(() => removalAuthorityFromFile(path),
      /removes anyone's public post and is guessable below 16/);
  });
  // The boundary itself, both sides, so the check is not off by one in the permissive direction.
  await withFile("x".repeat(MIN_LENGTH - 1), (path) => {
    assert.throws(() => removalAuthorityFromFile(path), /guessable/);
  });
  await withFile("x".repeat(MIN_LENGTH), (path) => {
    assert.doesNotThrow(() => removalAuthorityFromFile(path));
  });
});

test("a trailing newline does not change the secret", async () => {
  // A token file is written by a human and an editor adds one. Without the trim the header would
  // fail to match for a reason that sends somebody looking for a bug in the comparison.
  const secret = "a-long-enough-operator-secret";
  await withFile(`${secret}\n`, (path) => {
    assert.equal(removalAuthorityFromFile(path), secret);
    assert.ok(authorises(secret, removalAuthorityFromFile(path)));
  });
});

test("the comparison refuses everything but the secret, including the shapes that are not strings",
  async () => {
    const secret = "a-long-enough-operator-secret";
    await withFile(secret, (path) => {
      const authority = removalAuthorityFromFile(path);
      assert.ok(authorises(secret, authority));
      for (const wrong of ["", "a", `${secret} `, `${secret}x`, secret.slice(0, -1),
        secret.toUpperCase()]) {
        assert.ok(!authorises(wrong, authority), `${JSON.stringify(wrong)} was accepted`);
      }
      // A header can arrive repeated, in which case node hands over an ARRAY, and it can be
      // absent. `authorises` takes `unknown` on this side precisely because it is the runtime
      // half of the boundary — the type system does not reach a request header.
      for (const wrong of [undefined, null, 0, [secret], { toString: () => secret }]) {
        assert.ok(!authorises(wrong, authority), `${String(wrong)} was accepted`);
      }
      // And no authority configured refuses everything, which is the default the whole feature
      // rests on: an operator who has not said who may remove content has not said everyone may.
      assert.ok(!authorises(secret, undefined));
      assert.ok(!authorises("", undefined));
    });
  });

test("THE COMPARISON DOES NOT RETURN EARLY ON A WRONG PREFIX", async () => {
  // A `===` on a secret stops at the first differing byte, which times how much of a guess was
  // right and turns a search over the whole space into one over its length. Checked as a
  // PROPERTY of the implementation rather than by timing it: a wall-clock assertion on a CI box
  // is a flaky test that gets deleted, and what is actually being claimed is that the loop runs
  // to the end of the secret whatever the input.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../vault-server/src/authority.ts", import.meta.url), "utf8"));
  const body = src.slice(src.indexOf("export function authorises"));
  assert.ok(/diff \|=/.test(body), "authorises no longer accumulates a difference");
  assert.ok(!/return\s+(true|false)\s*;[\s\S]*charCodeAt/.test(
    body.slice(body.indexOf("for ("), body.indexOf("return diff"))),
    "authorises returns from inside its comparison loop, which restores the timing channel");
  // The length check before the loop is not a leak worth closing: the LENGTH of an operator's
  // secret is not the secret, and a variable-length compare that hid it would be slower on every
  // legitimate request to protect a fact an operator can publish.
  assert.ok(/offered\.length !== authority\.length/.test(body));
});
