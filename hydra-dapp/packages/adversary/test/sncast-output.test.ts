/**
 * Reading a transaction hash out of the tool that signs.
 *
 * **A REAL SEPOLIA TRANSACTION PRINTED `published undefined`.** The write landed, gas was spent,
 * and the client reported no id for it. `chain.publish` took the LAST json line sncast prints;
 * sncast 0.63 prints two, and the last is a `notification` carrying voyager links, with no
 * `transaction_hash` on it. `as string` made `undefined` typecheck as a `string` all the way to
 * the terminal.
 *
 * WHY NOTHING CAUGHT IT: the fake chain returns a hash directly, so the only thing under test was
 * the fake's own return. The parse is between the client and a subprocess — the same boundary as
 * the `verify.ts` selector and the 218,415-block scan, and the third one this week.
 *
 * THE FIXTURES ARE REAL CAPTURES, pasted from a live run against Sepolia, and they matter more
 * than the assertions: a hand-written approximation of another tool's output is a guess about the
 * thing that was wrong, and would have been written in the shape the bug assumed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { transactionHashFrom } from "../../cli/src/chain.ts";

/** Verbatim from `sncast 0.63.0 --json invoke` against Sepolia, both lines, in order. */
const REAL = '{"command":"invoke","transaction_hash":"0x07c0010dbba40fff915214f8b1fbaecf84449c4fc4f5f'
  + 'c9f45bfb6ba945510d1","type":"response"}\n'
  + '{"links":"transaction: https://sepolia.voyager.online/tx/0x07c0010dbba40fff915214f8b1fbaecf844'
  + '49c4fc4f5fc9f45bfb6ba945510d1","title":"invocation","type":"notification"}';

test("THE HASH IS FOUND THOUGH IT IS NOT THE LAST LINE", () => {
  assert.equal(transactionHashFrom(REAL),
    "0x07c0010dbba40fff915214f8b1fbaecf84449c4fc4f5fc9f45bfb6ba945510d1");
});

test("the last line alone is exactly the failure that shipped", () => {
  // Pinning the defect itself: the old code's input, and that it yields nothing rather than a
  // plausible-looking value. A parser that returned `undefined` here would reproduce the bug.
  const notification = REAL.split("\n")[1]!;
  assert.ok(!/"transaction_hash"/.test(notification),
    "the notification line now carries a hash, so this test no longer reproduces anything");
  assert.throws(() => transactionHashFrom(notification), /no transaction hash/);
});

test("a single-line output still works, because older sncast printed one", () => {
  assert.equal(transactionHashFrom('{"command":"invoke","transaction_hash":"0xabc123"}'), "0xabc123");
});

test("A THIRD LINE ADDED LATER MUST NOT BREAK IT — shape, not position", () => {
  // Position is what failed. If the next sncast appends a summary, the line holding a hash is
  // still the line holding a hash.
  const future = `${REAL}\n{"type":"notification","title":"summary","links":"done"}`;
  assert.equal(transactionHashFrom(future),
    "0x07c0010dbba40fff915214f8b1fbaecf84449c4fc4f5fc9f45bfb6ba945510d1");
});

test("AN ERROR IS REFUSED, and says the transaction may have been submitted anyway", () => {
  // Real error envelope, captured the same way.
  const err = '{"command":"call","error":"Function with selector \\"0x36\\" not found in ABI of the '
    + 'contract","type":"error"}';
  assert.throws(() => transactionHashFrom(err), (e: Error) => {
    assert.match(e.message, /no transaction hash/);
    // The dangerous retry is spending gas twice on a write that already landed. A parse failure
    // does NOT mean the transaction failed — that is exactly what happened on Sepolia.
    assert.match(e.message, /nonce/, "a parse failure that reads as 'not sent' invites a resend");
    assert.match(e.message, /not found in ABI/, "the tool's own words were swallowed");
    return true;
  });
});

test("non-hex, and a non-string, are both refused rather than cast", () => {
  // `as string` is what let `undefined` through. A number or a null must not become a hash.
  assert.throws(() => transactionHashFrom('{"transaction_hash":12345}'), /no transaction hash/);
  assert.throws(() => transactionHashFrom('{"transaction_hash":null}'), /no transaction hash/);
  assert.throws(() => transactionHashFrom('{"transaction_hash":"pending"}'), /no transaction hash/);
  assert.throws(() => transactionHashFrom("not json at all"), /no transaction hash/);
});
