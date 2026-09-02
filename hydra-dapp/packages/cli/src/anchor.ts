/**
 * Putting a record on chain, and reading a stranger's back — the transport `decisions/0027` left
 * out on purpose.
 *
 * That decision shipped `record.ts` with the felts emitted to the terminal and a note saying the
 * chain write was deliberately not built: "the Starknet ID data ABI is not verified anywhere in
 * this repo, and a record written under a guessed entrypoint is a record nobody looks at."
 * `decisions/0031` verified it against the deployed classes on both networks. This is that
 * verification as code, and every constant here was read off a deployed ABI rather than a doc.
 *
 * WHY STARKNET ID AT ALL. A record has to live at an address a stranger can find from something
 * they already know about you. Starknet ID is an ERC-721 whose token id maps to an address both
 * ways — `get_main_id(address)` and `owner_from_id(id)` — and it stores arbitrary felts against
 * that token. Nothing about it is Hydra-specific and that is the point: the record is public
 * bytes at a public address, and `record.ts` is what makes copying it useless.
 */

import { RECORD_FELTS } from "../../handshake/src/record.ts";

/**
 * The identity contract. NOT the naming contract, and that distinction is the whole trap.
 *
 * They are different contracts and the naming one has **no user-data functions at all** — only
 * domain registration and resolution. A record written there would be a record nobody looks at,
 * which is the failure `0027` refused to risk.
 *
 * Both networks run class hash
 * `0x66e6c4b3ff0c038485993ffeb7ff3b176cdf91ee52fb5a6113117874944e08f`, and the two ABI strings
 * `starknet_getClassAt` returns are byte-identical, so one code path covers both. Addresses come
 * from `starknet.js` 10.5.0 as vendored under `.upstream/`, then confirmed deployed with
 * `starknet_getClassHashAt`.
 */
export const IDENTITY_CONTRACT: Readonly<Record<string, string>> = {
  mainnet: "0x05dbdedc203e92749e2e746e2d40a768d966bd243df04a6b712e222bc040a9af",
  sepolia: "0x0000003697660a0981d734780731949ecb2b4a38d6a58fc41629ed611e8defda",
};

/** The class both networks run. A mismatch means the contract was upgraded under us. */
export const IDENTITY_CLASS_HASH =
  "0x66e6c4b3ff0c038485993ffeb7ff3b176cdf91ee52fb5a6113117874944e08f";

/**
 * The storage key a record lives under, as a short string in a felt252.
 *
 * `field` is a raw felt with no contract-side meaning — 0x0 and p-1 are both valid, independent
 * slots — so this is ours to choose and ours to never change. It is namespaced because the same
 * identity may carry other applications' data, and a bare `record` would be a collision waiting
 * for the second application that thinks of it.
 */
export const RECORD_FIELD = feltFromShortString("hydra:record");

/**
 * The storage address domain, and it is not a Starknet ID namespace.
 *
 * It is Starknet's own storage address domain, a `u32`, and **zero is the only valid value** —
 * `domain: 1` reverts `Invalid address domain: 1` on both read and write. It is a constant here
 * rather than an argument because the only other value there might be is one that reverts.
 */
export const DOMAIN = 0;

/** `set_extended_user_data`, the write. `set_user_data` takes ONE felt and cannot carry a record. */
export const SET_SELECTOR =
  "0x136090ae9cef22524f82bde4a9884cfc59834d8cd1cc32516b36e0875978014";
/** `get_extended_user_data`, the read. See `readRecordCall` for why not the unbounded one. */
export const GET_SELECTOR =
  "0x2d6c82452b323406ce20ee9e04c84fbe63496d58492f8a2105427dbfaa39858";

/** ASCII short string to a felt252, the standard Starknet encoding. */
export function feltFromShortString(s: string): bigint {
  if (s.length > 31) throw new Error(`a short string is at most 31 bytes, got ${s.length}`);
  return BigInt(`0x${Buffer.from(s, "ascii").toString("hex")}`);
}

/** The contract for a network, refusing a network this code has not verified an address for. */
export function identityContract(network: string): string {
  const at = IDENTITY_CONTRACT[network];
  if (!at) {
    throw new Error(
      `no verified Starknet ID identity contract for ${network} — known: `
      + `${Object.keys(IDENTITY_CONTRACT).join(", ")}. Adding one means reading its class hash `
      + "off the chain, not copying an address from a document; see decisions/0031.");
  }
  return at;
}

