/**
 * The evidence layer. Nothing here is an opinion.
 *
 * Every disclosure fact is a quotation of upstream source or of a finding that quotes
 * upstream source, and carries its citation with it. `leak.mjs` selects among these
 * facts; it does not invent any.
 *
 * Standing rule 6: privacy claims must be generated, never asserted. Consequently there
 * is no value in this file meaning "private". `NOT_DISCLOSED` is always scoped to a
 * single transaction and always carries the mechanism that makes it true, and `UNKNOWN`
 * is the required answer whenever the mechanism cannot be established from the input.
 */

/** Upstream source of truth. Every `upstream:` citation below is at this commit. */
export const UPSTREAM_COMMIT = "980da8affafb9f8350975ca93c03b2299a31ac9b";

// ---------------------------------------------------------------------------
// Disclosure vocabulary
// ---------------------------------------------------------------------------

/** The party learns the value in plaintext. */
export const CLEAR = "CLEAR";
/** The value is on chain encrypted and this party holds a key that opens it. */
export const DECRYPTABLE = "DECRYPTABLE";
/**
 * This transaction does not put the value where the party can read it. Scoped to the
 * transaction and to the mechanism named in `why`. It is NOT a claim of privacy: it says
 * nothing about correlation across transactions, off-chain side channels, or any party's
 * prior knowledge.
 */
export const NOT_DISCLOSED = "NOT_DISCLOSED_BY_THIS_TX";
/** Not computable from the input given. Never treat as a pass. */
export const UNKNOWN = "UNKNOWN";
/** The field does not exist for this action. */
export const NA = "N/A";

/** The fields a disclosure set reports, in print order. */
export const FIELDS = ["amount", "token", "counterparty", "timing", "addresses"];

/** Parties, in print order. The four in HANDOFF Phase F plus two the source forces. */
export const PARTIES = [
  ["public", "public chain observer"],
  ["pool-users", "other pool users"],
  ["counterparty", "the counterparty"],
  ["discovery", "discovery service operator"],
  ["prover", "proving service operator"],
  ["auditor", "the auditor"],
];

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/**
 * `findings/` entries are this repository's own write-ups. `upstream:` entries are
 * file:line in starkware-libs/starknet-privacy at UPSTREAM_COMMIT, cited directly where
 * no finding has been written yet — see README, "Claims with no finding behind them".
 */
export const CITE = {
  F01: "findings/01-escrow.md",
  F02: "findings/02-indexer-viewing-key.md",
  F03: "findings/03-sub-accounts.md",
  F06: "findings/06-live-corroboration.md",
  F07: "findings/07-client-discovery-cost.md",

  EV_VIEWING_KEY_SET: "upstream:packages/privacy/src/events.cairo:4-15",
  EV_DEPOSIT: "upstream:packages/privacy/src/events.cairo:30-40",
  EV_WITHDRAWAL: "upstream:packages/privacy/src/events.cairo:16-29",
  EV_ENC_NOTE: "upstream:packages/privacy/src/events.cairo:93-101",
  EV_NOTE_USED: "upstream:packages/privacy/src/events.cairo:102-107",
  EV_OPEN_NOTE: "upstream:packages/privacy/src/events.cairo:54-63",
  EV_INVOKED: "upstream:packages/privacy/src/events.cairo:81-91",
  EV_SHADOW_DEPLOYED:
    "upstream:packages/shadow_account_anonymizer/src/shadow_account_anonymizer.cairo:278-286",

  TRANSFER_FROM: "upstream:packages/privacy/src/privacy.cairo:967-975",
  TRANSFER_TO: "upstream:packages/privacy/src/privacy.cairo:977-981",
  CALLDATA_IN_TRACE: "upstream:packages/privacy/src/privacy.cairo:989",
  RECIPIENT_CHANNELS: "upstream:packages/privacy/src/privacy.cairo:90,962-965",
  NUM_OF_CHANNELS_VIEW: "upstream:packages/privacy/src/privacy.cairo:1078-1080",
  SUBCHANNEL_ENC: "upstream:packages/privacy/src/privacy.cairo:455-478",
  APPLY_ACTIONS: "upstream:packages/privacy/src/privacy.cairo:786-802",
  SCREENING: "upstream:packages/privacy/src/privacy.cairo:858-876",
  AUDITOR_STORAGE: "upstream:packages/privacy/src/privacy.cairo:319-345",

  PROVER_CALLDATA: "upstream:sdk/src/internal/proof-invocation-factory.ts:132-136",
  PROVER_POST: "upstream:sdk/src/internal/proving-service.ts:282-294",
  INDEXER_BODY: "upstream:sdk/src/internal/indexer-discovery.ts:160-166",
  CONTRACT_DISCOVERY: "upstream:sdk/src/internal/contract-discovery.ts:386-388",
  FACTORY_NO_OHTTP: "upstream:sdk/src/factory.ts:108",
};

// ---------------------------------------------------------------------------
// Deployment facts (findings/06, read from the live pools on 2026-08-29)
// ---------------------------------------------------------------------------

export const NETWORKS = {
  mainnet: {
    pool: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
    auditorPublicKey: "0x1eed60b8d483b3bede62d1cc0f32874aea30747e6943437c858359b41801bf7",
    screenerPublicKey: "0x501cc452e5a4370e2f0879c9a863b3efc915005817487460b23a8d6ef88fdb2",
  },
  sepolia: {
    pool: "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
    auditorPublicKey: "0x1d17f98be07e99713265714699a5c40ccbf7b50c950fb7a2abd81846fcdfbb2",
    screenerPublicKey: "0x62f1e7ca586cbc15b558550be96244874c8dd3e4a50369a6858b29c1e51b552",
  },
};

// ---------------------------------------------------------------------------
// Accepted input vocabulary
// ---------------------------------------------------------------------------

export const ACTION_TYPES = ["register", "deposit", "transfer", "withdraw", "invoke"];

/** Discovery configurations this tool can reason about. Anything else is UNKNOWN. */
export const DISCOVERY_KINDS = ["indexer-hosted", "indexer-self-hosted", "client"];

/** Proving configurations this tool can reason about. Anything else is UNKNOWN. */
export const PROVING_KINDS = ["service-hosted", "service-self-hosted", "mock"];
