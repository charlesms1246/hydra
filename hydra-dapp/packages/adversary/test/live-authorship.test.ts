/**
 * Who a real chain says wrote a message — both routes, measured.
 *
 * `chain-sender-disclosure.test.ts` is the hermetic version and models the attack. This is the
 * one that reads an actual transaction, because the claim being made is about what a node
 * serves to anyone who asks, and a model of that is not evidence.
 *
 * Two routes, and the result is not the one the design promises:
 *
 *   DIRECT   `sncast invoke` from the author's account.
 *            `sender_address` IS the author. `nonce` orders their messages.
 *
 *   POOLED   the pool invokes the contract on the author's behalf, submitted by a relayer.
 *            `sender_address` is the relayer's and the nonce is the relayer's — but the
 *            author's address is in the transaction anyway, because a pool transaction carrying
 *            only an invoke does not compile and every action that makes it compile names an
 *            address.
 *
 * So routing through the pool moves the disclosure out of `sender_address`. It does not remove
 * it. Worth measuring rather than assuming, because "we route through the pool" reads like a
 * fix and is not one.
 *
 * Opt-in, and it MUTATES: it registers accounts, publishes, and moves value. Devnet only.
 *
 *     source ~/.hydra/live-env.sh && npm run test:live
 *
 * These tests passed alone and failed in the suite, which is the worse way round to find out.
 * The cause was not what it looked like: `approve` SETS an ERC20 allowance rather than adding
 * to it, so a concurrent `shield` and `publish` on one account each approved their own amount,
 * the second overwrote the first, and whichever deposit ran last failed with "Insufficient
 * ERC20 allowance" — a message that sends you to look at balances. The fix is a per-account
 * queue in `devtool/packages/cli/src/control.mjs`, because an API that cannot be called twice
 * at once is broken wherever it is called from, not just from a test runner.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { starknet, poolChain } from "../../cli/src/chain.ts";

const RPC = process.env.HYDRA_RPC;
const CHANNEL = process.env.HYDRA_CHANNEL;
const CONTROL = process.env.HYDRA_CONTROL;
const ACCOUNTS = `${process.env.HOME}/.hydra/sncast-accounts.json`;

type Account = { name: string; address: string; flows?: boolean };
let accounts: Account[] = [];
/** The account `redeploy.ts` chose for direct signing. Read, not assumed. */
let deployer = 0n;
const addressOf = (name: string): bigint =>
  BigInt(accounts.find((a) => a.name === name)?.address
    ?? (() => { throw new Error(`no account called ${name} in the stack's state`); })());

