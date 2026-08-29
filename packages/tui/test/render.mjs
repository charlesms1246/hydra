/**
 * Renders every panel against real-shaped data and asserts it does not throw.
 *
 * This exists because the first version crashed at runtime with
 * `Text string " " must be rendered inside <Text> component` — Ink forbids bare
 * strings as Box children, and nothing in the code looked wrong. Tests over
 * panels catch that class of error without needing a terminal.
 *
 * It has since grown three more jobs, each of them a defect that shipped once:
 *   - the frame must stay UNDER stdout.rows, because Ink clears the whole
 *     terminal at `outputHeight >= rows` (ink/build/ink.js:121);
 *   - all 30 matrix cells must survive at 80 columns with their words intact;
 *   - the report the TUI generates must not contain the live Sepolia auditor key,
 *     which the old hardcoded `network: "sepolia"` put there for a local devnet.
 */

import { render } from "ink";
import { Writable, PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { html } from "../src/ui.mjs";
import { Services, Wallets, Activity, Tools, LogPane, Transact, Rig, Confirm, Help, PANES, visibleItems } from "../src/panels.mjs";
import { Matrix, Legend, WhyDrawer, NotesDrawer, AnonDrawer, EmptyState, Ledger, ConfigStrip, CONFIG_FIXED, leakConfig, sample, pickArt } from "../src/disclosure.mjs";
import { fit, wrap, windowOf, indicatorFor } from "../src/layout.mjs";
import { C, DISCLOSURE } from "../src/theme.mjs";
import { BINDINGS, duplicateBindings, helpGroups, scopesFor, dispatch } from "../src/keymap.mjs";
import { App, TX_ACTIONS, RIG_IDS } from "../src/app.mjs";
import { whatDoesThisLeak } from "../../leak/src/leak.mjs";
import { AUDITOR_NOTE } from "../../cli/src/notes.mjs";
import { COMMANDS } from "../../cli/src/agentcmds.mjs";
import { status } from "../../core/src/services.mjs";
import { wallets } from "../../core/src/wallets.mjs";
import { latestBlocks } from "../../core/src/chain.mjs";
import { check } from "../../cli/src/doctor.mjs";

/**
 * In debug mode Ink writes one complete frame per render (ink/build/ink.js:104),
 * so each chunk IS a frame. Keeping them separately is what lets an assertion
 * talk about "the frame" rather than about every frame concatenated — the first
 * version of this file counted 10 DECRYPTABLEs in a 5-cell column for that reason.
 */
class Sink extends Writable {
  constructor(cols = 100, rows = 40) {
    super();
    this.out = "";
    this.frames = [];
    this.columns = cols;
    this.rows = rows;
  }
  _write(c, _e, cb) { const t = c.toString(); this.out += t; this.frames.push(t); cb(); }
}

/** Ink reads input with `readable` + read(), so a PassThrough is enough. */
function fakeStdin() {
  const s = new PassThrough();
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

const strip = (t) => t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

const results = [];

/** One component, one frame, as text. Used where an assertion needs the pixels. */
function renderOnce(node, cols) {
  const out = new Sink(cols, 40);
  const app = render(node, { stdout: out, debug: true, patchConsole: false });
  app.unmount();
  return (out.frames.at(-1) ?? "").replace(/\n$/, "");
}

function check_(name, fn) {
  try {
    const extra = fn();
    // A check whose precondition does not hold on this machine reports SKIP, never PASS.
    // Counting an unexercised path as green is the false-coverage failure this suite was
    // rewritten to catch; it should not be reintroduced by the harness itself.
    if (extra && typeof extra === "object" && extra.skip) {
      results.push({ name, ok: true, skip: extra.skip });
      return;
    }
    results.push({ name, ok: true, note: typeof extra === "string" ? extra : "" });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

async function draw(name, node, cols = 100, rows = 40) {
  const stdout = new Sink(cols, rows);
  try {
    const app = render(node, { stdout, debug: true, patchConsole: false });
    await new Promise((r) => setTimeout(r, 60));
    app.unmount();
    const text = strip(stdout.frames.at(-1) ?? "").trim();
    if (!text) throw new Error("rendered nothing");
    results.push({ name, ok: true, text });
    return text;
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    return "";
  }
}

// ---------------------------------------------------------------------------
// real data off this machine, plus the degraded shapes a green machine never has
// ---------------------------------------------------------------------------

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
      cmd: null, hint: "git clone … then set HYDRA_UPSTREAM\n       then set HYDRA_UPSTREAM=<dir>" },
  ],
};

const fakeBlocks = {
  available: true, head: 1271,
  blocks: [{ number: 1271, hash: "0x77e1a4c209ff31b8de5c0a7742e0d3915b6c7a91", timestamp: 1, txCount: 3,
    txs: ["0x77e1a4c209ff31b8", "0x0b42aa1122334455", "0x91cc0700aabbccdd"], status: "ACCEPTED_ON_L2" }],
};
const fakeWallets = {
  available: true, tokens: { STRK: "0x4" },
  wallets: [{ name: "alice", address: "0x" + "a".repeat(63), balances: { STRK: { raw: "1000000000000000000", formatted: "1.0000" } } }],
};

const transferReport = whatDoesThisLeak({
  config: leakConfig({ prover: { mode: "mock" } }),
  actions: [{ type: "transfer", token: "STRK", amount: "50", counterparty: "bob", opensChannel: false }],
});
// The case the old six-line summary got WRONG: two UNKNOWNs and three CLEARs on
// the public row, collapsed by `if (clear.length)` into "learns counterparty,
// timing, addresses" — deleting both UNKNOWNs.
const invokeReport = whatDoesThisLeak({
  config: leakConfig({ prover: { mode: "mock" } }),
  actions: [{ type: "invoke", via: "shadow-account", dapp: "ekubo" }],
});
const cursor0 = { run: 0, action: 0, party: 3, field: 0, drawer: "why", expanded: false, scroll: 0 };
const g100 = fit(100, 30);
const g80 = fit(80, 24);

// ---------------------------------------------------------------------------
// panels, at list level, with real / null / error data
// ---------------------------------------------------------------------------

await draw("Services", html`<${Services} s=${s} />`);
await draw("Services (no data)", html`<${Services} s=${undefined} />`);
await draw("Services (status() failed)", html`<${Services} s=${null} />`);
await draw("Wallets", html`<${Wallets} w=${fakeWallets} selected=${0} />`);
await draw("Wallets (no stack)", html`<${Wallets} w=${{ available: false, reason: "no running stack" }} selected=${0} />`);
await draw("Wallets (loading)", html`<${Wallets} w=${undefined} selected=${0} />`);
await draw("Activity", html`<${Activity} b=${fakeBlocks} />`);
await draw("Activity (real)", html`<${Activity} b=${b} />`);
await draw("Activity (rpc error)", html`<${Activity} b=${{ available: false, reason: "connect ECONNREFUSED" }} />`);
await draw("Tools", html`<${Tools} d=${d} selected=${0} />`);
await draw("Tools (fixable row selected)", html`<${Tools} d=${brokenDoc} selected=${1} />`);
await draw("Tools (check() threw)", html`<${Tools} d=${{ rows: [], error: "scarb not on PATH" }} />`);
await draw("LogPane", html`<${LogPane} lines=${[{ text: "$ scarb build", sev: "info" }, { text: "warning: unused", sev: "warn" }]} title="fix: pool" width=${96} height=${8} />`);
await draw("LogPane (empty)", html`<${LogPane} lines=${[]} title="" width=${96} height=${8} />`);
await draw("Transact (run menu)", html`<${Transact} actions=${TX_ACTIONS} selected=${2} width=${96} height=${9} />`);
await draw("Confirm (doctor fix)", html`<${Confirm} c=${{ prompt: "run this?", cmd: "scarb build", cwd: "/tmp", lines: ["it keeps running"] }} width=${96} />`);
await draw("Help", html`<${Help} groups=${helpGroups()} width=${96} height=${26} />`);

// ---------------------------------------------------------------------------
// the rig, descended
// ---------------------------------------------------------------------------

await draw("Rig activity · level 1 (block, tx list)",
  html`<${Rig} pane=${PANES.activity} data=${fakeBlocks} nav=${{ level: 1, sel: [0, 1] }} width=${96} height=${20} />`);
await draw("Rig activity · level 2 (txStatus receipt)",
  html`<${Rig} pane=${PANES.activity} data=${fakeBlocks} nav=${{ level: 2, sel: [0, 1] }} width=${96} height=${20}
    receipt=${{ available: true, found: true, hash: "0x0b42aa", finality: "ACCEPTED_ON_L2", execution: "SUCCEEDED", blockNumber: 1271, actualFee: { amount: "0x1a", unit: "FRI" }, events: 12, revertReason: null }} />`);
await draw("Rig activity · level 2 (receipt still loading)",
  html`<${Rig} pane=${PANES.activity} data=${fakeBlocks} nav=${{ level: 2, sel: [0, 0] }} width=${96} height=${20} receipt=${null} />`);
await draw("Rig wallets · level 1 (raw balances)",
  html`<${Rig} pane=${PANES.wallets} data=${fakeWallets} nav=${{ level: 1, sel: [0, 0] }} width=${96} height=${20} />`);
await draw("Rig tools · level 1 (whole multi-line hint)",
  html`<${Rig} pane=${PANES.tools} data=${brokenDoc} nav=${{ level: 1, sel: [2, 0] }} width=${96} height=${20} />`);
await draw("Rig tools · filtered",
  html`<${Rig} pane=${PANES.tools} data=${brokenDoc} nav=${{ level: 0, sel: [0, 0] }} width=${96} height=${20} filter=${{ text: "artifact", typing: false }} />`);

// ---------------------------------------------------------------------------
// the home screen
// ---------------------------------------------------------------------------

const m100 = await draw("Matrix @100", html`
  <${Matrix} report=${transferReport} actionIndex=${0} cursor=${cursor0} geom=${g100}
    width=${g100.boxW} focused=${true} headline="who learns what · transfer 50 STRK" />`);
const m80 = await draw("Matrix @80", html`
  <${Matrix} report=${transferReport} actionIndex=${0} cursor=${cursor0} geom=${g80}
    width=${g80.boxW} focused=${true} headline="declared action shape, not the receipt" />`, 80, 24);
const mInv = await draw("Matrix @100 · invoke (the UNKNOWN case)", html`
  <${Matrix} report=${invokeReport} actionIndex=${0} cursor=${cursor0} geom=${g100}
    width=${g100.boxW} focused=${true} headline="invoke" />`);
await draw("Legend @80", html`<${Legend} width=${78} />`, 80, 24);
await draw("WhyDrawer", html`
  <${WhyDrawer} report=${transferReport} actionIndex=${0} cursor=${cursor0} width=${g100.boxW}
    bodyRows=${4} citeRows=${2} scroll=${0} focused=${true} expanded=${false} />`);
await draw("WhyDrawer (expanded)", html`
  <${WhyDrawer} report=${transferReport} actionIndex=${0} cursor=${cursor0} width=${g100.boxW}
    bodyRows=${14} citeRows=${4} scroll=${0} focused=${true} expanded=${true} />`);
await draw("NotesDrawer", html`
  <${NotesDrawer} report=${transferReport} auditorNote=${AUDITOR_NOTE} width=${g100.boxW}
    bodyRows=${6} scroll=${0} focused=${true} />`);
await draw("AnonDrawer", html`
  <${AnonDrawer} report=${transferReport} actionIndex=${0} width=${g100.boxW} bodyRows=${6} scroll=${0} focused=${true} />`);
await draw("Ledger", html`
  <${Ledger} runs=${[{ id: "1", at: "14:02:11", label: "transfer 50 STRK", ok: true, txHash: "0x07f1c3aa", ms: 4812, report: transferReport }]}
    selected=${0} rows=${3} width=${98} />`);
await draw("ConfigStrip", html`<${ConfigStrip} cfg=${leakConfig(s)} width=${98} />`);
const empty = await draw("EmptyState (no stack — the art)",
  html`<${EmptyState} hasStack=${false} width=${78} height=${21} />`, 80, 24);
await draw("EmptyState (stack up, nothing run)",
  html`<${EmptyState} hasStack=${true} width=${78} height=${21} />`, 80, 24);

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

check_("fit() never exceeds rows-1, at every size", () => {
  for (const [c, r] of [[100, 30], [80, 24], [200, 50], [70, 20], [120, 40], [80, 60], [240, 24]]) {
    const f = fit(c, r);
    const sum = 4 + 10 + 1 + f.ledgerRows + (f.ledgerRule ? 1 : 0) + f.drawerBody + f.drawerCites + 2 + f.notesRows;
    if (sum > f.draw) throw new Error(`${c}x${r}: regions sum to ${sum} > ${f.draw}`);
    // reportRows is what app.mjs pins the home screen to, so it is the number
    // that actually bounds the frame. 4 fixed rows + it must clear stdout.rows.
    if (f.reportRows !== sum - 4) throw new Error(`${c}x${r}: reportRows ${f.reportRows} != plan ${sum - 4}`);
    if (4 + f.reportRows > f.draw) throw new Error(`${c}x${r}: 4 + ${f.reportRows} > ${f.draw}`);
    if (!f.matrixFits) throw new Error(`${c}x${r}: matrix does not fit`);
    if (f.fieldW < 11) throw new Error(`${c}x${r}: fieldW ${f.fieldW} truncates DECRYPTABLE`);
  }
  return "100x30 80x24 200x50 70x20 120x40 80x60 240x24";
});

check_("all 30 cells survive at 100 and at 80 columns", () => {
  for (const [label, text] of [["100", m100], ["80", m80]]) {
    const words = (text.match(/CLEAR|DECRYPTABLE|not-by-tx|UNKNOWN/g) ?? []).length;
    if (words < 30) throw new Error(`@${label}: only ${words} cell words rendered, want 30`);
    const dec = (text.match(/DECRYPTABLE/g) ?? []).length;
    if (dec !== 5) throw new Error(`@${label}: DECRYPTABLE appears ${dec} times, want 5 unabbreviated`);
  }
  return "30 cells, DECRYPTABLE ×5, both widths";
});

check_("the invoke UNKNOWNs the old summary deleted are on screen", () => {
  const n = (mInv.match(/UNKNOWN/g) ?? []).length;
  if (n < 2) throw new Error(`only ${n} UNKNOWN cells rendered; the public row has two`);
  return `${n} UNKNOWN cells rendered`;
});

check_("the legend is present at 80 columns", () => {
  if (!m80.includes("who learns what") && !m80.includes("declared action shape")) {
    throw new Error("matrix title missing at 80 cols");
  }
  return "matrix title survives";
});

check_("the empty state's auditor row is generated, not typed", () => {
  const rep = whatDoesThisLeak({ config: leakConfig(null), actions: [{ type: "register" }] });
  for (const f of rep.fields) {
    const word = DISCLOSURE[rep.disclosures[0].byParty.auditor[f].disclosure].word;
    if (!empty.includes(word)) throw new Error(`${f}: leak says ${word}, the empty state does not show it`);
  }
  // It used to be five `"DECRYPTABLE"` string literals, which is a disclosure
  // claim asserted rather than computed on the first screen a new user sees.
  const src = readFileSync(new URL("../src/disclosure.mjs", import.meta.url), "utf8");
  const inEmpty = src.slice(src.indexOf("export const EmptyState"));
  if (/"(CLEAR|DECRYPTABLE|UNKNOWN|N\/A)"/.test(inEmpty)) throw new Error("a disclosure word is still typed into EmptyState");
  return rep.fields.map((f) => `${f}=${rep.disclosures[0].byParty.auditor[f].disclosure}`).join(" ");
});

check_("the config strip names every fixed value at 70 columns, and marks them fixed", () => {
  for (const width of [70, 78, 98, 198]) {
    const line = strip(renderOnce(html`<${ConfigStrip} cfg=${leakConfig(s)} width=${width} />`, width));
    if (line.length > width) throw new Error(`${width}: strip is ${line.length} wide`);
    if (!line.includes("fixed")) throw new Error(`${width}: the typed values are not marked as typed`);
    for (const [, shortValue] of CONFIG_FIXED) {
      const head = shortValue.split(" ")[0];
      if (!line.includes(head)) throw new Error(`${width}: "${head}" truncated off the strip`);
    }
  }
  return "70/78/98/198 — ohttp, network, escrow all present, all marked fixed";
});

check_("no colour in the disclosure vocabulary is the liveness green", () => {
  for (const [k, v] of Object.entries(DISCLOSURE)) {
    if (v.color === C.ok) throw new Error(`${k} is ${C.ok}; green is reserved for liveness`);
  }
  return "green unreachable from DISCLOSURE";
});

check_("the generated report contains no live auditor key and says the key is UNKNOWN", () => {
  const j = JSON.stringify(transferReport);
  const sepolia = "0x1d17f98be07e99713265714699a5c40ccbf7b50c950fb7a2abd81846fcdfbb2";
  if (j.includes(sepolia)) throw new Error("the Sepolia auditor key is in a devnet report");
  if (!transferReport.notes.some((n) => n.kind === "unknown")) throw new Error("no kind:unknown note");
  if (transferReport.problems.length) throw new Error(`problems: ${transferReport.problems.join("; ")}`);
  return "no key, one unknown note, zero input problems";
});

check_("the auditor row is DECRYPTABLE on every field of every action type", () => {
  for (const type of ["register", "deposit", "transfer", "withdraw", "invoke"]) {
    const rep = whatDoesThisLeak({ config: leakConfig(null), actions: [{ type, token: "STRK", amount: "1" }] });
    for (const f of rep.fields) {
      const c = rep.disclosures[0].byParty.auditor[f];
      if (c.disclosure !== "DECRYPTABLE") throw new Error(`${type}.${f} is ${c.disclosure}`);
    }
  }
  return "5 action types × 5 fields";
});

check_("no binding claims a (scope, key) pair twice", () => {
  const dupes = duplicateBindings();
  if (dupes.length) throw new Error(dupes.join(", "));
  return `${BINDINGS.length} bindings, 0 collisions`;
});

check_("every binding is reachable from a live scope, and documented", () => {
  const states = [
    { report: null, overlay: null, confirm: null, filter: null },
    { report: {}, overlay: null, confirm: null, filter: null },
    { report: {}, overlay: "rig:tools", confirm: null, filter: null },
    { report: {}, overlay: "rig:wallets", confirm: null, filter: null },
    { report: {}, overlay: "rig:activity", confirm: null, filter: null },
    { report: {}, overlay: "run", confirm: null, filter: null },
    { report: {}, overlay: "log", confirm: null, filter: null },
    { report: {}, overlay: "help", confirm: null, filter: null },
    { report: {}, overlay: null, confirm: {}, filter: null },
  ];
  const live = new Set(states.flatMap((st) => scopesFor(st)));
  for (const b of BINDINGS) {
    if (!live.has(b.scope)) throw new Error(`scope ${b.scope} is never live`);
    if (!b.label) throw new Error(`binding ${b.keys.join("/")} has no label — it would be undocumented`);
  }
  const rows = helpGroups().reduce((n, g) => n + g.rows.length, 0);
  if (rows !== BINDINGS.length) throw new Error("help drops bindings");
  return `${rows} rows in ?`;
});

// The 120-second dead keyboard: `if (busy) return` at the top of the old
// useInput swallowed every key including q, while Ink's own Ctrl-C handler
// exited mid-fix anyway. These four assert the replacement.
const keyState = (over = {}) => ({
  cursor: { run: 0, action: 0, party: 2, field: 1, drawer: "why", expanded: false, scroll: 0 },
  report: transferReport, overlay: null, confirm: null, filter: null, busy: null, up: false,
  partyCount: 6, fieldCount: 5, actionCount: 1, ...over,
});
const KEY = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, return: false,
  escape: false, tab: false, shift: false, pageUp: false, pageDown: false, ctrl: false, meta: false,
  backspace: false, delete: false };
