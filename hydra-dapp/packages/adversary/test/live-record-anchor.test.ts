/**
 * The record on a real chain — the step `decisions/0031` left open.
 *
 * Everything in `0031` was established with `starknet_call` and `starknet_simulateTransactions`
 * using SKIP_VALIDATE and other people's accounts. That proves the contract's logic and our
 * calldata encoding; it does not prove a funded account signs and lands it, and the difference
 * is exactly the kind of gap this project refuses to paper over.
 *
 * TWO MODES, and the default is the safe one:
 *
 *   HYDRA_RPC=https://api.cartridge.gg/x/starknet/sepolia npm run test:live
 *       Read-only. Confirms the deployed class is still the one this code was written against,
 *       reads a record slot through the real entrypoint, and proves the WRITE calldata
 *       deserializes — by checking the write reverts on OWNERSHIP rather than on deserialization.
 *       That distinction is the whole argument order, and it costs nothing to check.
 *
 *   HYDRA_ANCHOR_SEND=1 HYDRA_RPC=... npm run test:live
 *       Mints an identity if needed and lands a real record. Spends testnet STRK and writes
 *       permanently to a public chain, which is why it is a separate opt-in rather than a flag
 *       somebody sets once and forgets.
 *
 * A missing variable fails rather than skips, for the usual reason.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  IDENTITY_CLASS_HASH, SET_SELECTOR,
  identityContract, writeRecordCalldata, readRecordCall, decodeRecordReply,
} from "../../cli/src/anchor.ts";
import { RECORD_FELTS, decodeRecord, verifyRecord } from "../../handshake/src/record.ts";
import { init, myRecord } from "../../cli/src/commands.ts";

const RPC = process.env.HYDRA_RPC;
const SEND = process.env.HYDRA_ANCHOR_SEND === "1";
const NETWORK = process.env.HYDRA_NETWORK ?? "sepolia";
const ACCOUNTS = process.env.HYDRA_ACCOUNTS ?? join(homedir(), ".hydra", "sepolia-accounts.json");
const ACCOUNT = process.env.HYDRA_ACCOUNT ?? "hydra";

const rpc = async (method: string, params: unknown): Promise<any> => {
  const res = await fetch(RPC!, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { throw new Error(`non-JSON reply: ${text.slice(0, 120)}`); }
  return body;
};

/** A call that is allowed to revert — the revert reason is the thing being measured. */
const callRaw = (contract: string, selector: string, calldata: string[]) =>
  rpc("starknet_call", [
    { contract_address: contract, entry_point_selector: selector, calldata }, "latest"]);

const okResult = (body: any, what: string): string[] => {
  if (body.error) throw new Error(`${what}: ${JSON.stringify(body.error).slice(0, 400)}`);
  return body.result;
};

/** The `owner_from_id` selector, used to tell a minted id from a free one. */
const OWNER_FROM_ID = "0x1d233f504e7ffa8a145338134e765d2ffe365291610c05c2ecc615f3596c59a";
/**
 * `get_main_id(user)` — how a stranger goes from an address to the id a record lives under.
 *
 * starknet_keccak of the name, masked to 250 bits, and confirmed present in the deployed class's
 * EXTERNAL entry points. The first version of this line was a selector I typed from memory; it is
 * a 250-bit number and a wrong one does not fail loudly, it fails as "entrypoint not found" or,
 * worse, as somebody else's function.
 */
const GET_MAIN_ID = "0x108d63199bb92aa213225174d82be925dc326995019eb66c83b1cc38b90642e";

/** An id somebody owns, so the ownership gate is what stops a probe write. */
async function findOwnedId(): Promise<bigint> {
  for (const id of [1n, 2n, 3n]) {
    const r = okResult(await callRaw(contract, OWNER_FROM_ID, [`0x${id.toString(16)}`]),
      "owner_from_id");
    if (BigInt(r[0]) !== 0n) return id;
  }
  throw new Error("no minted identity found among ids 1-3; pick another probe id");
}

let contract = "";
/** The identity id this account uses. Derived, positive, and stable across runs. */
let ID = 0n;
const OWNER = () => BigInt(
  execFileSync("sncast", ["--json", "--accounts-file", ACCOUNTS, "--account", ACCOUNT,
    "account", "list"], { encoding: "utf8" }).match(/0x[0-9a-f]{60,64}/)![0]);

before(() => {
  assert.ok(RPC, "HYDRA_RPC is required — see the header");
  contract = identityContract(NETWORK);
  // Derived from the account so two machines do not collide, masked to a u128 and forced
  // non-zero — id 0 reads as absent on this contract.
  ID = (OWNER() % ((1n << 128n) - 2n)) + 1n;
});

test("the deployed class is still the one this code was written against", async () => {
  // The pinned selectors, the argument order and both gotchas are properties of ONE class hash.
  // An upgrade invalidates all of it, and silently: the calls would still deserialize.
  const got = okResult(await rpc("starknet_getClassHashAt", ["latest", contract]), "getClassHashAt");
  assert.equal(BigInt(got as unknown as string), BigInt(IDENTITY_CLASS_HASH),
    `the identity contract on ${NETWORK} was upgraded — re-verify decisions/0031 before writing`);
});

test("the read entrypoint answers, and an unwritten slot is absent rather than zeroes", async () => {
  const call = readRecordCall(ID, NETWORK);
  const reply = okResult(
    await rpc("starknet_call", [call, "latest"]), "get_extended_user_data");
  assert.equal(reply.length, RECORD_FELTS + 1, "the span header plus its felts");
  assert.equal(BigInt(reply[0]), BigInt(RECORD_FELTS));
  // Either absent (never written) or a real record — both are fine, and `decodeRecordReply` is
  // what tells them apart. This asserts it does not throw on live bytes.
  const felts = decodeRecordReply(reply);
  assert.ok(felts === null || felts.length === RECORD_FELTS);
});

