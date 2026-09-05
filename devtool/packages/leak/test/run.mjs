/**
 * Expectation tests, in the same style as packages/linter/test/run.mjs: each case
 * declares exactly what must be produced, and a case that must produce UNKNOWN is as
 * important as one that must produce a disclosure.
 *
 * Expectations are written as "party/field=VALUE" selectors, plus "anon:N=VALUE" for an
 * anonymity-set size. Three invariants are then checked across every case rather than
 * per-case, because they are properties of the tool and not of any one transaction.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { whatDoesThisLeak } from "../src/leak.mjs";
import { CLEAR, DECRYPTABLE, NOT_DISCLOSED, UNKNOWN, NA, FIELDS, PARTIES, isHeldCite, citeLabel } from "../src/facts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const example = (n) => JSON.parse(readFileSync(join(here, "..", "examples", `${n}.json`), "utf8"));

const CASES = [
  // --- The three flows HANDOFF Phase F names as the acceptance criterion --------------

  [
    "shield (example)",
    example("shield"),
    [
      // A deposit names its depositor, its token and its amount. Nothing about it is private.
      "1:public/amount=CLEAR",
      "1:public/token=CLEAR",
      "1:public/addresses=CLEAR",
      "1:pool-users/amount=CLEAR",
      // Documented happy path: both hosted services receive the root viewing key.
      "1:discovery/amount=CLEAR",
      "1:prover/addresses=CLEAR",
      "1:auditor/amount=DECRYPTABLE",
      // Computed, not asserted: the depositor is a keyed event field, so the set is 1.
      "anon:1=1",
      "anon:0=1",
    ],
  ],

  [
    "private transfer (example)",
    example("private-transfer"),
    [
      // Note events carry note_id/packed_value/nullifier only.
      "0:public/amount=NOT_DISCLOSED_BY_THIS_TX",
      "0:public/token=NOT_DISCLOSED_BY_THIS_TX",
      "0:public/addresses=NOT_DISCLOSED_BY_THIS_TX",
      // opensChannel: false was declared, so the recipient is not written in the clear.
      "0:public/counterparty=NOT_DISCLOSED_BY_THIS_TX",
      // ...but the block is still public.
      "0:public/timing=CLEAR",
      // Client-side discovery contacts no service.
      "0:discovery/amount=NOT_DISCLOSED_BY_THIS_TX",
      // A prover you run yourself still receives the key and the plaintext actions.
      "0:prover/amount=CLEAR",
      // The recipient is told; that is what a transfer is.
      "0:counterparty/amount=CLEAR",
      "0:auditor/counterparty=DECRYPTABLE",
      // Never a number without a measurement.
      "anon:0=UNKNOWN",
    ],
  ],

  [
    "shadow dapp call (example)",
    example("shadow-dapp-call"),
    [
      // Target and selector are indexed event fields.
      "0:public/counterparty=CLEAR",
      // The shadow account address is public; the pool user behind it is not emitted.
      "0:public/addresses=CLEAR",
      // Amount and token live in calldata this tool does not parse and were not declared.
      "0:public/amount=UNKNOWN",
      "0:public/token=UNKNOWN",
      // The target contract's retention is not knowable from here.
      "0:counterparty/amount=UNKNOWN",
      // Self-hosted indexer with OHTTP on still receives the key.
      "0:discovery/addresses=CLEAR",
      "0:auditor/addresses=DECRYPTABLE",
      // findings/03: unlinkable to the public, and only within an uncounted crowd.
      "anon:0=UNKNOWN",
    ],
  ],

  // --- UNKNOWN rather than a false reassurance ----------------------------------------

  [
    "nothing declared: config absent",
    { actions: [{ type: "transfer", token: "STRK", amount: "5" }] },
    [
      // The load-bearing case. No discovery, no prover, no opensChannel declared, so the
      // tool must refuse to answer rather than emit the comfortable branch.
      "0:discovery/amount=UNKNOWN",
      "0:discovery/addresses=UNKNOWN",
      "0:prover/amount=UNKNOWN",
      "0:public/counterparty=UNKNOWN",
      "0:public/addresses=UNKNOWN",
      // And the one thing that is never unknown stays stated.
      "0:auditor/amount=DECRYPTABLE",
      "0:auditor/addresses=DECRYPTABLE",
      "anon:0=UNKNOWN",
    ],
  ],

  [
    "first transfer to a counterparty opens a channel",
    {
      config: { network: "mainnet", discovery: "client", proving: "mock" },
      actions: [{ type: "transfer", token: "STRK", amount: "5", opensChannel: true }],
    },
    [
      // recipient_channels is keyed by the plaintext recipient address, and
      // get_num_of_channels(recipient) is a public view.
      "0:public/counterparty=CLEAR",
      "0:public/addresses=CLEAR",
      "0:public/amount=NOT_DISCLOSED_BY_THIS_TX",
      "0:prover/amount=NOT_DISCLOSED_BY_THIS_TX",
      "anon:0=UNKNOWN",
    ],
  ],

  [
    "withdraw: destination public, withdrawer auditor-only",
    {
      config: { network: "sepolia", discovery: "client", proving: "mock" },
      actions: [{ type: "withdraw", token: "STRK", amount: "40", to: "0xdead" }],
    },
    [
      "0:public/amount=CLEAR",
      "0:public/token=CLEAR",
      "0:public/counterparty=CLEAR",
      "0:public/addresses=CLEAR",
      "0:auditor/addresses=DECRYPTABLE",
      "anon:0=UNKNOWN",
    ],
  ],

  [
    "a supplied observation is echoed, never invented",
    {
      config: { network: "mainnet", discovery: "client", proving: "mock" },
      observations: { registeredPoolUsers: 412 },
      actions: [{ type: "transfer", token: "STRK", amount: "5", opensChannel: false }],
    },
    ["anon:0=412"],
  ],

  [
    "unrecognised discovery kind is UNKNOWN, not a pass",
    {
      config: { network: "mainnet", discovery: "some-new-thing", proving: "mock" },
      actions: [{ type: "deposit", token: "STRK", amount: "1" }],
    },
    ["0:discovery/amount=UNKNOWN", "0:public/amount=CLEAR", "anon:0=1"],
  ],

  [
    "unrecognised action degrades to UNKNOWN and is reported as an input problem",
    {
      config: { network: "mainnet", discovery: "client", proving: "mock" },
      actions: [{ type: "teleport" }],
    },
    ["0:public/amount=UNKNOWN", "0:public/addresses=UNKNOWN", "0:auditor/amount=DECRYPTABLE"],
  ],
];

// ---------------------------------------------------------------------------

const VALUES = { CLEAR, DECRYPTABLE, NOT_DISCLOSED_BY_THIS_TX: NOT_DISCLOSED, UNKNOWN, "N/A": NA };

function check(report, sel) {
  const anon = sel.match(/^anon:(\d+)=(.+)$/);
  if (anon) {
    const s = report.anonymitySets[Number(anon[1])];
    const want = anon[2] === "UNKNOWN" ? UNKNOWN : Number(anon[2]);
    return { ok: s && s.size === want, got: s ? String(s.size) : "(missing)" };
  }
  const m = sel.match(/^(\d+):([a-z-]+)\/([a-z]+)=(.+)$/);
  if (!m) return { ok: false, got: "(unparseable expectation)" };
  const [, i, party, field, want] = m;
  const c = report.disclosures[Number(i)]?.byParty?.[party]?.[field];
  return { ok: c?.disclosure === (VALUES[want] ?? want), got: c?.disclosure ?? "(missing)" };
}

let failed = 0;

for (const [name, tx, expectations] of CASES) {
  const report = whatDoesThisLeak(tx);
  const bad = expectations
    .map((sel) => ({ sel, ...check(report, sel) }))
    .filter((r) => !r.ok);
  console.log(`${bad.length === 0 ? "PASS" : "FAIL"}  ${name}`);
  for (const b of bad) console.log(`      ${b.sel}  but got ${b.got}`);
  failed += bad.length === 0 ? 0 : 1;
}

// --- Invariants, checked over every case ------------------------------------------

const ALL = CASES.map(([name, tx]) => [name, whatDoesThisLeak(tx)]);

// 1. The auditor can decrypt everything, every time, whatever the configuration.
for (const [name, report] of ALL) {
  for (const d of report.disclosures) {
    const offenders = FIELDS.filter((f) => d.byParty.auditor[f].disclosure !== DECRYPTABLE);
    if (offenders.length) {
      console.log(`FAIL  invariant/auditor-always  ${name} action ${d.index}: ${offenders}`);
      failed++;
    }
  }
}

// 2. No cell and no anonymity set is ever emitted without a citation.
for (const [name, report] of ALL) {
  const uncited = [];
  for (const d of report.disclosures)
    for (const [key] of PARTIES)
      for (const f of FIELDS)
        if (!(d.byParty[key][f].cites?.length > 0)) uncited.push(`${d.index}:${key}/${f}`);
  for (const s of report.anonymitySets) if (!(s.cites?.length > 0)) uncited.push(`anon:${s.index}`);
  for (const n of report.notes) if (!(n.cites?.length > 0)) uncited.push(`note:${n.kind}`);
  if (uncited.length) {
    console.log(`FAIL  invariant/every-claim-cited  ${name}: ${uncited.join(" ")}`);
    failed++;
  }
}

// 3. No anonymity-set size exists unless it was derived or supplied. Every numeric size
//    must be traceable: either 1 from a keyed event field, or a caller observation.
for (const [name, report] of ALL) {
  for (const s of report.anonymitySets) {
    const okNumber =
      s.size === UNKNOWN ||
      (s.size === 1 && /Computed, not estimated/.test(s.basis)) ||
      /Taken from observations supplied by the caller/.test(s.basis);
    if (!okNumber) {
      console.log(`FAIL  invariant/no-invented-anonymity  ${name} action ${s.index}: ${s.size}`);
      failed++;
    }
  }
}

// 4. The tool never emits the words "is private" / "this is safe" as a bare claim.
for (const [name, report] of ALL) {
  const text = JSON.stringify(report);
  const banned = [/\bis private\b/i, /\bis safe\b/i, /\bfully private\b/i, /\byou are anonymous\b/i];
  const hit = banned.filter((r) => r.test(text));
  if (hit.length) {
    console.log(`FAIL  invariant/no-bare-privacy-claim  ${name}: ${hit.join(", ")}`);
    failed++;
  }
}

// 5. The unrecognised-action case must surface as an input problem, not silently.
const teleport = whatDoesThisLeak(CASES.at(-1)[1]);
if (teleport.problems.length === 0) {
  console.log("FAIL  invariant/unrecognised-input-is-reported");
  failed++;
}

// 6. Every citation is either something the reader of THIS distribution can open, or is
//    marked as held. The site enforces the matching property in web/test/site.test.ts —
//    "every citation is a file a reader of the repository can open" — and the devtool made the
//    same promise and broke it eight to ten times per run: `findings/` is gitignored pending
//    private contact with StarkWare, so it is in neither the tarball nor the public repo, and
//    the citations rendered identically to the `upstream:` ones beside them, which are real.
//
//    This runs in both worlds and must pass in both. In a checkout the findings are present
//    and NOTHING is marked; in a packed tarball every one of them is. So the assertion is the
//    property, never a count — a count would encode which world the suite happens to be in.
{
  // Two roots, because a citation resolves against wherever the reader is standing: in a
  // checkout `findings/` and `README.md` are at the repository root; in an installed package
  // the README is at the package root and there is no repository above it. Same pair
  // `facts.mjs:isHeldCite` uses, deliberately — a guard resolving paths differently from the
  // thing it guards would pass on a distribution the tool itself gets wrong.
  const PKG = join(here, "..", "..", "..");
  const REPO = join(PKG, "..");
  // A citation may name lines — `README.md:140-141`. The file is what has to exist.
  const filePart = (c) => c.replace(/:[\d,\-]+$/, "");
  const openableHere = (c) =>
    // `upstream:` names starkware-libs/starknet-privacy at UPSTREAM_COMMIT — a public
    // repository, openable by anyone with a browser, whether or not they cloned it.
    c.startsWith("upstream:") ||
    existsSync(join(PKG, filePart(c))) ||
    existsSync(join(REPO, filePart(c)));

  const cites = new Set();
  for (const [, report] of ALL) {
    for (const d of report.disclosures)
      for (const [key] of PARTIES) for (const f of FIELDS) for (const c of d.byParty[key][f].cites ?? []) cites.add(c);
    for (const s2 of report.anonymitySets) for (const c of s2.cites ?? []) cites.add(c);
    for (const n of report.notes) for (const c of n.cites ?? []) cites.add(c);
  }

  // Vacuity: a filter that silently matched nothing would make every check below pass.
  if (cites.size < 10) { console.log(`FAIL  invariant/citations-vacuous  only ${cites.size} citations collected`); failed++; }
  if (![...cites].some((c) => c.startsWith("upstream:"))) { console.log("FAIL  invariant/citations-vacuous  no upstream citation"); failed++; }
  if (![...cites].some((c) => c.startsWith("findings/"))) { console.log("FAIL  invariant/citations-vacuous  no findings citation"); failed++; }

  const unopenable = [...cites].filter((c) => !openableHere(c) && !isHeldCite(c));
  if (unopenable.length) {
    console.log(`FAIL  invariant/citation-openable-or-held  ${unopenable.join(" ")}`);
    failed++;
  }

  // The marker must track reality in BOTH directions: everything held is labelled, and
  // nothing openable is labelled. The second half is what fails the day `findings/` ships
  // and a static marker would have gone stale.
  const mislabelled = [...cites].filter((c) => (citeLabel(c) !== c) !== isHeldCite(c));
  const staleMark = [...cites].filter((c) => openableHere(c) && citeLabel(c) !== c);
  if (mislabelled.length || staleMark.length) {
    console.log(`FAIL  invariant/citation-marker-matches-reality  ${[...mislabelled, ...staleMark].join(" ")}`);
    failed++;
  }

  // And the report itself must say so, for `--json` and the MCP tool, which render nothing.
  const anyHeld = [...cites].some(isHeldCite);
  for (const [name, report] of ALL) {
    const hasNote = report.notes.some((n) => n.kind === "held");
    if (hasNote !== anyHeld) {
      console.log(`FAIL  invariant/held-note-present-iff-held  ${name}: note=${hasNote} held=${anyHeld}`);
      failed++;
    }
  }
}

console.log(
  failed === 0 ? "\nall cases and invariants behave as specified" : `\n${failed} failure(s)`
);
process.exit(failed === 0 ? 0 : 1);
