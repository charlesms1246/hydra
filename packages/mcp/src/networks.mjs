/**
 * The compatibility matrix, made resolvable.
 *
 * findings/00 records that upstream's real pinning artifact is a table in a README, and
 * findings/06 records that the table's Privacy Pool class hash matches neither live
 * deployment. This module is that table plus the live-corroborated values, in a form a
 * tool can read — which is the whole of what `IDEA.md` §3 asked for.
 *
 * Standing rule 6: nothing here is asserted that was not read from upstream source or
 * measured against a live node. Values that were neither are the string UNKNOWN, and
 * `resolve_endpoints` reports them as UNKNOWN rather than inventing a plausible URL.
 */

export const UNKNOWN = "UNKNOWN";

/** Upstream commit every citation in this package refers to. */
export const UPSTREAM_SHA = "980da8affafb9f8350975ca93c03b2299a31ac9b";

/** Docker tag all components must share (upstream README.md:44-50, "use matching revisions"). */
export const COMPONENT_TAG = "PRIVACY-0.14.3-RC.2";

/** Class hashes published in upstream README.md:58-62 at tag PRIVACY-0.14.3-RC.0. */
export const PUBLISHED_CLASS_HASHES = {
  privacyPool: "0x52107fadffab71bdcbb6b2ccb68ba3e1b5558d94036538053e159d3076ad633",
  ekuboAnonymizer: "0x2a4ac595283d4d64b9952f5ef5c0da1775bfdb7c9d92237524a21dd8d19ebd7",
  vesuAnonymizer: "0x3751128dc3ebd36215f982766f14aaca8f78793e4b0f42a73e49372a8e24aae",
  // Not in the matrix. findings/03 flags the absence as the reason its deployment status
  // is open; do not substitute the Primer class hash, which is a different contract.
  shadowAccountAnonymizer: UNKNOWN,
};

/**
 * Endpoints that answered `starknet_chainId` with no API key on 2026-08-29 (findings/06),
 * in the order the corroboration harness tried them.
 *
 * Retired, and the reason this list exists: every `blastapi.io` endpoint now returns
 * `-32000 Blast API is no longer available`. Tutorials and older starter kits still point
 * at it. `1rpc.io/starknet` returned a usage limit and `free-rpc.nethermind.io` did not
 * respond, so neither is listed.
 */
export const NETWORKS = {
  mainnet: {
    chainId: "SN_MAIN",
    pool: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
    rpc: [
      "https://api.cartridge.gg/x/starknet/mainnet",
      "https://starknet.drpc.org",
      "https://rpc.starknet.lava.build",
    ],
    /** findings/06, read live on 2026-08-29. Compared against the live read, not trusted. */
    recorded: {
      auditorPublicKey: "0x1eed60b8d483b3bede62d1cc0f32874aea30747e6943437c858359b41801bf7",
      screenerPublicKey: "0x501cc452e5a4370e2f0879c9a863b3efc915005817487460b23a8d6ef88fdb2",
      classHash: "0x67dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d",
      feeAmount: "6000000000000000000",
      proofValidityBlocks: "450",
    },
  },
  sepolia: {
    chainId: "SN_SEPOLIA",
    pool: "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
    rpc: [
      "https://api.cartridge.gg/x/starknet/sepolia",
      "https://starknet-sepolia.drpc.org",
      "https://rpc.starknet-testnet.lava.build",
    ],
    recorded: {
      auditorPublicKey: "0x1d17f98be07e99713265714699a5c40ccbf7b50c950fb7a2abd81846fcdfbb2",
      screenerPublicKey: "0x62f1e7ca586cbc15b558550be96244874c8dd3e4a50369a6858b29c1e51b552",
      classHash: "0x56ab118a8a6e38efc93ad758cefe909fee421fa931ce3cf72df624d345623b2",
      feeAmount: "2000000000000000000",
      proofValidityBlocks: "450",
    },
  },
};

/**
 * The two service URLs a developer must have and cannot derive.
 *
 * Upstream's own mainnet template leaves both as literal TODOs
 * (`demo/.env.mainnet.example:13-15`: TODO_MAINNET_INDEXER_URL, TODO_MAINNET_PROVER_URL),
 * and `demo/.env.example:2-6` points at localhost. There is no published hosted URL for
 * either service anywhere in the repository at ${UPSTREAM_SHA}. HANDOFF §6 question 5
 * records that this must be asked, not guessed.
 */
export const SERVICE_URLS = {
  provingService: {
    value: UNKNOWN,
    reason:
      "No hosted proving-service URL is published in upstream at this commit. " +
      "demo/.env.mainnet.example:15 is the literal placeholder TODO_MAINNET_PROVER_URL; " +
      "demo/.env.example:6 is http://localhost:3000. Ask StarkWare (HANDOFF §6 q5). " +
      "A wrong proving service fails in ways that look like a bug in your own code, " +
      "because the SDK sends it a signed invocation and waits for a proof.",
    disclosure:
      "Whatever URL you fill in receives the user's PRIVATE viewing key: the invocation " +
      "sent to starknet_proveTransaction is compile_actions calldata built as " +
      "[user_addr, user.viewingKey, actions] (sdk/src/internal/proof-invocation-factory.ts:132-136) " +
      "and is passed whole as the `transaction` param (sdk/src/internal/proving-service.ts:290-293).",
  },
  discoveryService: {
    value: UNKNOWN,
    reason:
      "No hosted discovery-service URL is published in upstream at this commit. " +
      "demo/.env.mainnet.example:13 is the literal placeholder TODO_MAINNET_INDEXER_URL; " +
      "demo/.env.example:4 is http://localhost:8080. Ask StarkWare (HANDOFF §6 q5). " +
      "This is what blocks Phase A2 (findings/06).",
    disclosure:
      "Whatever URL you fill in receives the user's PRIVATE viewing key in the request " +
      "body and decrypts server-side (findings/02; sdk/src/internal/indexer-discovery.ts:160-166). " +
      "You can run your own: crates/discovery-service is Apache-2.0 with a published image " +
      "at " +
      COMPONENT_TAG +
      ". Standing rule 7: that changes who the operator is, not that there is one.",
  },
};

/** Read-only pool views this package calls. All are on IViews in packages/privacy/src/interface.cairo. */
export const POOL_VIEWS = {
  get_auditor_public_key: { line: "packages/privacy/src/privacy.cairo:1118" },
  get_screener_public_key: { line: "packages/privacy/src/privacy.cairo:1122" },
  get_fee_amount: { line: "packages/privacy/src/privacy.cairo:1130" },
  get_proof_validity_blocks: { line: "packages/privacy/src/privacy.cairo:1138" },
};

export function network(name) {
  const n = NETWORKS[name];
  if (!n) throw new Error(`unknown network "${name}" — expected one of: ${Object.keys(NETWORKS).join(", ")}`);
  return n;
}

/** Normalises a felt hex string for comparison (leading zeros are not significant). */
export function feltEq(a, b) {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}
