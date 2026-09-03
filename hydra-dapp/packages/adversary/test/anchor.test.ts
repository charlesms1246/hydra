/**
 * The record's chain transport, checked without a chain.
 *
 * `cli/src/anchor.ts` encodes what `decisions/0031` verified against the deployed Starknet ID
 * class. The live round trip is `live-record-anchor.test.ts`; this is everything that can be
 * wrong without leaving the process, which is most of it — a felt array carries no types, so an
 * argument in the wrong position is a silent write to a slot nobody reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IDENTITY_CONTRACT, IDENTITY_CLASS_HASH, RECORD_FIELD, DOMAIN,
  SET_SELECTOR, GET_SELECTOR, feltFromShortString, identityContract,
  assertUsableId, writeRecordCalldata, readRecordCall, decodeRecordReply,
} from "../../cli/src/anchor.ts";
import { RECORD_FELTS } from "../../handshake/src/record.ts";

const felts = (n = RECORD_FELTS) => Array.from({ length: n }, (_, i) => BigInt(i + 1));

test("the write calldata is [id, field, len, ...data, domain] with the domain LAST", () => {
  // The argument order that a hand-written call gets wrong. `set_extended_user_data` takes the
  // span flattened as length-then-items, and `domain` comes after it — not before, which is
  // where it sits in the source signature's mental model of "the trailing config argument".
  const out = writeRecordCalldata(5n, felts());
  assert.equal(out.length, 3 + RECORD_FELTS + 1);
  assert.equal(out[0], "0x5");
  assert.equal(out[1], `0x${RECORD_FIELD.toString(16)}`);
  assert.equal(out[2], `0x${RECORD_FELTS.toString(16)}`);
  assert.deepEqual(out.slice(3, 3 + RECORD_FELTS), felts().map((f) => `0x${f.toString(16)}`));
  assert.equal(out[out.length - 1], "0x0", "the trailing domain is missing or not zero");
});

test("a record is exactly RECORD_FELTS felts, and anything else is refused before it is sent", () => {
  // The contract would take a short span happily and store it — `set_extended_user_data` does not
  // know what a record is. The refusal has to be here.
  assert.throws(() => writeRecordCalldata(5n, felts(RECORD_FELTS - 1)), /felts/);
  assert.throws(() => writeRecordCalldata(5n, felts(RECORD_FELTS + 1)), /felts/);
  assert.doesNotThrow(() => writeRecordCalldata(5n, felts()));
});

test("id zero is refused, because on this contract it reads as absent", () => {
  // `mint(0)` SUCCEEDS on the deployed contract, and `get_main_id` returns 0 to mean "none"
  // while `owner_from_id` returns 0 to mean "free". An identity at zero is indistinguishable
  // from one that was never minted, so the only safe place to refuse it is before minting.
  assert.throws(() => assertUsableId(0n), /positive/);
  assert.throws(() => assertUsableId(-1n), /positive/);
  assert.throws(() => assertUsableId(1n << 128n), /u128/);
  assert.doesNotThrow(() => assertUsableId(1n));
  assert.doesNotThrow(() => assertUsableId((1n << 128n) - 1n));
  // And the refusal is on the paths that would use it, not only in the helper.
  assert.throws(() => writeRecordCalldata(0n, felts()), /positive/);
  assert.throws(() => readRecordCall(0n, "sepolia"), /positive/);
});

test("the read asks for an explicit length, on the bounded entrypoint", () => {
  // NOT `get_unbounded_user_data`. It stops at the first zero felt, and a record is bytes
  // chunked at 31 to a felt — a zero felt is data. Asking for a length makes the count ours
  // rather than the data's, and that is the whole reason this entrypoint is the one.
  const call = readRecordCall(9n, "sepolia");
  assert.equal(call.entry_point_selector, GET_SELECTOR);
  assert.notEqual(call.entry_point_selector, SET_SELECTOR);
  assert.deepEqual(call.calldata, [
    "0x9", `0x${RECORD_FIELD.toString(16)}`, `0x${RECORD_FELTS.toString(16)}`, "0x0",
  ]);
  assert.equal(call.contract_address, IDENTITY_CONTRACT.sepolia);
});

test("a reply is checked against the length we asked for, not trusted", () => {
  const ok = ["0x8", ...felts().map((f) => `0x${f.toString(16)}`)];
  assert.deepEqual(decodeRecordReply(ok), felts());

  // A span header that disagrees with what we asked for means the contract is not the one this
  // code was written against — an upgrade, or the wrong address.
  assert.throws(() => decodeRecordReply(["0x7", ...felts(7).map((f) => `0x${f.toString(16)}`)]), /span says/);
  // A header that disagrees with what actually followed is a truncated reply.
  assert.throws(() => decodeRecordReply(["0x8", "0x1"]), /followed/);
  assert.throws(() => decodeRecordReply([]), /empty/);
});

test("an unwritten slot reads as absent rather than as a record of zeroes", () => {
  // The contract zero-fills past whatever was written and has no notion of "absent", so this
  // distinction has to be made here. A real record cannot be all zero — its first byte is a
  // version — so all-zero is unambiguous.
  //
  // This is the exact reply the live Sepolia contract gives for an id that has never been
  // written: ["0x8", "0x0" x8].
  assert.equal(decodeRecordReply(["0x8", ...Array(RECORD_FELTS).fill("0x0")]), null);
  // And one non-zero felt is a record, however unlikely a shape it is.
  assert.notEqual(decodeRecordReply(["0x8", "0x1", ...Array(RECORD_FELTS - 1).fill("0x0")]), null);
});

test("a transposed READ fails silently on chain, so the span header is the only guard", () => {
  // ASYMMETRY WORTH KNOWING. A wrong argument order on the WRITE fails loudly — the contract
  // reverts with "Failed to deserialize param" or "Input too long for arguments". A wrong order
  // on the READ does not: `get_extended_user_data(id, field, 0, 8)`, with length and domain
  // swapped, returns an EMPTY SPAN and no error, because the zero-length loop never reaches the
  // storage syscall. An empty span is indistinguishable from "we read fine and found nothing"
  // unless something checks the header against what was asked for.
  //
  // `decodeRecordReply` is that something. This is the test that says so.
  assert.throws(() => decodeRecordReply(["0x0"]), /span says/,
    "an empty span was accepted — a transposed read would report a record as absent");
  // And the shape a length-0 reply actually has: just the header, no felts after it.
  assert.throws(() => decodeRecordReply(["0x0"]), /asked for 8/);
});

test("the field and domain are pinned, because a published record cannot be moved", () => {
  // Changing either strands every record already on chain at an address nobody reads. They are
  // asserted as literals rather than recomputed: a test that derives the value from the code it
  // is checking would accept any change to both at once.
  assert.equal(RECORD_FIELD, feltFromShortString("hydra:record"));
  assert.equal(`0x${RECORD_FIELD.toString(16)}`, "0x68796472613a7265636f7264");
  assert.equal(DOMAIN, 0, "domain 1 reverts 'Invalid address domain' on the deployed contract");
});

test("only networks with a verified address are served", () => {
  assert.equal(identityContract("mainnet"), IDENTITY_CONTRACT.mainnet);
  assert.equal(identityContract("sepolia"), IDENTITY_CONTRACT.sepolia);
  // A devnet has no Starknet ID deployment, and inventing an address for one would put a record
  // where nothing resolves it. The error names what adding a network actually requires.
  assert.throws(() => identityContract("devnet"), /no verified Starknet ID/);
  assert.throws(() => identityContract("goerli"), /decisions\/0031/);
});

test("the addresses and class hash are the ones read off the chain", () => {
  // Pinned so that a copy-paste from a blog post fails here rather than on a testnet write.
  // `live-record-anchor.test.ts` checks the class hash is still what is deployed.
  assert.match(IDENTITY_CONTRACT.mainnet, /^0x05dbdedc203e92749e2e746e2d40a768d966bd243df04a6b712e222bc040a9af$/);
  assert.match(IDENTITY_CONTRACT.sepolia, /^0x0000003697660a0981d734780731949ecb2b4a38d6a58fc41629ed611e8defda$/);
  assert.equal(IDENTITY_CLASS_HASH,
    "0x66e6c4b3ff0c038485993ffeb7ff3b176cdf91ee52fb5a6113117874944e08f");
  assert.notEqual(IDENTITY_CONTRACT.mainnet, IDENTITY_CONTRACT.sepolia);
});

test("a short string longer than a felt is refused rather than truncated", () => {
  assert.equal(feltFromShortString("a"), 0x61n);
  assert.doesNotThrow(() => feltFromShortString("x".repeat(31)));
  assert.throws(() => feltFromShortString("x".repeat(32)), /31 bytes/);
});