function fire(st, input, key = {}) {
  const calls = [];
  const api = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, args]) });
  dispatch(st, input, { ...KEY, ...key }, api);
  return calls;
}

check_("navigation stays live while busy; a mutating key says why it did not", () => {
  const busy = keyState({ busy: { label: "starting the stack" } });
  if (fire(busy, "j")[0]?.[0] !== "cursor") throw new Error("j was swallowed while busy");
  if (fire(busy, "L")[0]?.[0] !== "toggleOverlay") throw new Error("L was swallowed while busy");
  const gated = fire(busy, "u");
  if (gated[0]?.[0] !== "note") throw new Error("u ran a mutation while busy");
  if (!/working/.test(gated[0][1][0])) throw new Error("suppressed key said nothing");
  return "j and L live, u refused with a reason";
});

check_("q while busy prompts instead of quitting or being swallowed", () => {
  if (fire(keyState({ busy: { label: "fixing" } }), "q")[0]?.[0] !== "askQuit") throw new Error("no prompt");
  if (fire(keyState(), "q")[0]?.[0] !== "exit") throw new Error("q does not quit when idle");
  return "busy → askQuit, idle → exit";
});

check_("esc never quits, and resolves in one fixed order", () => {
  const calls = fire(keyState({ overlay: "rig:tools" }), "", { escape: true });
  if (calls[0]?.[0] !== "escape") throw new Error("esc is not routed to the ordered handler");
  for (const st of [keyState(), keyState({ overlay: "log" }), keyState({ report: null })]) {
    if (fire(st, "", { escape: true }).some(([n]) => n === "exit")) throw new Error("esc quit");
  }
  return "esc → escape(), never exit()";
});

