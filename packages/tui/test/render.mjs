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
import { Services, Wallets, Activity, Tools } from "../src/panels.mjs";
import { status } from "../../core/src/services.mjs";
import { wallets } from "../../core/src/wallets.mjs";
import { latestBlocks } from "../../core/src/chain.mjs";
import { check } from "../../cli/src/doctor.mjs";

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

const results = [
  await draw("Services", html`<${Services} s=${s} />`),
  await draw("Wallets", html`<${Wallets} w=${w} selected=${0} />`),
  await draw("Activity", html`<${Activity} b=${b} />`),
  await draw("Tools", html`<${Tools} d=${d} />`),
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
