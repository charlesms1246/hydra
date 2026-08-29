/**
 * Renders every panel against real core data and asserts it does not throw.
 *
 * This exists because the first version crashed at runtime with
 * `Text string " " must be rendered inside <Text> component` — Ink forbids bare
 * strings as Box children, and nothing in the code looked wrong. Tests over
 * panels catch that class of error without needing a terminal.
 */

import { render } from "ink";
import { Writable } from "node:stream";
import { html } from "../src/ui.mjs";
import { Services, Wallets, Activity, Tools, LogPane, Transact } from "../src/panels.mjs";
import { status } from "../../core/src/services.mjs";
import { wallets } from "../../core/src/wallets.mjs";
import { latestBlocks } from "../../core/src/chain.mjs";
import { check } from "../../cli/src/doctor.mjs";

/** Mirrors app.mjs's TX_ACTIONS shape; the panel only reads id and label. */
const TX_ACTIONS = [
  { id: "shield", label: "Shield 100 STRK  (alice)" },
  { id: "register", label: "Register bob in the pool" },
  { id: "transfer", label: "Private transfer 50 STRK  alice → bob" },
  { id: "refresh", label: "Refresh notes" },
];

class Sink extends Writable {
  constructor() { super(); this.out = ""; }
  _write(c, _e, cb) { this.out += c.toString(); cb(); }
}

async function draw(name, node) {
  const stdout = new Sink();
  stdout.columns = 100;
  stdout.rows = 40;
  try {
    const app = render(node, { stdout, debug: true, patchConsole: false });
    await new Promise((r) => setTimeout(r, 60));
    app.unmount();
    const text = stdout.out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
    if (!text) throw new Error("rendered nothing");
    return { name, ok: true, text };
  } catch (e) {
    return { name, ok: false, error: e.message };
  }
}

const [s, w, b] = await Promise.all([
  status().catch(() => null),
  wallets().catch(() => null),
  latestBlocks(5).catch(() => null),
]);
let d = null;
try { d = { rows: check() }; } catch { d = { rows: [] }; }

// A failing, fixable row — the state the Tools pane exists to act on, and the
// one a green machine never renders.
const brokenDoc = {
  rows: [
    { status: "ok  ", name: "node", want: ">= 24", got: "24.20.0", cmd: null },
    { status: "MISS", name: "artifact: pool", want: "built", got: "missing",
      cmd: "scarb build -p privacy", cwd: "/tmp", hint: "(in /tmp) scarb build -p privacy" },
    { status: "MISS", name: "upstream checkout", want: "980da8", got: "not found",
      cmd: null, hint: "git clone … then set HYDRA_UPSTREAM" },
  ],
};

const results = [
  await draw("Services", html`<${Services} s=${s} />`),
  await draw("Wallets", html`<${Wallets} w=${w} selected=${0} />`),
  await draw("Activity", html`<${Activity} b=${b} />`),
  await draw("Tools", html`<${Tools} d=${d} selected=${0} confirm=${null} />`),
  await draw("Tools (fixable row selected)", html`<${Tools} d=${brokenDoc} selected=${1} confirm=${null} />`),
  await draw("Tools (row with no auto-fix)", html`<${Tools} d=${brokenDoc} selected=${2} confirm=${null} />`),
  await draw("Tools (confirming)", html`
    <${Tools} d=${brokenDoc} selected=${1}
      confirm=${{ row: brokenDoc.rows[1], cmd: "scarb build -p privacy", cwd: "/tmp" }} />`),
  await draw("Transact (no stack)",
    html`<${Transact} t=${{ available: false, reason: "no running stack" }} selected=${0} actions=${TX_ACTIONS} />`),
  await draw("Transact (idle, notes)",
    html`<${Transact} t=${{ available: true, notes: { alice: [{ symbol: "STRK", amount: "50" }], bob: [] } }}
        selected=${2} actions=${TX_ACTIONS} />`),
  await draw("Transact (after a transfer, with disclosure)",
    html`<${Transact} selected=${2} actions=${TX_ACTIONS} t=${{
      available: true,
      notes: { alice: [{ symbol: "STRK", amount: "50" }], bob: [{ symbol: "STRK", amount: "50" }] },
      last: { what: "Private transfer 50 STRK", ok: true, txHash: "0x30b936bf3444fb21ab" },
      leak: {
        subject: "Private transfer 50 STRK  alice → bob",
        rows: [
          { party: "public chain observer", summary: "learns timing", color: "red" },
          { party: "the counterparty", summary: "learns everything in clear", color: "red" },
          { party: "discovery service operator", summary: "learns everything in clear", color: "red" },
          { party: "proving service operator", summary: "nothing from this tx", color: "gray" },
          { party: "the auditor", summary: "can decrypt everything", color: "yellow" },
        ],
      },
    }} />`),
  await draw("Transact (failed action)",
    html`<${Transact} selected=${0} actions=${TX_ACTIONS} t=${{
      available: true, notes: { alice: [], bob: [] },
      last: { what: "Shield 100 STRK", ok: false, error: "Insufficient balance for token 0x47…" },
    }} />`),
  await draw("LogPane", html`<${LogPane} lines=${["$ scarb build", "Compiling privacy", "Finished"]} title="fix: pool" />`),
  // Degraded states must render too — a status view that crashes when the stack
  // is down is worse than useless.
  await draw("Services (no data)", html`<${Services} s=${null} />`),
  await draw("Wallets (no stack)", html`<${Wallets} w=${{ available: false, reason: "no stack" }} selected=${0} />`),
];

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  — " + r.error}`);
  if (!r.ok) failed++;
}
if (process.argv.includes("--show")) {
  for (const r of results.filter((x) => x.ok)) {
    console.log(`\n--- ${r.name} ---\n${r.text}`);
  }
}
console.log(failed === 0 ? "\nall panels render" : `\n${failed} panel(s) failed`);
process.exit(failed ? 1 : 0);