check_("while / is open every printable key is data, not a command", () => {
  const typing = keyState({ overlay: "rig:tools", filter: { text: "art", typing: true } });
  const c = fire(typing, "q");
  if (c[0]?.[0] !== "setFilter" || c[0][1][0].text !== "artq") throw new Error("q was treated as quit");
  if (fire(typing, "", { escape: true })[0]?.[1][0] !== null) throw new Error("esc does not clear the filter");
  return "q types a q; esc clears";
});

check_("with / open, keys act on the filtered list, not the underlying one", () => {
  const f = { text: "upstream", typing: false };
  const shown = visibleItems(PANES.tools, brokenDoc, f);
  if (shown.length !== 1 || shown[0].name !== "upstream checkout") {
    throw new Error(`filter gave ${shown.map((r) => r.name).join(",")}`);
  }
  // Row 0 of the filtered list is row 2 of the real one. `i` reading the real
  // list here would offer to run a fix for a row that is not on screen.
  if (visibleItems(PANES.tools, brokenDoc, null)[0].name === shown[0].name) {
    throw new Error("the fixture cannot detect the off-by-index bug");
  }
  return "1 of 3 rows, and it is the selected one";
});

check_("List windows 200 items into 8 rows and pads", () => {
  const { start, end } = windowOf(200, 199, 8);
  if (end !== 200 || end - start !== 8) throw new Error(`window ${start}-${end}`);
  const first = windowOf(200, 0, 8);
  if (first.start !== 0) throw new Error("g does not reach the first row");
  const twelve = windowOf(12, 10, 8);
  if (twelve.start > 10 || twelve.end <= 10) throw new Error("selection 11 of 12 is off screen");
  if (indicatorFor(12, 0, 12) !== "12/12") throw new Error(indicatorFor(12, 0, 12));
  return "G → 193-200/200, g → 1-8, 11 of 12 visible";
});