/**
 * An identity id is a `u128` the minter chooses, and **zero is poison**.
 *
 * `get_main_id` returns 0 to mean "this address has no main id" and `owner_from_id` returns 0 to
 * mean "this id is free", so an identity minted at 0 is indistinguishable from one that does not
 * exist. `mint(0)` succeeds, which is what makes this worth refusing here rather than trusting
 * nobody will pick it.
 */
export function assertUsableId(id: bigint): void {
  if (id <= 0n) throw new Error("a Starknet ID identity id must be positive — id 0 reads as absent");
  if (id >= 1n << 128n) throw new Error("a Starknet ID identity id is a u128");
}

/**
 * The calldata for writing a record.
 *
 * `set_extended_user_data(id: u128, field: felt252, data: Span<felt252>, domain: u32)`, and the
 * wire layout is `[id, field, data_len, ...data, domain]`.
 *
 * THE TRAILING DOMAIN IS AFTER THE FLATTENED SPAN, which is the argument order a hand-written
 * call gets wrong. It fails safely — an eleven-felt calldata with no trailing domain reverts with
 * `Failed to deserialize param` rather than landing in the wrong slot — but only because the
 * contract counts. Nothing in a felt array says what it means.
 */
export function writeRecordCalldata(id: bigint, felts: readonly bigint[]): string[] {
  assertUsableId(id);
  if (felts.length !== RECORD_FELTS) {
    throw new Error(`a record is ${RECORD_FELTS} felts, got ${felts.length}`);
  }
  return [
    `0x${id.toString(16)}`,
    `0x${RECORD_FIELD.toString(16)}`,
    `0x${felts.length.toString(16)}`,
    ...felts.map((f) => `0x${f.toString(16)}`),
    `0x${DOMAIN.toString(16)}`,
  ];
}

/**
 * The `starknet_call` for reading one back.
 *
 * `get_extended_user_data(id, field, length, domain)`, with the length supplied.
 *
 * NOT `get_unbounded_user_data`, and this is the finding that most deserved to be a comment.
 * The unbounded reader takes no length and **stops at the first zero felt**. A record is 229
 * bytes chunked at 31 to a felt, so a zero felt is ordinary data rather than a terminator — a
 * key with a zero byte in the wrong place would come back short, and `decodeRecord` would blame
 * the writer for a truncation the reader invented. Asking for exactly `RECORD_FELTS` cannot do
 * that: the length is ours, not the data's.
 */
export function readRecordCall(id: bigint, network: string): {
  contract_address: string; entry_point_selector: string; calldata: string[];
} {
  assertUsableId(id);
  return {
    contract_address: identityContract(network),
    entry_point_selector: GET_SELECTOR,
    calldata: [
      `0x${id.toString(16)}`,
      `0x${RECORD_FIELD.toString(16)}`,
      `0x${RECORD_FELTS.toString(16)}`,
      `0x${DOMAIN.toString(16)}`,
    ],
  };
}

/**
 * The felts out of a `get_extended_user_data` reply.
 *
 * The reply is a `Span`, so it arrives length-prefixed: `[8, ...8 felts]`. The prefix is checked
 * against what we asked for rather than trusted, because a contract that returned a different
 * count than the length we passed is a contract this code does not understand any more.
 *
 * AN UNWRITTEN SLOT READS AS ZEROES rather than as an error — the contract zero-fills past what
 * was written and has no notion of "absent". So all-zero is reported as absent here; a real
 * record cannot be all zero, since its first byte is a version.
 */
export function decodeRecordReply(reply: readonly string[]): bigint[] | null {
  if (reply.length === 0) throw new Error("empty reply from get_extended_user_data");
  const len = Number(BigInt(reply[0]));
  if (len !== RECORD_FELTS) {
    throw new Error(`asked for ${RECORD_FELTS} felts and the span says ${len}`);
  }
  const felts = reply.slice(1).map((f) => BigInt(f));
  if (felts.length !== RECORD_FELTS) {
    throw new Error(`span header says ${len} and ${felts.length} felts followed`);
  }
  return felts.every((f) => f === 0n) ? null : felts;
}