test("THE ARGUMENT ORDER IS RIGHT, proven without sending anything", async () => {
  // The write reverts from an unowned caller. WHICH revert is the whole point:
  //
  //   "you don't own this id"       -> the calldata deserialized; only the ownership gate stopped it
  //   "Failed to deserialize param" -> the argument order or arity is wrong
  //
  // A correct-looking call that fails deserialization is the failure `0027` refused to risk, and
  // this distinguishes them for free, on the real contract, before a fee is ever paid.
  //
  // IT MUST BE AN ID SOMEBODY OWNS, and finding that out cost a red test. `starknet_call` executes
  // with caller address ZERO, and `owner_from_id` returns ZERO for an unminted id — so against a
  // free id the ownership check compares 0 to 0, passes, and the call returns success. That is an
  // artefact of the static call rather than a way in: a real transaction has a non-zero caller,
  // which is exactly what makes it fail. Probing a free id would have proved nothing while looking
  // like it proved everything.
  const owned = await findOwnedId();
  const good = writeRecordCalldata(owned, Array.from({ length: RECORD_FELTS }, (_, i) => BigInt(i + 1)));
  const body = await callRaw(contract, SET_SELECTOR, good);
  const text = JSON.stringify(body);
  assert.ok(!/Failed to deserialize/.test(text),
    `the write calldata did not deserialize — the argument order is wrong:\n${text.slice(0, 500)}`);
  assert.ok(/own this id/.test(text),
    `expected the ownership gate to be what stops this, got:\n${text.slice(0, 500)}`);

  // The negative control, so the check above is known to be able to fail: the same call with the
  // trailing domain removed is the mistake, and it must fail differently.
  const bad = JSON.stringify(await callRaw(contract, SET_SELECTOR, good.slice(0, -1)));
  assert.ok(/Failed to deserialize/.test(bad),
    `dropping the trailing domain still deserialized — then this test proves nothing:\n${bad.slice(0, 400)}`);
});

test("a real record lands on chain and reads back byte for byte", { skip: !SEND && "set HYDRA_ANCHOR_SEND=1 to spend testnet STRK and write to a public chain" }, async () => {
  const owner = OWNER();
  const state = init({ invites: [] });
  const { felts } = myRecord(state, owner);
  assert.equal(felts.length, RECORD_FELTS);

  // SCAN THE LINES, do not take the last one. `sncast --json` emits several JSON objects and the
  // final one is a `notification` carrying a Voyager link, not the result — so `.pop()` finds an
  // object with no `transaction_hash` and reports "no transaction hash" for a transaction that
  // landed perfectly well. It cost a red test against a real mint that had already succeeded.
  // RAW FELTS via `--calldata`, not `--arguments`.
  //
  // Two reasons, and the second is the one that matters. sncast's Cairo-like serializer refuses
  // `array![...]` for a `Span<felt252>` ("Expected core::array::Span::<core::felt252>, got
  // array"), so it does not work — but even where it does, it would mean this test proves
  // sncast's encoder is right rather than that OURS is. `writeRecordCalldata` is the thing under
  // test; handing its output straight to the wire is what tests it.
  const invoke = (fn: string, calldata: string[]) => {
    const out = execFileSync("sncast", [
      "--json", "--accounts-file", ACCOUNTS, "--account", ACCOUNT,
      "invoke", "--contract-address", contract, "--function", fn,
      "--calldata", ...calldata, "--network", NETWORK,
    ], { encoding: "utf8" });
    for (const line of out.trim().split("\n").filter(Boolean)) {
      let parsed: { transaction_hash?: string };
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed.transaction_hash) return parsed.transaction_hash;
    }
    throw new Error(`${fn} returned no transaction hash in any line:\n${out}`);
  };

  // Mint only if this id is free. `owner_from_id` returning 0 means free; minting an owned id
  // reverts with 'ERC721: token already minted', so this is idempotent across runs.
  const ownerOf = okResult(
    await callRaw(contract, OWNER_FROM_ID, [`0x${ID.toString(16)}`]), "owner_from_id");
  if (BigInt(ownerOf[0]) === 0n) {
    invoke("mint", [`0x${ID.toString(16)}`]);
  } else {
    assert.equal(BigInt(ownerOf[0]), owner, "this id is minted and not by us — pick another");
  }

  // Separately from the mint, because `mint` does not set it implicitly and a run that minted on
  // a previous attempt would otherwise never get here. `get_main_id` is what lets a stranger go
  // from an address to the id the record lives under, so without it the record is unfindable.
  const mainId = okResult(
    await callRaw(contract, GET_MAIN_ID, [`0x${owner.toString(16)}`]), "get_main_id");
  if (BigInt(mainId[0]) !== ID) invoke("set_main_id", [`0x${ID.toString(16)}`]);

  // The exact felts `anchor.ts` builds — id, field, length, the record, then the trailing domain.
  invoke("set_extended_user_data", writeRecordCalldata(ID, felts));

  // Read it back through the real entrypoint and compare against what we encoded. Not "a record
  // is present" — the same felts, in order.
  const reply = okResult(await rpc("starknet_call", [readRecordCall(ID, NETWORK), "latest"]),
    "read-back");
  const back = decodeRecordReply(reply);
  assert.ok(back, "the slot read as absent immediately after a successful write");
  assert.deepEqual(back, felts, "the felts on chain are not the felts we encoded");

  // And the whole point: the bytes off the chain decode and verify as OUR record at OUR address.
  const record = decodeRecord(back!);
  assert.doesNotThrow(() => verifyRecord(record, owner),
    "the record read off the chain does not verify against the address it is anchored at");
});
