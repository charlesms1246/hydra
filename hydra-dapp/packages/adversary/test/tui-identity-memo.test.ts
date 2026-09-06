/**
 * The Identity page's summary, and the two ways its cache can lie.
 *
 * The fingerprint is what users read aloud to each other to check they are talking to who they
 * think. The epoch and the one-time count are what tells somebody whether strangers can still
 * open a conversation with them. All three come from a memo, because deriving them is an HKDF and
 * two key generations and doing it per keystroke would be silly — so the memo is load-bearing and
 * both of its failure modes are user-visible.
 *
 * **IT HAS BEEN WRONG IN BOTH DIRECTIONS IN ONE DAY**, which is why this file exists rather than an
 * assertion tacked onto a render test:
 *
 *   - Keyed on `${seedHex}:${epoch}:${oneTimeLeft}`, it was correct and kept the raw vault root in
 *     a module-scope string for the life of the process — fine in a Node process, disqualifying
 *     in the browser bundle `web/` now serves, and unclearable either way.
 *   - Keyed on the state OBJECT, it carried no secret and went stale: `State` is mutated in place,
 *     so a rotation changed the content without changing the identity of the key.
 *
 * The fix is not a third key. It is the object for collision-freedom and lifetime, plus the
 * invalidating fields compared in the value.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { start, viewOf } from "../../tui/src/app.ts";
import { init, rotatePrekey } from "../../cli/src/commands.ts";
import type { State } from "../../cli/src/state.ts";

const fresh = (): State => init({ vaultUrl: "http://127.0.0.1:1", contract: "0x1", fromBlock: 1 });
function summary(state: State) {
  const identity = viewOf({ ...start(state, 0), state }).client?.identity;
  // Not `!`: a null here means the view stopped carrying the summary, and every assertion below
  // would then be checking a shape rather than a value.
  assert.ok(identity, "the view carries no identity summary, so this file measures nothing");
  return identity;
}

test("THE SUMMARY FOLLOWS A ROTATION THAT MUTATED THE STATE IN PLACE", () => {
  // `rotatePrekey` writes through `state.prekeys` and the effect that calls it returns THE SAME
  // OBJECT, so a memo keyed on object identity alone never invalidates. Measured before the fix:
  // the page went on reporting epoch 0 and 20 one-time keys after a rotation, indefinitely.
  const state = fresh();
  const before = summary(state);
  assert.equal(before.epoch, 0, "the fixture did not start where this test assumes");

  rotatePrekey(state);
  const after = summary(state);
  assert.equal(after.epoch, before.epoch + 1,
    `the identity summary reports epoch ${after.epoch} after a rotation to `
    + `${state.prekeys.epoch} — the cache did not notice a mutation through the same object`);
});

test("AND FOLLOWS A CONSUMED ONE-TIME KEY", () => {
  // The commoner case: every stranger who opens a conversation spends one. A count that only ever
  // reports its starting value tells somebody they are still reachable when they are not.
  const state = fresh();
  const before = summary(state);
  const keys = Object.keys(state.prekeys.oneTime);
  assert.ok(keys.length > 0, "the fixture minted no one-time keys, so this measures nothing");

  delete (state.prekeys.oneTime as Record<string, string>)[keys[0]!];
  assert.equal(summary(state).oneTimeLeft, before.oneTimeLeft - 1,
    "the one-time count did not follow a consumed key");
});

test("TWO IDENTITIES DO NOT SHARE AN ENTRY, AND NEITHER PUTS ITS SEED IN THE KEY", () => {
  // **THE COLLISION THE OBVIOUS FIX WOULD HAVE HAD.** `epoch:oneTimeLeft` looks unique and is not:
  // every freshly minted identity is epoch 0 with the same count, and `effects.ts` can mint one
  // in-process. Two states, identical counts, different seeds — the summaries must differ.
  const a = fresh();
  const b = fresh();
  assert.notEqual(a.seedHex, b.seedHex, "the fixture minted one seed twice");
  assert.equal(a.prekeys.epoch, b.prekeys.epoch);

  const first = summary(a);
  const second = summary(b);
  assert.notEqual(second.fingerprint, first.fingerprint,
    "two identities with the same epoch and one-time count returned one fingerprint — a user "
    + "would be shown somebody else's, which is the value they read aloud to verify each other");
});

test("THE MEMO IS NOT KEYED ON THE SEED, ASSERTED AGAINST THE SOURCE", () => {
  // Deliberately a source assertion: the property is "this secret is not in that scope", and there
  // is no value to inspect from outside. The same shape as the constant-time token check.
  const src = readFileSync(new URL("../../tui/src/app.ts", import.meta.url), "utf8");
  // **THE KEY REGION, NOT THE FUNCTION.** The first version of this sliced to the end of
  // `identityOf` and failed on the derivation, which reads `state.seedHex` because that is its
  // whole job. What must not touch the seed is the part that decides a cache HIT — everything
  // before the miss path begins.
  const from = src.indexOf("const identities = new WeakMap");
  const to = src.indexOf("const root = derive", from);
  assert.ok(from > 0 && to > from, "the memo could not be located — this test measures nothing");
  const key = src.slice(from, to);
  assert.ok(!/seedHex/.test(key),
    "the identity cache key mentions `seedHex` — the raw vault root in a cache key is a second "
    + "copy in a scope nothing can clear, and it ships to a browser with this file");
  assert.match(key, /identities\.get\(state\)/,
    "the cache is no longer looked up by the state object, which is what stops two identities "
    + "with the same epoch and count sharing an entry");
});
