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
 *   HYDRA_LIVE_WRITE=1 HYDRA_RPC=... npm run test:live
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
import { init, myRecord, bundleFromChain, fingerprint } from "../../cli/src/commands.ts";
import { writesToChain } from "./live-write-gate.ts";

const RPC = process.env.HYDRA_RPC;
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

/**
 * `SN_SEPOLIA`, as the felt a node returns from `starknet_chainId`.
 *
 * **EVERY CLAIM IN THIS FILE IS PINNED TO ONE DEPLOYMENT** — `IDENTITY_CLASS_HASH`, three
 * selectors typed from the class's own entry points, and an argument order verified against it.
 * None of that means anything on a different chain.
 *
 * And the way to get to a different chain is short. `source ~/.hydra/live-env.sh` sets
 * `HYDRA_RPC` to a **devnet** — its own first line says "Devnet only; regenerated on every
 * `hydra up`" — while the composed command in two other test headers reads like a Sepolia run to
 * anyone who has not opened the file. On a devnet the class lookup fails, which is survivable;
 * what is not survivable is the shape this repository keeps finding, **a suite that passes while
 * measuring the wrong thing.** So the chain is identified rather than inferred from whichever
 * assertion happens to trip first.
 */
const SEPOLIA_CHAIN_ID = 0x534e5f5345504f4c4941n;