check_("wrap() never emits a line wider than the width", () => {
  const why = transferReport.disclosures[0].byParty.discovery.amount.why;
  for (const width of [40, 60, 76, 96]) {
    for (const l of wrap(why, width)) if (l.length > width) throw new Error(`${l.length} > ${width}`);
  }
  return `why is ${why.length} chars; wraps clean at 40/60/76/96`;
});

check_("the art downsamples to the two gated sizes and to nothing below them", () => {
  if (sample(9, 50).length !== 9) throw new Error("9x50 sampler wrong height");
  if (pickArt(96, 20)?.length !== 13) throw new Error("13x62 gate not taken at 96x20");
  if (pickArt(50, 10)?.length !== 9) throw new Error("9x50 gate not taken at 50x10");
  if (pickArt(30, 7) !== null) throw new Error("7x30 must not be a gate — it is mush");
  if (!empty.includes("#")) throw new Error("the empty state rendered no art");
  return "13x62, 9x50, nothing below";
});

// ---------------------------------------------------------------------------
// the whole app, at the two sizes that matter, driven by keystrokes
// ---------------------------------------------------------------------------

async function mount(cols, rows) {
  const stdout = new Sink(cols, rows);
  const stdin = fakeStdin();
  const app = render(html`<${App} />`, { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 120));
  return {
    app, stdout,
    press: async (k) => { stdin.write(k); await new Promise((r) => setTimeout(r, 90)); },
    last: () => strip(stdout.frames.at(-1) ?? ""),
  };
}

