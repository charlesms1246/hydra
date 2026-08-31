/**
 * The transaction says who sent it, and the whole timing defence is downstream of that.
 *
 * Found by running the CLI against a real devnet and then looking at the transaction rather
 * than at the event. Every I3 harness in this directory measures an operator who has to
 * correlate a vault upload with a chain event, and jitter and cover make that hard — 0.2 at the
 * floor. None of them asked what the CHAIN alone discloses, because `note.ts` guarantees the
 * event carries two felts and nothing else, and that guarantee is true.
 *
 * It is also not the question. An event is inside a transaction, and the transaction is signed:
 *
 *     sender_address  0x34ba56f9…   the account that submitted it
 *     nonce           0x6           its position in that account's sequence
 *
 * So an observer reading the chain — not the vault operator, anyone — learns who published each
 * pointer and in what order, without correlating anything. The measured 0.2 is about which
 * upload holds the content. Authorship was never in question, because it was never hidden.
 *
 * THE DESIGN INTENDS OTHERWISE, AND IT IS NOT ENOUGH. `note.ts` explains the route: the pool
 * invokes an external contract at `selector!("privacy_invoke")` as part of a private action
 * (`.upstream/packages/privacy/src/utils.cairo:84`, dispatched at `privacy.cairo:878-886`), so
 * the caller on chain is THE POOL. That route now exists — `cli/src/chain.ts` `poolChain` — and
 * `live-authorship.test.ts` measures what it buys against a real chain: the author leaves
 * `sender_address` and the nonce ordering, and stays in the calldata.
 *
 * This file measures the gap rather than describing it, and fails if anyone closes it in prose.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { statement } from "../../claims/src/statement.ts";
import { MEASURED } from "../../claims/src/statement.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** What an observer reads off a transaction, as opposed to off its event. */
type Tx = { readonly sender: string; readonly nonce: number; readonly pointer: bigint };

/**
 * The attack, which is not really an attack: read the transactions, group by sender, order by
 * nonce. No timing, no correlation, no vault access.
 */
function authorship(txs: readonly Tx[]): Map<string, bigint[]> {
  const bySender = new Map<string, Tx[]>();
  for (const tx of txs) {
    const list = bySender.get(tx.sender) ?? [];
    list.push(tx);
    bySender.set(tx.sender, list);
  }
  return new Map([...bySender].map(([s, list]) =>
    [s, list.sort((a, b) => a.nonce - b.nonce).map((t) => t.pointer)]));
}

test("with a direct invoke, authorship is identified every time", () => {
  // Two people, interleaved, with jitter and cover doing whatever they like — none of it
  // touches this. The operator is right about who wrote each pointer 1.000 of the time.
  const alice = "0xa11ce";
  const bob = "0xb0b";
  const truth: Tx[] = [];
  for (let i = 0; i < 12; i++) {
    truth.push({ sender: alice, nonce: i, pointer: BigInt(1000 + i) });
    truth.push({ sender: bob, nonce: i, pointer: BigInt(2000 + i) });
  }
  // Shuffled, because block order is not send order and it does not matter.
  const seen = [...truth].sort((a, b) => Number(a.pointer % 7n) - Number(b.pointer % 7n));

  const recovered = authorship(seen);
  assert.deepEqual(recovered.get(alice), truth.filter((t) => t.sender === alice).map((t) => t.pointer));
  assert.deepEqual(recovered.get(bob), truth.filter((t) => t.sender === bob).map((t) => t.pointer));

  const hits = truth.filter((t) => recovered.get(t.sender)!.includes(t.pointer)).length;
  assert.equal(hits / truth.length, 1,
    "if this is ever below 1 the direct-invoke path has changed and this file is stale");
  // For contrast: the number the product publishes about the vault operator, which is a
  // different observer answering a different question.
  assert.ok(MEASURED.isolatedMessageIdentified < 0.25);
});

test("routing through the pool does NOT remove the sender, which is the expensive part", () => {
  // The correction to this file's own first draft. It said routing through the pool was the
  // fix; `live-authorship.test.ts` measured it on a real chain and it is not. The pool route
  // moves the author out of `sender_address` and out of the nonce ordering — real, and worth
  // having — and leaves the address in the calldata, because a pool transaction carrying only
  // an invoke does not compile and every action that makes it compile names an address.
  //
  // Structural here, measured there: both routes exist in `chain.ts`, and both are disclosed.
  const chain = readFileSync(join(HERE, "..", "..", "cli", "src", "chain.ts"), "utf8");
  assert.ok(/export function starknet\b/.test(chain), "the direct route is gone");
  assert.ok(/export function poolChain\b/.test(chain), "the pool route is gone");
  assert.ok(/does not remove the author|DOES NOT REMOVE THE AUTHOR/i.test(chain),
    "chain.ts no longer says that the pool route leaves the author in the transaction");
});

test("the disclosure statement does not claim the chain hides the sender", () => {
  // The correction. The statement used to say the chain shows "two values, neither of which
  // says who sent it" — true of the EVENT and false of the transaction that carries it, which
  // is what "anyone reading the blockchain" actually reads. A claim scoped to the event while
  // describing the chain is the most expensive kind of true statement.
  const said = statement().whoCanSeeWhat.map((c) => c.says).join(" ")
    + statement().whatIsPartial.map((c) => c.says).join(" ");
  assert.ok(!/neither of which says who sent it/.test(said),
    "the statement still claims the chain does not disclose the sender");
  assert.ok(/which account published/i.test(said),
    "the statement does not say that the publishing account is visible");
  // And it is stated as unconditional, not as another probability.
  assert.ok(/every time/i.test(said),
    "the sender disclosure is described as if it were sometimes");
});

test("the number the statement publishes for it is 1, not a fraction", () => {
  // Published as a certainty because it is one. Rounding it into the timing numbers would make
  // an unconditional disclosure look like a probabilistic one.
  assert.equal(MEASURED.senderIdentifiedOnChain, 1);
});
