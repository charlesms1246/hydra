/**
 * Rules are stated as disclosure consequences, not style opinions. Every message
 * says what a third party learns, and every claim here traces to a finding.
 *
 * Standing rule 6: privacy claims must be generated, never asserted. A rule that
 * cannot determine the answer statically reports UNKNOWN. It never reports "safe".
 */

export const ERROR = "error";
export const WARN = "warn";
export const INFO = "info";
export const UNKNOWN = "unknown";

/** Pool addresses, normalised to BigInt for comparison. */
export const POOLS = {
  mainnet: 0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812an,
  sepolia: 0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91n,
};

/** Auditor keys read from the live pools on 2026-08-29 (findings/06). */
export const AUDITOR_KEYS = {
  mainnet: "0x1eed60b8d483b3bede62d1cc0f32874aea30747e6943437c858359b41801bf7",
  sepolia: "0x1d17f98be07e99713265714699a5c40ccbf7b50c950fb7a2abd81846fcdfbb2",
};

export const RULES = {
  HYD001: {
    severity: ERROR,
    title: "Discovery config posts the viewing key with no OHTTP",
    finding: "findings/02-indexer-viewing-key.md",
    detail:
      "createPrivateTransfers({ discoveryProvider: { url } }) builds an IndexerDiscoveryProvider " +
      "with no OHTTP. Every sync sends the user's PRIVATE viewing key in the request body and the " +
      "service decrypts server-side. Viewing keys are immutable and unscoped, so this discloses the " +
      "user's entire past and future history to that host, permanently and unrevocably.",
    fix: "Add ohttp: true, or pass a ContractDiscoveryProvider to keep the key on the client.",
  },
  HYD008: {
    severity: WARN,
    title: "IndexerDiscoveryProvider constructed without OHTTP",
    finding: "findings/02-indexer-viewing-key.md",
    detail:
      "This provider is built with the two-argument form, so OHTTP is off and the service learns " +
      "the client IP alongside the viewing key. Separated from HYD001 because the third argument " +
      "was available here and was not used — that may be a deliberate opt-out rather than an " +
      "oversight, so it is reported as a warning.",
    fix: "Pass { ohttp: true } as the third argument, or record why it is disabled.",
  },
  HYD002: {
    severity: ERROR,
    title: "OHTTP explicitly disabled on the key-bearing path",
    finding: "findings/02-indexer-viewing-key.md",
    detail:
      "ohttp is set to false on the discovery provider. Discovery requests carry the viewing key; " +
      "without OHTTP the service also learns the client IP that key belongs to.",
    fix: "Set ohttp: true, or remove the option and justify the decision explicitly.",
  },
  HYD003: {
    severity: WARN,
    title: "Indexer discovery discloses the viewing key to its operator",
    finding: "findings/02-indexer-viewing-key.md",
    detail:
      "IndexerDiscoveryProvider sends the private viewing key to the configured host, which " +
      "decrypts server-side. OHTTP hides the client IP from that host; it does not hide the key. " +
      "Self-hosting reduces who the operator is — it does not remove the disclosure.",
    fix: "For applications holding other users' keys, use ContractDiscoveryProvider instead.",
  },
  HYD004: {
    severity: WARN,
    title: "Client-side discovery with unbounded concurrency",
    finding: "findings/07-client-discovery-cost.md",
    detail:
      "ContractDiscoveryProvider without a rateLimit does not throttle at all. Measured: 715 " +
      "concurrent RPC calls for a 1,920-note history. A public RPC provider will rate-limit, " +
      "throttle or ban this.",
    fix: "Pass { rateLimit: { concurrency: 32 } } — caps in-flight calls at 32, ≥111 round trips.",
  },
  HYD005: {
    severity: WARN,
    title: "Discovery concurrency low enough to be a latency trap",
    finding: "findings/07-client-discovery-cost.md",
    detail:
      "A 1,920-note history costs 3,529 RPC calls — deterministic, identical on every run. A " +
      "concurrency cap of c forces at least ceil(3529/c) sequential round trips: 883 at 4, 442 " +
      "at 8, 221 at 16, 111 at 32, 56 at 64. So rateLimit: {}, which defaults concurrency to 8, " +
      "costs at least four times what 32 does. These are lower bounds derived from the call " +
      "count, not measured latency: wall clock has not been measured against a real endpoint.",
    fix: "Raise concurrency to 32-64 unless the RPC provider requires otherwise.",
  },
  HYD006: {
    severity: ERROR,
    title: "Mainnet and Sepolia pool addresses in the same file",
    finding: "findings/06-live-corroboration.md",
    detail:
      "The two pools have different auditor keys and run different contract classes, so behaviour " +
      "verified on one does not transfer to the other. Mixing them in one module is a deployment " +
      "hazard.",
    fix: "Resolve the pool address from a single network-scoped configuration.",
  },
  HYD007: {
    severity: INFO,
    title: "The pool auditor can decrypt this user's entire history",
    finding: "findings/01-escrow.md",
    detail:
      "At registration the pool encrypts the user's private viewing key to an auditor key held in " +
      "contract storage. It is mandatory, cannot be opted out of or substituted, and is write-once. " +
      "This is true of every STRK20 integration and is reported on every run, not as a defect.",
    fix: "No code fix. Disclose it to users; do not claim privacy from the auditor.",
  },
  HYD000: {
    severity: UNKNOWN,
    title: "Discovery configuration could not be determined statically",
    finding: "findings/02-indexer-viewing-key.md",
    detail:
      "The discovery provider is not an object or constructor literal here, so this tool cannot " +
      "tell what it discloses. Absence of a finding is NOT evidence of safety.",
    fix: "Inspect manually, or inline the configuration so it can be checked.",
  },
};