for (const [cols, rows] of [[100, 30], [80, 24]]) {
  const h = await mount(cols, rows);
  // Ink's frame ends in a newline; that trailing empty string is not a row.
  const frame = h.last().replace(/\n$/, "").split("\n");
  results.push({ name: `App @${cols}x${rows} (cold start)`, ok: frame.length > 0, text: h.last() });
  check_(`App @${cols}x${rows} draws fewer than ${rows} rows (no clearTerminal)`, () => {
    if (frame.length >= rows) throw new Error(`${frame.length} rows >= stdout.rows ${rows}`);
    const over = frame.filter((l) => l.length > cols);
    if (over.length) throw new Error(`${over.length} line(s) wider than ${cols}: ${over[0].length}`);
    return `${frame.length} rows, max width ${Math.max(...frame.map((l) => l.length))}`;
  });
  h.app.unmount();
}

// The band that actually cleared the terminal. This is the check the previous
// version of this file was missing: it asserted the no-clear invariant on a cold
// start, where there is no report and therefore no `why` drawer, and the drawer's
// own wrapping is what overflowed the plan below 78 columns.
{
  const h = await mount(80, 24);
  await h.press("e");                    // load packages/leak/examples/private-transfer.json
  const seen = [];
  for (let cols = 70; cols <= 78; cols++) {
    for (const rows of [20, 22, 24, 30]) {
      h.stdout.columns = cols; h.stdout.rows = rows; h.stdout.emit("resize");
      await new Promise((r) => setTimeout(r, 40));
      const f = h.last().replace(/\n$/, "").split("\n");
      seen.push({ cols, rows, r: f.length, c: Math.max(...f.map((l) => l.length)), why: f.some((l) => l.includes("why ·")) });
    }
  }
  h.app.unmount();
  check_("with a report on screen the frame stays under stdout.rows across 70-78 columns", () => {
    if (!seen.every((x) => x.why)) throw new Error("no `why` drawer on screen — this would prove nothing");
    for (const x of seen) {
      if (x.r >= x.rows) throw new Error(`${x.cols}x${x.rows}: drew ${x.r} rows >= stdout.rows ${x.rows}`);
      if (x.c > x.cols) throw new Error(`${x.cols}x${x.rows}: drew ${x.c} columns > ${x.cols}`);
    }
    return `${seen.length} sizes, every one at most ${Math.max(...seen.map((x) => x.r - x.rows))} rows over`;
  });
}