async function rpc(method: string, params: unknown): Promise<any> {
  const res = await fetch(RPC!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Every felt anywhere in a transaction and its receipt. What a node hands anyone who asks. */
async function feltsOf(txHash: string): Promise<Set<bigint>> {
  const out = new Set<bigint>();
  const walk = (v: unknown): void => {
    if (typeof v === "string" && v.startsWith("0x")) {
      try { out.add(BigInt(v)); } catch { /* not a felt */ }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(await rpc("starknet_getTransactionByHash", { transaction_hash: txHash }));
  walk(await rpc("starknet_getTransactionReceipt", { transaction_hash: txHash }));
  return out;
}

const senderOf = async (txHash: string): Promise<bigint> =>
  BigInt((await rpc("starknet_getTransactionByHash", { transaction_hash: txHash })).sender_address);

before(async () => {
  assert.ok(RPC && CHANNEL && CONTROL,
    "set HYDRA_RPC, HYDRA_CHANNEL and HYDRA_CONTROL — see the header");
  // From the stack's own state file, NOT from the node's predeployed ordering. That ordering
  // is an implementation detail and it moved the moment `hydra up` began predeploying a third
  // user account — which it does so that direct signing has an address the control API is not
  // also signing for. A test that indexes into it is a test that silently checks the wrong
  // account.
  const state = JSON.parse(
    readFileSync(join(process.env.HOME!, ".hydra", "state.json"), "utf8")) as { accounts: Account[] };
  accounts = state.accounts;
  const sncast = JSON.parse(readFileSync(ACCOUNTS, "utf8")) as
    Record<string, Record<string, { address: string }>>;
  deployer = BigInt(Object.values(Object.values(sncast)[0])[0].address);
  assert.ok(![...accounts.filter((a) => a.flows || a.name === "admin")]
    .some((a) => BigInt(a.address) === deployer),
    "the direct-signing account is one the control API also signs for — two signers, one nonce");
  for (const who of ["alice", "bob"]) {
    // Registration is public and idempotent-by-failure; either outcome is fine here.
    await fetch(`${CONTROL}/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ who }),
    });
  }
});

const direct = (who: string) => starknet({
  rpcUrl: RPC!, contract: CHANNEL!, fromBlock: 0, accountsFile: ACCOUNTS, account: "deployer",
});

const pooled = (who: string) => poolChain({
  rpcUrl: RPC!, contract: CHANNEL!, fromBlock: 0, accountsFile: ACCOUNTS, account: "deployer",
  controlUrl: CONTROL!, who,
});

test("published directly, the transaction names the author as its sender", async () => {
  const tx = await direct("alice").publish([1001n, 1002n]);
  assert.equal(await senderOf(tx), deployer,
    "sender_address is not the publishing account — recheck chain.ts");
});

test("published through the pool, the sender is the relayer and not the author", async () => {
  // The half that works. An observer reading `sender_address` sees whoever submitted it, and a
  // relayer submits for everyone — so the field no longer answers "who wrote this".
  const tx = await pooled("alice").publish([2001n, 2002n]);
  const alice = addressOf("alice");
  const admin = addressOf("admin");
  const sender = await senderOf(tx);
  assert.notEqual(sender, alice, "the pool route still put the author in sender_address");
  assert.equal(sender, admin, "the submitter is not the relayer this stack uses");
});

test("but the author's address is in the calldata anyway, every time", async () => {
  // The half that does not. Measured rather than reasoned: publish as each of two people and
  // check that each transaction contains that person's address and not the other's.
  const aliceTx = await pooled("alice").publish([3001n, 3002n]);
  const bobTx = await pooled("bob").publish([4001n, 4002n]);
  const alice = addressOf("alice");
  const bob = addressOf("bob");

  const fromAlice = await feltsOf(aliceTx);
  const fromBob = await feltsOf(bobTx);

  assert.ok(fromAlice.has(alice), "alice's publish does not contain her address — the leak is closed, update the claims");
  assert.ok(fromBob.has(bob), "bob's publish does not contain his address — the leak is closed, update the claims");
  // And it is the AUTHOR specifically, not some address that happens to be in every pool
  // transaction: each contains its own author and not the other.
  assert.ok(!fromAlice.has(bob), "alice's publish names bob too — this test is not measuring authorship");
  assert.ok(!fromBob.has(alice), "bob's publish names alice too — this test is not measuring authorship");
});

test("an invoke with no private action beside it does not compile at all", async () => {
  // Why the address is there. The pool simulation emits no server message for a transaction
  // with nothing to compile, so a pointer cannot be published on its own — it has to ride
  // along with a private action, and every available one names an address.
  const res = await fetch(`${CONTROL}/publish`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ who: "alice", contract: CHANNEL, calldata: ["5001", "5002"], build: {} }),
  });
  const body = await res.json() as { ok: boolean; error?: string };
  assert.equal(body.ok, false, "an invoke-only pool transaction compiled — the constraint is gone");
  assert.match(String(body.error), /did not compile the actions|no server message/);
});

test("the free route works once per account, which is why messaging costs a deposit", async () => {
  // `autoSetup` contributes an `OpenChannel`, which is a server action and makes the
  // transaction compile. The SECOND time the channel already exists, so there is nothing to
  // compile and the same call fails — measured here rather than inferred, because "it worked
  // when I tried it" is exactly how a once-only path gets shipped.
  //
  // Alice has published through the pool above, so her self-channel is open already.
  const free = await fetch(`${CONTROL}/publish`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      who: "alice", contract: CHANNEL, calldata: ["7001", "7002"], attach: "none",
      build: { autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } },
    }),
  });
  const body = await free.json() as { ok: boolean; error?: string };
  assert.equal(body.ok, false,
    "the value-free pool route is repeatable after all — messaging need not cost a deposit, "
    + "and chain.ts should stop attaching one");
  assert.match(String(body.error), /did not compile the actions|no server message/);
});

test("the contract must return an empty deposits array or nothing publishes", async () => {
  // Found the hard way: `privacy_invoke` returning nothing made every pool-routed publish
  // revert with INVALID_INVOKE_RETURN_DATA, because the pool deserialises the return value as
  // `Span<OpenNoteDeposit>` (`.upstream/packages/privacy/src/utils.cairo:590-594`). The
  // snforge tests call the entrypoint directly and never saw it.
  //
  // Asserted by the fact that the publishes above succeeded at all, plus the shape on chain.
  const tx = await pooled("alice").publish([6001n, 6002n]);
  const receipt = await rpc("starknet_getTransactionReceipt", { transaction_hash: tx });
  assert.equal(receipt.execution_status, "SUCCEEDED", `pool publish reverted: ${receipt.revert_reason}`);
  const ours = receipt.events.filter((e: { from_address: string }) =>
    BigInt(e.from_address) === BigInt(CHANNEL!));
  assert.equal(ours.length, 1, "our contract did not emit exactly one event");
  assert.deepEqual(ours[0].data.map((d: string) => BigInt(d)), [6001n, 6002n]);
});
