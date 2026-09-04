/**
 * Checking that an appeal was signed by the account that published.
 *
 * READING THE CHAIN IS NOT HOLDING A KEY, which is what makes this allowed here at all. I8 forbids
 * the operator tool from depending on `identity` or `vault-client` — installing a review tool must
 * not make a reviewer's machine key-bearing — and verification needs neither. It asks an account
 * contract whether a signature over a digest is valid, which is a read.
 *
 * IT ALSO CANNOT BORROW `cli/src/chain.ts`, for the same reason: `cli` is a *user* package, and I8
 * forbids that dependency in both directions. Extracting a shared chain client is the tidy answer
 * and it is a refactor across two packages for one JSON-RPC call, so this is that one call.
 *
 * COVERED AGAINST A REAL CHAIN by `live-appeal-verify.test.ts`, and it had to be. The hermetic
 * tests here check the request this builds and the replies it accepts or refuses — against a stub,
 * which is exactly the trap: **a stub cannot tell you that the shape it was copied from is wrong.**
 * The selector below was the name rather than a felt when this shipped, every hermetic test agreed
 * with it, and a real node answered `Invalid nibble found: 0x72`.
 *
 * What remains uncovered is narrower now: an account implementation whose `is_valid_signature`
 * returns some third shape would be read as a REFUSAL, which fails closed.
 */

/**
 * What a Starknet account returns from `is_valid_signature` when the signature is good.
 *
 * Two shapes are accepted because two conventions are in the wild: the short-string `VALID` felt,
 * and a plain `1` from accounts implementing the boolean form. Anything else — including an empty
 * result, an error, or a value nobody recognises — is a refusal. **Failing closed is the only safe
 * direction here**: a wrongly accepted appeal means the operator acts on a decision contested by
 * somebody who could not sign for the account, and there is no identity anywhere else in this
 * system that would catch it.
 */
const VALID = new Set([
  // "VALID" as a short string, which is what OpenZeppelin's account returns.
  "0x56414c4944",
  "0x1",
]);

/**
 * `starknet_keccak("is_valid_signature")` — keccak256 of the name, masked to 250 bits.
 *
 * A FELT, NOT THE NAME, and this was wrong when it shipped. `starknet_call` takes a selector as a
 * field element, and passing the string got `Invalid nibble found: 0x72` — the `r` in
 * "is_valid_signature" — from a real node. **Every hermetic test agreed with the bug**, because
 * they asserted the request matched what the code built, and the code built the name. A stub
 * cannot tell you the shape it was copied from is wrong.
 *
 * Derived rather than recalled. `live-record-anchor.ts` carries the same warning next to its own
 * selectors: this is a 250-bit number, and a wrong one does not fail loudly — it fails as
 * "entrypoint not found" or, worse, as somebody else's function.
 */
const SELECTOR = "0x28420862938116cb3bbdbedee07451ccc54d4e9412dbef71142ad1980a30941";

/** The one JSON-RPC call this tool makes. Exported so a test can check what it builds. */
export function verifyRequest(account: string, digest: string, signature: readonly string[]) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "starknet_call",
    params: {
      request: {
        contract_address: account,
        entry_point_selector: SELECTOR,
        // The account is asked about a hash and a signature. The signature is passed as a felt
        // array with its own length prefix, which is how Cairo receives a `Span<felt252>`.
        calldata: [`0x${digest}`, `0x${signature.length.toString(16)}`, ...signature],
      },
      block_id: "latest",
    },
  };
}

/** Whether a reply means the signature is valid. Anything unrecognised is a refusal. */
export function verifyReply(reply: unknown): boolean {
  const result = (reply as { result?: unknown })?.result;
  if (!Array.isArray(result) || result.length !== 1) return false;
  return VALID.has(String(result[0]).toLowerCase());
}

/**
 * Ask the chain. Injected into `Appeals.accept`, so tests substitute their own.
 *
 * A NETWORK FAILURE IS A REFUSAL, NOT AN ACCEPTANCE, and it is reported separately from a bad
 * signature by the caller — an appellant whose valid appeal was refused because an RPC endpoint was
 * down must not be told their signature was forged.
 */
export function verifierAgainst(rpcUrl: string) {
  return async (account: string, digest: string, signature: readonly string[]): Promise<boolean> => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(verifyRequest(account, digest, signature)),
    });
    if (!res.ok) return false;
    return verifyReply(await res.json());
  };
}