// Resize was previously not handled at all: the app read stdout.columns once.
{
  const stdout = new Sink(100, 30);
  const stdin = fakeStdin();
  const app = render(html`<${App} />`, { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 150));
  const shape = () => {
    const l = strip(stdout.frames.at(-1) ?? "").replace(/\n$/, "").split("\n");
    return { rows: l.length, cols: Math.max(...l.map((x) => x.length)) };
  };
  const seen = [{ want: [100, 30], got: shape() }];
  for (const [c, r] of [[80, 24], [200, 50], [70, 20]]) {
    stdout.columns = c; stdout.rows = r; stdout.emit("resize");
    await new Promise((x) => setTimeout(x, 150));
    seen.push({ want: [c, r], got: shape() });
  }
  app.unmount();
  check_("the frame follows a live resize and never reaches stdout.rows", () => {
    for (const { want: [c, r], got } of seen) {
      if (got.rows >= r) throw new Error(`${c}x${r}: drew ${got.rows} rows`);
      if (got.cols > c) throw new Error(`${c}x${r}: drew ${got.cols} columns`);
    }
    return seen.map(({ want, got }) => `${want[0]}x${want[1]}→${got.rows}r/${got.cols}c`).join(" ");
  });
}
{
  const h = await mount(100, 30);
  const seen = {};
  for (const [key, name] of [["s", "services"], ["w", "wallets"], ["a", "activity"], ["t", "tools"],
                             ["x", "run"], ["L", "log"], ["?", "help"]]) {
    await h.press(key);
    seen[name] = h.last();
    await h.press(key);          // the same key closes
  }
  // t → j (select a row) → i (ask to fix). The prompt must name the exact command.
  await h.press("t");
  await new Promise((r) => setTimeout(r, 400));   // check() is synchronous; give it a beat
  const tools = h.last();
  let confirmed = "";
  for (let i = 0; i < 12; i++) {
    await h.press("j");
    await h.press("i");
    const f = h.last();
    if (f.includes("run this? it executes a real command")) { confirmed = f; break; }
    await h.press("n");
  }
  h.app.unmount();

  check_("s w a t x L ? each reach their overlay", () => {
    const want = {
      services: "rig · services", wallets: "rig · wallets", activity: "rig · activity",
      tools: "rig · tools", run: "x · run a flow", log: "log ·", help: "? keys",
    };
    for (const [k, needle] of Object.entries(want)) {
      if (!seen[k]?.includes(needle)) throw new Error(`${k}: "${needle}" not on screen`);
    }
    return Object.keys(want).join(" ");
  });
  check_("the tools rig lists the doctor rows", () => {
    if (!tools.includes("want")) throw new Error("no doctor rows rendered");
    return tools.split("\n").filter((l) => l.includes("want")).length + " rows";
  });
  check_("i on a fixable row prompts with the exact cmd and cwd", () => {
    const real = (check().find((r) => r.status.trim() !== "ok" && r.cmd) ?? {}).cmd;
    // A fully provisioned machine has no fixable row, so this interaction cannot be
    // driven at all. That is a skip, not a pass — and not a failure of the UI either.
    if (!real) return { skip: "no fixable doctor row on this machine — nothing to confirm" };
    if (!confirmed) throw new Error("never reached the confirm prompt");
    if (real && !confirmed.includes(real.slice(0, 40))) throw new Error("prompt does not show the real command");
    if (!confirmed.includes("y run · n cancel")) throw new Error("no y/n prompt");
    return real.slice(0, 46) + "…";
  });
}