before(async () => {
  assert.ok(RPC, "HYDRA_RPC is required — see the header");
  if (NETWORK === "sepolia") {
    const got = String(okResult(await rpc("starknet_chainId", []) as any, "chainId"));
    assert.equal(BigInt(got), SEPOLIA_CHAIN_ID,
      `${RPC} is not Sepolia — it reports chain id ${got}, and every class hash and selector in `
      + "this file is pinned to the Sepolia deployment, so a pass here would measure nothing. If "
      + "you sourced ~/.hydra/live-env.sh: that file is DEVNET ONLY and says so in its first line.");
  }
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

/**
 * `bundleFromChain` — the function `hydra lookup` and the TUI's `l` are, against a real node.
 *
 * **A NETWORK-TOUCHING PATH WHOSE ONLY COVERAGE WAS HERMETIC, WHICH IS THE SHAPE
 * `live-chain-client.test.ts` EXISTS FOR.** Its header records the fakes audit's sharpest finding:
 * `events()` and `publishers()` were only ever driven against a model of a node. `lookup` reached
 * the TUI on 2026-09-06 and arrived in the same condition — the encoding of two `starknet_call`
 * requests, a reply decoder, and a signature check, none of it having met a real node.
 *
 * READ-ONLY, SO IT RUNS IN THE DEFAULT MODE. Two `starknet_call`s cost nothing and write nothing;
 * this needs no `HYDRA_LIVE_WRITE` gate and should not have one.
 *
 * **IT ASSERTS WHICHEVER ANSWER THE CHAIN ACTUALLY GIVES**, like the slot test above, because a
 * previous `HYDRA_LIVE_WRITE=1` run may have landed a record for this account and a test that
 * demanded "no record" would fail on a chain that is more complete rather than less. Both branches
 * assert something real, and the vacuity check is that exactly one of them ran.
 */
test("THE SHIPPED LOOKUP PATH MEETS A REAL NODE, and refuses or verifies rather than guessing",
  async () => {
    const owner = OWNER();
    const state = init({ rpcUrl: RPC!, network: NETWORK, invites: [] });

    let bundle: Awaited<ReturnType<typeof bundleFromChain>> | null = null;
    let refusal: Error | null = null;
    try { bundle = await bundleFromChain(state, owner); }
    catch (e) { refusal = e as Error; }

    assert.ok((bundle === null) !== (refusal === null),
      "neither a bundle nor a refusal came back, so nothing here measured the live path");

    if (refusal) {
      // **THE REFUSAL IS THE CLIENT'S OWN SENTENCE, NOT A PARSE ERROR.** That distinction is the
      // reason this is worth running live: a node that answers with HTML, or a decoder that let a
      // zero id through, would surface as `SyntaxError: Unexpected token <` or as a bundle built
      // from slot zero — the second being the one that matters, because it would be somebody
      // else's key presented as this address's.
      assert.match(refusal.message, /published no bundle record|owns identity/,
        `the live refusal is not the client's: ${refusal.message.slice(0, 200)}`);
      assert.doesNotMatch(refusal.message, /JSON|Unexpected token|undefined/,
        "the refusal is a parse failure wearing the client's clothes");
      return;
    }

    // A record IS published at this address. Then the whole claim `LOOKUP_KEY_NOT_PERSON` makes
    // must hold on live bytes: `bundleOf` verifies the anchor signature against THIS address
    // before returning, so a bundle coming back at all is the check having passed.
    assert.ok(bundle!.identityKey?.length, "a bundle with no identity key came back");
    assert.ok(bundle!.signingKey?.length, "a bundle with no signing key came back");
    assert.equal(fingerprint(bundle!).length, 32, "the fingerprint users read aloud is not 32 hex");
    // NO ONE-TIME PREKEY — `LOOKUP_NO_ONE_TIME` is the claim, and this is it on real bytes rather
    // than on the sentence. A record charges per felt and the one-time keys stay in the vault.
    assert.equal(bundle!.oneTimePrekey, undefined,
      "a chain record carried a one-time prekey, so LOOKUP_NO_ONE_TIME is now false");

    // **AND THE BINDING, ON THE SAME LIVE BYTES.** A bundle coming back is a weak check on its
    // own: `bundleOf` verifies inside, so this test would still pass with the verification
    // deleted. `LOOKUP_KEY_NOT_PERSON` says the record's signature NAMES that address — so the
    // thing to assert is the refusal, against the same felts and a different owner. That is the
    // property that stops somebody republishing another party's keys under their own name, and
    // it is the one claim on the Connect page this file can check against a real chain.
    const raw = decodeRecordReply(
      okResult(await rpc("starknet_call", [readRecordCall(ID, NETWORK), "latest"]), "re-read"));
    assert.ok(raw, "the record read as absent on the second read, so the binding is unchecked");
    assert.throws(() => verifyRecord(decodeRecord(raw!), owner + 1n),
      "the live record verifies against an address it does not name — the anchor signature is "
      + "not binding, and LOOKUP_KEY_NOT_PERSON is false");
    //
    // **WHAT THIS DOES NOT PROVE, MEASURED RATHER THAN ASSUMED.** It proves the SIGNATURE is
    // binding on live bytes. It does not prove `bundleFromChain` checks it: deleting
    // `verifyRecord(record, owner)` from `bundleOf` in `handshake/src/record.ts` leaves this whole
    // file green, because the assertion above calls `verifyRecord` itself and the bundle branch
    // still returns a bundle. Confirmed by running that mutation, not reasoned about.
    //
    // **THAT WIRING IS COVERED, AND THIS WAS CHECKED RATHER THAN ASSUMED.** The same mutation run
    // against the hermetic suite fails `record.test.ts` — *"A RECORD SIGNED FOR ANOTHER ADDRESS IS
    // REFUSED — the whole attack"*. So the call path has a guard; it is simply not this one, and
    // it belongs there: the attack needs a record naming a DIFFERENT address than the one it is
    // read at, which cannot be constructed read-only on a real chain.
    //
    // Said here so the next reader does not mistake a passing live run for a check on the call
    // path — which is the reassurance a live test is most likely to be misread as giving, and the
    // reason to write down what it does not cover next to what it does.
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

test("a real record lands on chain and reads back byte for byte",
  { skip: writesToChain("spends testnet STRK and writes a PERMANENT public record naming this "
    + "account — it cannot be undone, edited or taken back") }, async () => {
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

  /**
   * Wait until a transaction is IN A BLOCK, and fail loudly if it reverted.
   *
   * **THE FIRST LIVE RUN OF THIS TEST FAILED HERE, AND THE WRITE HAD SUCCEEDED.** `sncast invoke`
   * returns once the transaction is submitted, not once it is included, so the read-back below ran
   * against a `latest` that did not contain it yet — and this account already carried a record
   * from an earlier run, so the read returned **the previous record** and the comparison failed
   * with a full felt-by-felt diff. Every one of those felts was real; they were simply the old
   * ones. Verified afterwards: the record this run encoded is on chain, in block 14639481.
   *
   * **THE FAILURE MODE THAT MAKES THIS WORTH POLLING RATHER THAN SLEEPING** is the reverse case.
   * On an account with NO prior record the same race reads an absent slot, which `decodeRecordReply`
   * reports as `null` — an outcome indistinguishable from a write that genuinely did not land. So
   * a fixed sleep would have made this test flaky in one direction and quietly wrong in the other.
   *
   * A hermetic suite cannot contain this bug: there is no submission-to-inclusion gap in a model
   * of a chain. It took a real transaction to find, which is the argument for live tests and also
   * the argument for reading their failures carefully rather than trusting the assertion's story.
   */
  const settle = async (hash: string, fn: string): Promise<number> => {
    for (let i = 0; i < 60; i++) {
      const r = await rpc("starknet_getTransactionReceipt", [hash]);
      const receipt = r.result as { block_number?: number; execution_status?: string; revert_reason?: string };
      if (receipt?.block_number !== undefined) {
        assert.equal(receipt.execution_status, "SUCCEEDED",
          `${fn} (${hash}) reverted on chain: ${receipt.revert_reason}`);
        return receipt.block_number;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`${fn} (${hash}) was not included within two minutes — it may still land, so `
      + "check the account's nonce before re-running or you will spend a second fee");
  };

  // Mint only if this id is free. `owner_from_id` returning 0 means free; minting an owned id
  // reverts with 'ERC721: token already minted', so this is idempotent across runs.
  const ownerOf = okResult(
    await callRaw(contract, OWNER_FROM_ID, [`0x${ID.toString(16)}`]), "owner_from_id");
  if (BigInt(ownerOf[0]) === 0n) {
    await settle(invoke("mint", [`0x${ID.toString(16)}`]), "mint");
  } else {
    assert.equal(BigInt(ownerOf[0]), owner, "this id is minted and not by us — pick another");
  }

  // Separately from the mint, because `mint` does not set it implicitly and a run that minted on
  // a previous attempt would otherwise never get here. `get_main_id` is what lets a stranger go
  // from an address to the id the record lives under, so without it the record is unfindable.
  const mainId = okResult(
    await callRaw(contract, GET_MAIN_ID, [`0x${owner.toString(16)}`]), "get_main_id");
  if (BigInt(mainId[0]) !== ID) {
    await settle(invoke("set_main_id", [`0x${ID.toString(16)}`]), "set_main_id");
  }

  // The exact felts `anchor.ts` builds — id, field, length, the record, then the trailing domain.
  const hash = invoke("set_extended_user_data", writeRecordCalldata(ID, felts));
  const landedIn = await settle(hash, "set_extended_user_data");

  /*
   * Read it back through the real entrypoint and compare against what we encoded. Not "a record is
   * present" — the same felts, in order.
   *
   * **POLLED AT `latest`, AND THE TWO OBVIOUS ALTERNATIVES BOTH FAILED LIVE.** A single read
   * straight after `invoke` raced inclusion and returned the PREVIOUS run's record. Pinning the
   * read to the receipt's own `block_number` then failed with `{"code":24,"message":"Block not
   * found"}` — this node reports a block number on the receipt before that block is queryable by
   * number, so the fix for the first race introduced a second one.
   *
   * So the wait is on the OBSERVABLE the test is about, rather than on a proxy for it: read until
   * the slot holds what we wrote. `settle` above still runs first and is not redundant — it is
   * what turns a reverted transaction into a named failure instead of a timeout.
   *
   * On timeout it asserts against the LAST value read, so a genuine mismatch reports a felt diff
   * rather than "timed out" — a polling loop that hides its subject on failure would be worse than
   * the race it replaced.
   */
  let reply: string[] = [];
  for (let i = 0; i < 45; i++) {
    reply = okResult(await rpc("starknet_call", [readRecordCall(ID, NETWORK), "latest"]), "read-back");
    const seen = decodeRecordReply(reply);
    if (seen && seen.length === felts.length && seen.every((f, j) => f === felts[j])) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const back = decodeRecordReply(reply);
  assert.ok(back, "the slot read as absent immediately after a successful write");
  assert.deepEqual(back, felts,
    `the felts on chain are not the felts we encoded — ${hash}, reported in block ${landedIn}`);

  // And the whole point: the bytes off the chain decode and verify as OUR record at OUR address.
  const record = decodeRecord(back!);
  assert.doesNotThrow(() => verifyRecord(record, owner),
    "the record read off the chain does not verify against the address it is anchored at");
});
