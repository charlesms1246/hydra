/**
 * The four tools, as plain async functions returning plain objects.
 *
 * Kept separate from the MCP wiring so they can be tested without a transport, and so
 * `check_environment` and `lint_config` stay honest wrappers: they call
 * `packages/cli/src/doctor.mjs` and `packages/linter/src/analyze.mjs` and add nothing.
 * Duplicating either would let the two copies disagree, and the copy an agent reads
 * would be the one nobody runs.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "../../cli/src/doctor.mjs";
import { analyzeSource } from "../../linter/src/analyze.mjs";
import { RULES } from "../../linter/src/rules.mjs";
import {
  PUBLISHED_CLASS_HASHES,
  SERVICE_URLS,
  COMPONENT_TAG,
  UPSTREAM_SHA,
  UNKNOWN,
  network,
  feltEq,
} from "./networks.mjs";
import { probeEndpoints, readPoolState, drift, KNOWN_NETWORKS } from "./chain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The auditor can always decrypt. findings/01. Attached to every network-scoped answer. */
const AUDITOR_STANDING_CONDITION =
  "The auditor can decrypt every user of this pool. At registration the pool encrypts the " +
  "user's private viewing key to the auditor key in contract storage — mandatory, " +
  "not user-supplied, write-once, no rotation for the user " +
  "(packages/privacy/src/privacy.cairo:319-345; findings/01). This is reported on every " +
  "call, not as a defect.";

/* ------------------------------------------------------------------ resolve_endpoints */

export async function resolveEndpoints({ network: name }) {
  const net = network(name);
  const probed = await probeEndpoints(name);
  const live = await readPoolState(name);

  return {
    network: name,
    upstreamCommit: UPSTREAM_SHA,
    chainId: net.chainId,
    poolAddress: net.pool,

    rpc: {
      probedNow: probed,
      working: probed.filter((p) => p.ok).map((p) => p.url),
      retired: [
        {
          host: "*.blastapi.io",
          status: "RETIRED",
          evidence: "-32000: Blast API is no longer available. Please update your integration to use Alchemy's API instead",
          note: "findings/06. Older tutorials and starter-kit instructions still point at it.",
        },
      ],
      note: "This list is a maintenance liability, not a fact about the protocol. Endpoints " +
        "are probed on every call; the `working` array is what answered just now.",
    },

    provingServiceUrl: SERVICE_URLS.provingService,
    discoveryServiceUrl: SERVICE_URLS.discoveryService,

    auditorPublicKey: keyResult(live, "get_auditor_public_key", net.recorded.auditorPublicKey),
    screenerPublicKey: keyResult(live, "get_screener_public_key", net.recorded.screenerPublicKey),

    classHash: classHashResult(live, net),

    componentTag: {
      value: COMPONENT_TAG,
      note: "upstream README.md:44-50 — all components in a row are tested together; use matching revisions.",
    },
    publishedClassHashes: PUBLISHED_CLASS_HASHES,

    standingCondition: AUDITOR_STANDING_CONDITION,
  };
}

function keyResult(live, view, recorded) {
  const value = live.views?.[view];
  if (value === undefined || typeof value === "object") {
    return {
      live: UNKNOWN,
      reason: live.error ?? value?.error ?? "view not read",
      recorded2026_08_29: recorded,
      note: "The recorded value is evidence of what was true on that date. It is not a live read.",
    };
  }
  return { live: value, drift: drift(value, recorded), recorded2026_08_29: recorded };
}

function classHashResult(live, net) {
  const deployed = typeof live.classHash === "string" ? live.classHash : UNKNOWN;
  const published = PUBLISHED_CLASS_HASHES.privacyPool;
  const matchesPublished = deployed !== UNKNOWN && feltEq(deployed, published);
  return {
    deployed,
    published,
    publishedAtTag: "PRIVACY-0.14.3-RC.0 (upstream README.md:60)",
    matchesPublished,
    discrepancy: matchesPublished
      ? null
      : deployed === UNKNOWN
        ? "Deployed class hash UNREAD — cannot check."
        : "The published class hash identifies neither deployment (findings/06). " +
          `${net.chainId} runs ${deployed}. You cannot use the compatibility matrix to verify ` +
          "that the deployed pool is the audited source, and mainnet and Sepolia run different " +
          "classes, so behaviour verified on one does not transfer to the other. " +
          "[U] Cause unknown — the pool embeds ReplaceabilityComponent with upgrade_delay 0 " +
          "(packages/privacy/src/privacy.cairo:162), so a post-RC.0 upgrade is the most " +
          "economical explanation, but that is an inference, not a finding.",
    recorded2026_08_29: net.recorded.classHash,
    drift: deployed === UNKNOWN ? "UNREAD" : drift(deployed, net.recorded.classHash),
  };
}