// `?` is the documented answer to "what are the keys", so the assertion has to be
// about what a reader can actually reach at a common terminal size. Asserting
// against helpGroups() instead is how 23 of 39 bindings stayed off screen at
// 80x24 while this file reported the keymap fully documented.
for (const [cols, rows] of [[80, 24], [100, 30]]) {
  const h = await mount(cols, rows);
  await h.press("?");
  const frames = [h.last()];
  for (let i = 0; i < 8; i++) { await h.press("\x1b[6~"); frames.push(h.last()); }   // pgdn
  await h.press("G");
  frames.push(h.last());
  h.app.unmount();
  check_(`every binding is reachable on screen in \`?\` at ${cols}x${rows}`, () => {
    const labels = BINDINGS.map((b) => b.label);
    if (new Set(labels).size !== labels.length) throw new Error("two bindings share a label; this check cannot tell them apart");
    const seen = frames.join("\n");
    const width = cols >= 80 ? cols - 2 : cols;
    const missing = BINDINGS.filter((b) => !seen.includes(b.label.slice(0, Math.max(1, width - 28))));
    if (missing.length) {
      throw new Error(`${missing.length} of ${BINDINGS.length} never on screen: ${missing.slice(0, 3).map((b) => b.keys.join("/")).join(", ")}`);
    }
    if (seen.includes("a taller terminal shows them")) throw new Error("`?` still defers to a bigger terminal");
    return `${BINDINGS.length} bindings, all reachable with pgdn/G`;
  });
}

// ---------------------------------------------------------------------------
// parity — the matrix is a pane AND a command
// ---------------------------------------------------------------------------

check_("every rig pane has a `hydra <cmd> --json` twin", () => {
  const map = { services: "status", wallets: "wallets", activity: "blocks", tools: "doctor" };
  for (const id of RIG_IDS) if (!COMMANDS[map[id]]) throw new Error(`${id} has no COMMANDS twin`);
  return RIG_IDS.map((id) => `${id}→${map[id]}`).join(" ");
});

const leakCmd = await COMMANDS.leak.run(["transfer"]);
check_("the home screen has a `hydra leak --json` twin, on the same config", () => {
  if (!COMMANDS.leak) throw new Error("COMMANDS has no `leak`; the disclosure matrix has no CLI twin");
  const mine = leakConfig(s);
  if (leakCmd.config.discovery !== mine.discovery || leakCmd.config.proving !== mine.proving) {
    throw new Error(`pane config ${JSON.stringify(mine)} != command config ${JSON.stringify(leakCmd.config)}`);
  }
  // Same 30 cells, from the same call, so the two surfaces cannot disagree.
  const mineReport = whatDoesThisLeak({ config: mine, actions: [{ type: "transfer", token: "STRK", amount: "50", counterparty: "bob", opensChannel: false }] });
  for (const [id] of mineReport.parties) {
    for (const f of mineReport.fields) {
      const a = mineReport.disclosures[0].byParty[id][f].disclosure;
      const c = leakCmd.disclosures[0].byParty[id][f].disclosure;
      if (a !== c) throw new Error(`${id}.${f}: pane ${a} vs command ${c}`);
    }
  }
  const text = COMMANDS.leak.render(leakCmd);
  if (!text.includes("NOT a claim of privacy")) throw new Error("`hydra leak` renders no gloss for NOT_DISCLOSED");
  return "hydra leak · 30 cells identical to the pane's";
});

// ---------------------------------------------------------------------------

let failed = 0;
const known = "[KNOWN GAP]";
let skipped = 0;
for (const r of results) {
  const gap = r.name.includes(known);
  const tag = r.skip ? "SKIP" : r.ok ? "PASS" : gap ? "GAP " : "FAIL";
  const trailer = r.skip ? "  — " + r.skip : r.ok ? (r.note ? "  — " + r.note : "") : "  — " + r.error;
  console.log(`${tag}  ${r.name}${trailer}`);
  if (r.skip) skipped++;
  else if (!r.ok && !gap) failed++;
}
if (process.argv.includes("--show")) {
  for (const r of results.filter((x) => x.text)) console.log(`\n--- ${r.name} ---\n${r.text}`);
}
const tail = skipped ? ` (${skipped} skipped — precondition absent here)` : "";
console.log(
  failed === 0
    ? `\nall ${results.length - skipped} checks pass${tail}`
    : `\n${failed} of ${results.length} failed${tail}`
);
process.exit(failed ? 1 : 0);