/* ----------------------------------------------------------------- check_environment */

export function checkEnvironment() {
  // doctor.upstreamPath() resolves ../../../.upstream from process.cwd(), which is right
  // for `npx hydra` in packages/cli and wrong for a server started from anywhere. Anchor
  // it to this file instead, unless the caller has already chosen.
  if (!process.env.HYDRA_UPSTREAM) {
    process.env.HYDRA_UPSTREAM = join(HERE, "..", "..", "..", "..", ".upstream");
  }
  const rows = check();
  return {
    upstreamPath: process.env.HYDRA_UPSTREAM,
    expectedUpstreamCommit: UPSTREAM_SHA,
    rows,
    ok: rows.every((r) => r.status !== "MISS"),
    drift: rows.filter((r) => r.status === "WARN").map((r) => `${r.name}: want ${r.want}, got ${r.got}`),
    missing: rows.filter((r) => r.status === "MISS").map((r) => ({ name: r.name, hint: r.hint })),
    note: "Toolchain only. Says nothing about privacy — that is lint_config's job. " +
      "Produced by packages/cli/src/doctor.mjs, pinned from upstream .tool-versions (findings/00).",
  };
}

/* ---------------------------------------------------------------------- lint_config */

const EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"]);
const SKIP = new Set(["node_modules", "dist", "build", ".git", "coverage", "target"]);

function walk(p, out = []) {
  if (statSync(p).isFile()) {
    if (EXTS.has(extname(p)) && !p.endsWith(".d.ts")) out.push(p);
    return out;
  }
  for (const e of readdirSync(p)) {
    if (!SKIP.has(e)) walk(join(p, e), out);
  }
  return out;
}

export function lintConfig({ path }) {
  const files = walk(path);
  const findings = [];
  const skipped = [];
  for (const f of files) {
    try {
      findings.push(...analyzeSource(f, readFileSync(f, "utf8")));
    } catch (e) {
      skipped.push({ file: f, error: e.message });
    }
  }
  const counts = findings.reduce((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {});
  return {
    path,
    filesScanned: files.length,
    skipped,
    counts,
    findings,
    rulesApplied: Object.keys(RULES),
    note:
      findings.length === 0
        ? "No checked pattern matched. This is NOT a privacy claim: the linter is " +
          "single-file and shape-based, so a provider built behind a helper, or an app on " +
          "the wallet-API route rather than the SDK route, is invisible to it (findings/08)."
        : "HYD000 means undetermined, not safe. HYD007 is the standing auditor condition " +
          "(findings/01), not a defect to fix.",
  };
}

/* ----------------------------------------------------------------------- pool_state */

export async function poolState({ network: name }) {
  const net = network(name);
  const live = await readPoolState(name);
  if (live.error) return { ...live, standingCondition: AUDITOR_STANDING_CONDITION };

  const v = live.views;
  return {
    network: name,
    rpcUsed: live.rpcUsed,
    chainId: live.chainId,
    poolAddress: live.pool,
    views: {
      get_auditor_public_key: keyResult(live, "get_auditor_public_key", net.recorded.auditorPublicKey),
      get_screener_public_key: keyResult(live, "get_screener_public_key", net.recorded.screenerPublicKey),
      get_fee_amount: {
        live: v.get_fee_amount,
        decimal: decimalOf(v.get_fee_amount),
        unit: "FRI (STRK wei) per apply_actions call, charged to the tx caller " +
          "(packages/privacy/src/privacy.cairo:845-856)",
        drift: drift(v.get_fee_amount, net.recorded.feeAmount),
      },
      get_proof_validity_blocks: {
        live: v.get_proof_validity_blocks,
        decimal: decimalOf(v.get_proof_validity_blocks),
        drift: drift(v.get_proof_validity_blocks, net.recorded.proofValidityBlocks),
      },
    },
    classHash: classHashResult(live, net),
    escrowIsLive:
      typeof v.get_auditor_public_key === "string" && BigInt(v.get_auditor_public_key) !== 0n
        ? "YES — the auditor key is non-zero, so every SetViewingKey against this pool has " +
          "escrowed that user's private viewing key to it. Not a dormant code path."
        : UNKNOWN,
    screeningIsLive:
      typeof v.get_screener_public_key === "string" && BigInt(v.get_screener_public_key) !== 0n
        ? "YES — the screener key is non-zero, so deposit screening is configured on this pool " +
          "(packages/privacy/src/privacy.cairo:921-943)."
        : UNKNOWN,
    standingCondition: AUDITOR_STANDING_CONDITION,
  };
}

function decimalOf(hex) {
  try {
    return BigInt(hex).toString(10);
  } catch {
    return UNKNOWN;
  }
}

export { KNOWN_NETWORKS };
