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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable, PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { html } from "../src/ui.mjs";
import { LogPane, Confirm } from "../src/panels.mjs";
import { visibleRows } from "../src/toolspage.mjs";
import { Matrix, Legend, WhyDrawer, NotesDrawer, AnonDrawer, EmptyState, Ledger, ConfigStrip, CONFIG_FIXED, leakConfig, sample, pickArt } from "../src/disclosure.mjs";
import { fit, wrap, windowOf, indicatorFor } from "../src/layout.mjs";
import { C, DISCLOSURE } from "../src/theme.mjs";
import { BINDINGS, duplicateBindings, helpGroups, scopesFor, dispatch } from "../src/keymap.mjs";
import { App, TX_ACTIONS, RIG_IDS } from "../src/app.mjs";
import { PAGES, Bar, NavBar, StatusBar, QuitPrompt } from "../src/chrome.mjs";
import { About } from "../src/about.mjs";
import { comboBindings } from "../src/keymap.mjs";
import { whatDoesThisLeak } from "../../leak/src/leak.mjs";
import { AUDITOR_NOTE } from "../../cli/src/notes.mjs";
import { COMMANDS } from "../../cli/src/agentcmds.mjs";
import { status, agentStatus } from "../../core/src/services.mjs";
import { toBaseUnits } from "../../core/src/wallets.mjs";
import { SELECTOR_NUM_OF_CHANNELS } from "../../core/src/chain.mjs";
import { wallets } from "../../core/src/wallets.mjs";
import { latestBlocks } from "../../core/src/chain.mjs";
import { check } from "../../cli/src/doctor.mjs";
import { Form } from "../src/forms.mjs";
import { ActivityPage, ACTIVITY_FIELDS, detailPairs } from "../src/activity.mjs";
import { RUN_FIELDS, runFields } from "../src/runflow.mjs";
import { UNKNOWN as UNKNOWN_WORD } from "../../leak/src/facts.mjs";
import { advance, PASTE, TYPE, fieldValue } from "../src/forms.mjs";
import { whyNotRunnable, validate } from "../../core/src/flows.mjs";
import { mcpTools } from "../../core/src/services.mjs";
import { fullAddr } from "../src/wallets.mjs";
import { discoverOperations } from "../../core/src/toolchain.mjs";

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

await draw("LogPane", html`<${LogPane} lines=${[{ text: "$ scarb build", sev: "info" }, { text: "warning: unused", sev: "warn" }]} title="fix: pool" width=${96} height=${8} />`);
await draw("LogPane (empty)", html`<${LogPane} lines=${[]} title="" width=${96} height=${8} />`);
await draw("Confirm (doctor fix)", html`<${Confirm} c=${{ prompt: "run this?", cmd: "scarb build", cwd: "/tmp", lines: ["it keeps running"] }} width=${96} />`);
await draw("About", html`<${About} width=${96} height=${26} section=${0} />`);
await draw("About · keys", html`<${About} width=${96} height=${26} section=${3} />`);

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
  const base = { confirm: null, filter: null, quitting: false, navCursor: 0 };
  const states = [
    { ...base, page: "overview", report: null },
    { ...base, page: "disclosure", report: null },
    { ...base, page: "disclosure", report: {} },
    { ...base, page: "tools", report: {} },
    { ...base, page: "build", report: {} },
    { ...base, page: "activity", report: {} },
    { ...base, page: "wallets", report: {} },
    { ...base, page: "activity", report: {} },
    { ...base, page: "run", report: {} },
    { ...base, page: "log", report: {} },
    { ...base, page: "about", report: {} },
    { ...base, page: "overview", report: {}, confirm: {} },
    { ...base, page: "overview", report: {}, quitting: true },
    // The nav owns Enter only while the cursor is parked off the current page.
    { ...base, page: "overview", report: {}, navCursor: 3 },
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
  report: transferReport, page: "disclosure", navCursor: 3, quitting: false,
  confirm: null, filter: null, busy: null, up: false,
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
  if (fire(busy, "s")[0]?.[0] !== "cursor") throw new Error("s was swallowed while busy");
  if (fire(busy, "l")[0]?.[0] !== "goto") throw new Error("l was swallowed while busy");
  if (fire(busy, "d")[0]?.[0] !== "navMove") throw new Error("the nav was swallowed while busy");
  const gated = fire(busy, "u");
  if (gated[0]?.[0] !== "note") throw new Error("u ran a mutation while busy");
  if (!/working/.test(gated[0][1][0])) throw new Error("suppressed key said nothing");
  return "s, l and the nav stay live; u refused with a reason";
});

check_("q always asks, and the prompt is where the background choice lives", () => {
  // q never exits directly now. A stack this TUI started outlives the process
  // unless it is signalled, so "quit" is a question with two right answers.
  for (const st of [keyState({ busy: { label: "fixing" } }), keyState()]) {
    if (fire(st, "q")[0]?.[0] !== "askQuit") throw new Error("q did not open the prompt");
  }
  const quitting = keyState({ quitting: true });
  const want = { b: "quitLeaveRunning", s: "quitAndStop", q: "quitLeaveRunning" };
  for (const [k, fn] of Object.entries(want)) {
    if (fire(quitting, k)[0]?.[0] !== fn) throw new Error(`${k} did not call ${fn}`);
  }
  if (fire(quitting, "", { escape: true })[0]?.[0] !== "cancelQuit") throw new Error("esc did not stay");
  return "q → askQuit; b leaves it running, s stops it, esc stays";
});

check_("esc never quits, and resolves in one fixed order", () => {
  const calls = fire(keyState({ page: "tools" }), "", { escape: true });
  if (calls[0]?.[0] !== "escape") throw new Error("esc is not routed to the ordered handler");
  for (const st of [keyState(), keyState({ page: "log" }), keyState({ report: null })]) {
    if (fire(st, "", { escape: true }).some(([n]) => n === "exit")) throw new Error("esc quit");
  }
  return "esc → escape(), never exit()";
});

check_("while / is open every printable key is data, not a command", () => {
  const typing = keyState({ page: "tools", filter: { text: "art", typing: true } });
  const c = fire(typing, "q");
  if (c[0]?.[0] !== "setFilter" || c[0][1][0].text !== "artq") throw new Error("q was treated as quit");
  if (fire(typing, "", { escape: true })[0]?.[1][0] !== null) throw new Error("esc does not clear the filter");
  return "q types a q; esc clears";
});

check_("with / open, keys act on the filtered list, not the underlying one", () => {
  const f = { text: "upstream", typing: false };
  const shown = visibleRows(brokenDoc.rows, f);
  if (shown.length !== 1 || shown[0].name !== "upstream checkout") {
    throw new Error(`filter gave ${shown.map((r) => r.name).join(",")}`);
  }
  // Row 0 of the filtered list is row 2 of the real one. `i` reading the real
  // list here would offer to run a fix for a row that is not on screen.
  if (visibleRows(brokenDoc.rows, null)[0].name === shown[0].name) {
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

// The splash holds for MIN_SPLASH_MS and seals for SEAL_MS before any page
// exists. Every App assertion below is about a page, so the suite turns the hold
// off rather than paying two seconds per mount — the seal still runs, so the
// loading → ready transition is exercised, not branched around.
process.env.HYDRA_SPLASH_MS = "0";
process.env.HYDRA_SEAL_MS = "1";

async function mount(cols, rows) {
  const stdout = new Sink(cols, rows);
  const stdin = fakeStdin();
  const app = render(html`<${App} />`, { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 260));   // past the (disabled) splash
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
  await h.press("f");                    // Disclosure — the dashboard is the home page now
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
  // The overview pulls `doctor`, whose check() is five synchronous execFileSync
  // probes plus a git rev-parse. With the splash disabled that block lands on the
  // first frames rather than behind the loading screen, so let it finish first.
  await new Promise((r) => setTimeout(r, 700));
  const seen = {};
  for (const [key, name] of [["b", "wallets"], ["c", "activity"], ["t", "tools"],
                             ["x", "run"], ["l", "log"], ["g", "about"], ["o", "overview"]]) {
    await h.press(key);
    seen[name] = h.last();
  }
  // t → s (select a row) → i (ask to fix). The prompt must name the exact command.
  await h.press("t");
  await new Promise((r) => setTimeout(r, 400));   // check() is synchronous; give it a beat
  const tools = h.last();
  let confirmed = "";
  for (let i = 0; i < 12; i++) {
    await h.press("s");
    await h.press("i");
    const f = h.last();
    if (f.includes("run this? it executes a real command")) { confirmed = f; break; }
    await h.press("n");
  }
  h.app.unmount();

  check_("every nav destination is reachable by its own letter", () => {
    const want = {
      wallets: "manage", activity: "query", tools: "tools",
      run: "build a flow", log: "log ·", about: "What it is", overview: "the auditor",
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
for (const [cols, rows] of [[100, 30], [190, 57]]) {
  const h = await mount(cols, rows);
  // Same synchronous doctor probe as above: let it land before asserting a frame.
  await new Promise((r) => setTimeout(r, 700));
  await h.press("g");
  await h.press("\t");
  await h.press("\t");
  await h.press("\t");                 // What it is → Why → Getting started → Keys
  const frames = [h.last()];
  h.app.unmount();
  check_(`every binding is on the About page's Keys section at ${cols}x${rows}`, () => {
    // Assert the KEY column, not the label. Labels are truncated to fit the
    // column at narrow widths — that is the honest cost of not scrolling — but a
    // binding whose key is missing is genuinely undiscoverable.
    const seen = frames.join("\n");
    const missing = BINDINGS.filter((b) => !seen.includes(b.keys.join(" / ")));
    if (missing.length) {
      throw new Error(`${missing.length} of ${BINDINGS.length} never on screen: ${missing.slice(0, 3).map((b) => b.keys.join("/")).join(", ")}`);
    }
    return `${BINDINGS.length} bindings, no scrolling`;
  });
}

// ---------------------------------------------------------------------------
// parity — the matrix is a pane AND a command
// ---------------------------------------------------------------------------

check_("every rig pane has a `hydra <cmd> --json` twin", () => {
  const map = { wallets: "wallets", activity: "blocks", tools: "doctor" };
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
  //
  // The action comes from the COMMAND's own report rather than being retyped here.
  // It used to be a literal carrying `opensChannel: false`, so this check restated
  // the CLI's bug instead of comparing against it, and stayed green while the two
  // surfaces genuinely disagreed about the one field that decides whether a transfer
  // discloses its recipient.
  const declared = leakCmd.disclosures[0].action;
  const mineReport = whatDoesThisLeak({ config: mine, actions: [declared] });
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
// ---------------------------------------------------------------------------
// the redesign's own guarantees
// ---------------------------------------------------------------------------

// The transfer flow used to declare `opensChannel: false` — the reassuring branch —
// which asserted a fact the action alone cannot support. The pool exposes the channel
// count as a public view, so it is computable; when it cannot be read the field must
// stay absent, which packages/leak reports as UNKNOWN.
// The label said "100 STRK" and the wire carried 100 base units — 1e-16 STRK.
check_("every flow amount crosses the wire in the units its label claims", () => {
  for (const a of TX_ACTIONS) {
    if (!a.leak?.amount) continue;
    const src = String(a.run ?? "");
    const want = toBaseUnits(a.leak.amount);
    if (!src.includes("toBaseUnits")) {
      throw new Error(`${a.id} passes a raw amount; its label says ${a.leak.amount} whole tokens`);
    }
    if (!a.label.includes(String(a.leak.amount))) {
      throw new Error(`${a.id}'s label and its leak amount disagree`);
    }
    if (BigInt(want) !== BigInt(a.leak.amount) * 10n ** 18n) throw new Error("toBaseUnits is not 18dp");
  }
  return TX_ACTIONS.filter((a) => a.leak?.amount).map((a) => `${a.id} ${a.leak.amount}→${toBaseUnits(a.leak.amount)}`).join(" ");
});

// agentStatus() counted a hardcoded list of four THIRD-PARTY skill names, so a
// machine with all of HYDRA's own installed still reported 0/4.
check_("skill status counts HYDRA's own skills, not only the pinned bundle", () => {
  const sk = agentStatus().skills;
  if (!sk.own || !sk.thirdParty) throw new Error("no breakdown between the two skill sets");
  if (!sk.own.available.length) throw new Error("packages/skills was not read at all");
  for (const name of sk.own.available) {
    if (!sk.expected.includes(name)) throw new Error(`${name} is on disk but not expected`);
  }
  return `${sk.own.available.length} own · ${sk.thirdParty.pinned.length} pinned · ${sk.installed.length}/${sk.expected.length} installed`;
});

check_("the transfer flow never asserts opensChannel", () => {
  const transfer = TX_ACTIONS.find((a) => a.id === "transfer");
  if (!transfer) throw new Error("no transfer flow");
  if ("opensChannel" in transfer.leak) {
    throw new Error(`opensChannel is hardcoded to ${transfer.leak.opensChannel}`);
  }
  if (!transfer.recipient) throw new Error("no recipient, so it cannot be resolved from chain either");

  const cfg = { network: "sepolia", discovery: "indexer-self-hosted", proving: "mock" };
  const undeclared = whatDoesThisLeak({ config: cfg, actions: [transfer.leak] });
  const asserted = whatDoesThisLeak({ config: cfg, actions: [{ ...transfer.leak, opensChannel: false }] });
  if (undeclared.unknownCount <= asserted.unknownCount) {
    throw new Error("declaring opensChannel:false does not reduce UNKNOWN — this check proves nothing");
  }
  return `undeclared → ${undeclared.unknownCount} UNKNOWN, asserted false → ${asserted.unknownCount}`;
});

check_("the pool's channel-count selector is the one the chain answers to", () => {
  // Pinned because it is hardcoded: computing a starknet selector needs keccak and
  // packages/core has no dependencies. Derived with starknet.js getSelectorFromName,
  // which reproduces the balanceOf selector already in wallets.mjs.
  const want = "0x3dd96f9f4c6d6e8a31f13b4f6bddb32618aaea7439310de036bc5c244a43c3d";
  if (SELECTOR_NUM_OF_CHANNELS !== want) throw new Error(`selector drifted: ${SELECTOR_NUM_OF_CHANNELS}`);
  return "get_num_of_channels";
});

// The four sectioned pages, and the facts they are built around.
check_("snforge output parses, including the traps that made exit codes unusable", async () => {
  const { parseSnforge, verdictOf } = await import("../../core/src/toolchain.mjs");
  const multi = [
    "Collected 341 test(s) from privacy package",
    "[PASS] privacy::a (l1_gas: ~181032, l1_data_gas: ~5952, l2_gas: ~43388660)",
    "Tests: 338 passed, 0 failed, 3 ignored, 0 filtered out",
    "Collected 43 test(s) from shadow package",
    "Tests: 43 passed, 0 failed, 0 ignored, 0 filtered out",
    "Tests summary: 391 passed, 0 failed, 3 ignored, 0 filtered out",
  ].join("\n");
  const m = parseSnforge(multi);
  // The trap: a multi-package run prints one `Tests:` per package AND a final
  // summary. Reading only `Tests:` reports the LAST package as the whole run.
  if (m.totals.passed !== 391) throw new Error(`multi-package total is ${m.totals.passed}, not 391`);
  if (m.packages.length !== 2) throw new Error("packages were not separated");
  const gas = m.tests[0]?.gas;
  if (!gas || gas.l2 !== 43388660) throw new Error("gas was not parsed");

  // snforge exits 0 when a filter matches nothing, so the code alone cannot tell
  // "all passed" from "nothing ran".
  const none = parseSnforge("Tests: 0 passed, 0 failed, 0 ignored, 4 filtered out");
  const v = verdictOf(none, 0);
  if (v.ok) throw new Error("a run that verified nothing reported ok");
  if (!/4 filtered/.test(v.text)) throw new Error("the reason was not carried");
  return `391 across 2 packages · exit 0 with 0 run → "${v.text}"`;
});

check_("a saved flow stores data, never anything executable", async () => {
  const { validate, RUNNABLE } = await import("../../core/src/flows.mjs");
  const bad = validate({ name: "x", type: "nope" });
  if (bad.ok) throw new Error("an unknown action type was accepted");
  const w = validate({ name: "w", type: "withdraw", amount: "5" });
  // withdraw and invoke are real ACTION_TYPES the leak module models, and the
  // control API has no endpoint for either. That is recorded, not hidden.
  if (!w.ok) throw new Error("withdraw was rejected; it is a real action type");
  if (w.flow.runnable) throw new Error("withdraw was marked runnable, and it is not");
  const t = validate({ name: "t", type: "transfer", from: "alice", to: "bob", amount: "50" });
  if (!t.flow.runnable) throw new Error("transfer was marked unrunnable");
  for (const v of Object.values(t.flow)) {
    if (typeof v === "function") throw new Error("a flow carried a function");
  }
  if (validate({ name: "n", type: "transfer", amount: "1; rm -rf /" }).ok) {
    throw new Error("a non-numeric amount was accepted");
  }
  return `${RUNNABLE.length} runnable of 5 types · withdraw preview-only`;
});

check_("history survives a truncated final line", async () => {
  const { history } = await import("../../core/src/history.mjs");
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  const prev = process.env.HYDRA_HOME;
  process.env.HYDRA_HOME = dir;
  // Written by hand rather than through record(), because the case being tested is
  // a process killed mid-append — which record() cannot produce on demand.
  writeFileSync(join(dir, "history.jsonl"),
    '{"at":"2026-01-01T00:00:00Z","kind":"build","name":"a","ok":true,"ms":1}\n' +
    '{"at":"2026-01-01T00:00:01Z","kind":"flow","name":"b","ok":false,"ms":2}\n' +
    '{"at":"2026-01-01T00:00:02Z","kind":"bui');
  const h = await history({});
  process.env.HYDRA_HOME = prev;
  if (h.entries.length !== 2) throw new Error(`${h.entries.length} entries; the truncated line was not dropped`);
  if (h.entries[0].name !== "b") throw new Error("entries are not newest-first");
  return "2 whole lines kept, the torn one dropped";
});

check_("no binding needs a modifier key", () => {
  const combos = comboBindings();
  if (combos.length) throw new Error(`needs Shift: ${combos.join(", ")}`);
  return `${BINDINGS.length} bindings, all single unshifted keys`;
});

check_("w a s d are movement only — never a destination", () => {
  const MOVE = new Set(["w", "a", "s", "d"]);
  const clash = PAGES.filter((p) => MOVE.has(p.key));
  if (clash.length) throw new Error(`page letters collide with movement: ${clash.map((p) => p.key).join(", ")}`);
  const letters = PAGES.map((p) => p.key);
  if (new Set(letters).size !== letters.length) throw new Error("two pages share a letter");
  return `${PAGES.length} pages: ${letters.join(" ")}`;
});

await (async () => {
  const frame = async (node, cols = 120, rows = 6) => {
    const stdout = new Sink(cols, rows);
    const app = render(node, { stdout, debug: true, patchConsole: false });
    await new Promise((r) => setTimeout(r, 120));
    const raw = stdout.frames.at(-1) ?? "";
    app.unmount();
    return raw;
  };

  // Asserted on the element tree, not on ANSI: Ink's colour is chalk's, and chalk
  // turns itself off when the stream is not a tty — which every frame in this
  // file is. A rendered-output check here passes for the wrong reason.
  const walk = (node, out = []) => {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
    if (node.props) {
      out.push(node.props);
      walk(node.props.children, out);
    }
    return out;
  };
  // `Bar`, not `NavBar`: NavBar is a one-line wrapper around it, and walking the
  // wrapper's tree finds the <Bar> element rather than the cells it renders.
  const navTree = walk(Bar({ width: 118, items: PAGES, active: "wallets", cursor: 3 }));
  const navText = strip(await frame(html`<${NavBar} width=${118} active="wallets" cursor=${3} />`));

  check_("the nav paints the current page and brackets the cursor", () => {
    const painted = navTree.filter((p) => p.backgroundColor);
    if (painted.length !== 1) throw new Error(`${painted.length} cells carry a background, expected exactly 1`);
    if (!String(painted[0].children ?? "").includes("Wallets")) {
      throw new Error(`the painted cell is "${painted[0].children}", not the active page`);
    }
    if (!navText.includes("[Disclosure (f)]")) throw new Error("the cursor is not bracketed");
    for (const p of PAGES) {
      if (!navText.includes(`(${p.key})`)) throw new Error(`${p.label} does not show its key`);
    }
    return "active filled, cursor bracketed, every key shown";
  });

  const quit = strip(await frame(html`<${QuitPrompt} width=${118} running=${true} managed=${true} />`, 120, 8));
  check_("the quit prompt offers background as a first-class choice", () => {
    for (const needle of ["leave them running", "stop the stack", "stay"]) {
      if (!quit.includes(needle)) throw new Error(`"${needle}" not offered`);
    }
    return "b leaves it running · s stops it · esc stays";
  });
})();

// The splash. Asserted on the pure colour decision and the ring geometry rather
// than on rendered output: the component uses hooks, and Ink's colour is chalk's,
// which turns itself off when the stream is not a tty.
{
  const { colourAt } = await import("../src/splash.mjs");
  const { scaled, rings } = await import("../src/logo.mjs");

  check_("the mark fills cyan from the centre out, then seals red from the rim in", () => {
    // Loading: inside the fill radius is lit, outside is not.
    if (colourAt(0.1, 0.5, null) !== "cyan") throw new Error("the centre is not lit at 50%");
    if (colourAt(0.9, 0.5, null) !== "white") throw new Error("the rim is lit at 50% — the fill is not radial");
    if (colourAt(0.9, 1, null) !== "cyan") throw new Error("the rim never lights at 100%");
    // Sealing: the rim turns first, and the threshold walks inward to 0.
    if (colourAt(0.9, 1, 0.8) !== "red") throw new Error("the rim does not seal");
    if (colourAt(0.1, 1, 0.8) !== "cyan") throw new Error("the centre sealed before the rim");
    if (colourAt(0.1, 1, 0) !== "red") throw new Error("the seal never reaches the centre");
    return "centre → rim in cyan, rim → centre in red";
  });

  check_("the mark scales to the terminal and keeps its aspect", () => {
    const art = scaled(100, 26);
    if (art.length > 26) throw new Error(`${art.length} rows for a 26-row budget`);
    if (Math.max(...art.map((l) => l.length)) > 100) throw new Error("wider than the budget");
    const { cells } = rings(art);
    if (cells.length < 200) throw new Error(`only ${cells.length} glyphs — the mark did not survive scaling`);
    const rs = cells.map((c) => c.r);
    if (Math.min(...rs) > 0.2) throw new Error("no cell near the centre");
    if (Math.max(...rs) < 0.6) throw new Error("no cell near the rim — the radius is not normalised");
    return `${art.length} rows, ${cells.length} glyphs, r ${Math.min(...rs).toFixed(2)}–${Math.max(...rs).toFixed(2)}`;
  });
}

// The status bar belongs on every page but the overview, which shows the same
// facts in full and would otherwise say everything twice.
{
  const h = await mount(120, 32);
  await new Promise((r) => setTimeout(r, 700));
  const seen = {};
  for (const [key, id] of [["o", "overview"], ["b", "wallets"], ["t", "tools"], ["g", "about"]]) {
    await h.press(key);
    seen[id] = h.last();
  }
  h.app.unmount();
  check_("the status bar is the first row and the nav the second, except on the overview", () => {
    const line = (f, i) => f.split("\n")[i] ?? "";
    const isNav = (l) => /Overview \(o\)/.test(l);
    const isBar = (l) => /devnet .*·.*indexer .*·.*prover/.test(l);
    for (const id of ["wallets", "tools", "about"]) {
      if (!isBar(line(seen[id], 0))) throw new Error(`${id} does not open with the status bar`);
      if (!isNav(line(seen[id], 1))) throw new Error(`${id} has no nav under the status bar`);
    }
    // The overview shows the same facts in full, so it carries no status bar and
    // the nav is its first row.
    if (isBar(line(seen.overview, 0)) || isBar(line(seen.overview, 1))) {
      throw new Error("the overview repeats the status bar");
    }
    if (!isNav(line(seen.overview, 0))) throw new Error("the overview does not open with the nav");
    if (!seen.overview.includes("the auditor")) throw new Error("the overview lost the auditor strip");
    return "status first, nav second; the overview has the nav first and no status bar";
  });
  check_("the overview dashboard shows every block the brief asks for", () => {
    for (const needle of ["stack", "chain", "tooling", "wallets", "the auditor"]) {
      if (!seen.overview.includes(needle)) throw new Error(`no "${needle}" block`);
    }
    return "stack · chain · tooling · wallets · activity · auditor";
  });
}

// Full-bleed, at the sizes a person actually uses. The old layout capped the
// matrix near 98 columns, so a 190-column terminal was two thirds empty.
{
  const seen = [];
  for (const [cols, rows] of [[120, 32], [190, 57], [100, 30]]) {
    const h = await mount(cols, rows);
    await new Promise((r) => setTimeout(r, 700));
    await h.press("f");
    await h.press("e");
    const f = h.last().replace(/\n$/, "").split("\n");
    h.app.unmount();
    seen.push({ cols, rows, w: Math.max(...f.map((l) => l.length)), r: f.length });
  }
  check_("every screen fills the terminal it is given", () => {
    for (const x of seen) {
      if (x.w < x.cols - 2) throw new Error(`${x.cols}x${x.rows}: drew only ${x.w} of ${x.cols} columns`);
      if (x.r < x.rows - 2) throw new Error(`${x.cols}x${x.rows}: drew only ${x.r} of ${x.rows} rows`);
      if (x.w > x.cols || x.r >= x.rows) throw new Error(`${x.cols}x${x.rows}: overflowed at ${x.w}x${x.r}`);
    }
    return seen.map((x) => `${x.cols}x${x.rows}→${x.w}c/${x.r}r`).join(" ");
  });
}

// ---------------------------------------------------------------------------
// The redesign's four load-bearing behaviours, each one a defect that shipped.
// ---------------------------------------------------------------------------

check_("a text field shows what you type into it, not the value it had", () => {
  // The bug: the cell rendered `values[f.id]` while the keystrokes accumulated in a
  // prompt nobody drew, so every character was recorded and none appeared. There is
  // no way to tell that apart from a field that does not work.
  const values = { name: "", type: "transfer", from: "alice", to: "bob", token: "STRK", amount: "50" };
  const rows = Form({
    fields: RUN_FIELDS, values, selected: 0, focused: true, width: 100,
    prompt: { field: "name", label: "name:", value: "nightly" },
  });
  const text = (n) => JSON.stringify(n).replace(/\\+/g, "");
  if (!text(rows[0]).includes("nightly")) throw new Error("the typed text is not in the field");
  // And only in that field: a prompt opened elsewhere must not leak into the form.
  const other = Form({
    fields: RUN_FIELDS, values, selected: 0, focused: true, width: 100,
    prompt: { field: "token to track", label: "token", value: "0xdead" },
  });
  if (text(other[0]).includes("0xdead")) throw new Error("a foreign prompt bled into the form");
  return "typed text lands in its own field and nowhere else";
});

check_("the transaction grid reports only what the node returned", () => {
  const row = { block: 12, hash: "0xabc", ts: 1_700_000_000, count: 1 };
  const receipt = {
    available: true, found: true, hash: "0xabc", finality: "ACCEPTED_ON_L2",
    execution: "SUCCEEDED", blockNumber: 12, actualFee: { amount: "0x2540be400", unit: "FRI" },
    events: 2, sender: "0xf00", nonce: "0x3", type: "INVOKE", version: "0x3",
    calldata: 9, gas: { l1: 0, l1Data: 224, l2: 1310720 }, revertReason: null,
  };
  const pairs = detailPairs(row, receipt, 20);
  const by = Object.fromEntries(pairs.map(([k, v]) => [k, String(v)]));
  if (by.from !== "0xf00") throw new Error("the sender is not the one on the transaction");
  if (by.confirmations !== "8 blocks") throw new Error(`confirmations read "${by.confirmations}"`);
  // The two that must never read as decoded. `events` is a length and `calls` is a
  // felt count; a grid that printed them bare would look like a block explorer that
  // had decoded them.
  if (!by.events.includes("count only")) throw new Error("events not marked as a count");
  if (!by.calls.includes("not decoded")) throw new Error("calldata not marked as undecoded");
  // No value and no `to`, because an invoke has neither without decoding calldata.
  for (const absent of ["value", "to"]) {
    if (absent in by) throw new Error(`"${absent}" is on the grid and cannot be known`);
  }
  if (detailPairs(row, null, 20).some(([, v]) => String(v).includes("reading")) === false) {
    throw new Error("no loading state while the receipt is in flight");
  }
  return `${pairs.length} pairs · from 0xf00 · events and calls both marked`;
});

await draw("Activity @120x32", html`
  <${ActivityPage} width=${118} height=${28}
    data=${{ available: true, head: 20, blocks: [{ number: 20, txs: ["0xabc"], txCount: 1, timestamp: 1_700_000_000 }] }}
    values=${{ depth: "8", hash: "", match: "", txonly: false }}
    focus="list" selected=${0} formSel=${0} prompt=${null}
    receipt=${{ available: true, found: true, hash: "0xabc", finality: "ACCEPTED_ON_L2",
      execution: "SUCCEEDED", blockNumber: 20, actualFee: { amount: "0x1", unit: "FRI" },
      events: 2, sender: "0xf00", nonce: "0x1", type: "INVOKE", version: "0x3",
      calldata: 4, gas: null, revertReason: null }} />`, 120, 32);

check_("Activity reads detail, then query, then history — in that order", () => {
  const text = results.find((r) => r.name === "Activity @120x32")?.text ?? "";
  const at = (needle) => text.indexOf(needle);
  const [detail, query, list] = [at(" transaction "), at(" query "), at(" transactions ")];
  if (detail < 0 || query < 0 || list < 0) throw new Error("a section is missing");
  if (!(detail < query && query < list)) throw new Error("the sections are out of order");
  if (!text.includes("0xf00")) throw new Error("the grid does not show the sender");
  return "transaction · query · transactions";
});

check_("the build operations are read from the checkout, not typed in", () => {
  const root = mkdtempSync(join(tmpdir(), "hydra-ws-"));
  const write = (rel, body) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write("Scarb.toml", '[workspace]\nmembers = [\n  "packages/alpha",\n  "packages/beta",\n]\n\n[workspace.dependencies]\nstarknet = "2.17.0"\n');
  write("packages/alpha/Scarb.toml", '[package]\nname = "alpha"\n');
  write("packages/beta/Scarb.toml", '[package]\nname = "beta"\n');
  // Pins a different Cairo than the workspace, which is what makes the flag needed.
  write("e2e/contracts/odd/Scarb.toml", '[package]\nname = "odd_contracts"\n\n[dependencies]\nstarknet = "2.11.4"\n');
  write("e2e/contracts/same/Scarb.toml", '[package]\nname = "same_contracts"\n\n[dependencies]\nstarknet = "2.17.0"\n');
  write("Cargo.toml", '[workspace]\nmembers = [\n  "crates/lib-only",\n  "crates/has-bin",\n]\n');
  write("crates/lib-only/Cargo.toml", '[package]\nname = "lib-only"\n');
  write("crates/lib-only/src/lib.rs", "");
  write("crates/has-bin/Cargo.toml", '[package]\nname = "has-bin"\n');
  write("crates/has-bin/src/main.rs", "");

  const ops = discoverOperations(root);
  const id = (x) => ops.find((o) => o.id === x);
  for (const want of ["build:alpha", "build:beta", "test:alpha", "test:beta",
    "build:e2e:odd_contracts", "build:cargo:has-bin", "build:workspace", "test:all"]) {
    if (!id(want)) throw new Error(`${want} was not discovered`);
  }
  // A library crate has nothing to run, so a build button for it would do nothing
  // anyone asked for.
  if (id("build:cargo:lib-only")) throw new Error("a crate with no main.rs got a build op");
  // The flag is derived from the version mismatch itself, not remembered per package.
  if (!id("build:e2e:odd_contracts").cmd.includes("--ignore-cairo-version")) {
    throw new Error("the Cairo-version mismatch did not produce the flag");
  }
  if (id("build:e2e:same_contracts").cmd.includes("--ignore-cairo-version")) {
    throw new Error("a matching Cairo version got the flag anyway");
  }
  // Never timed here, so there is no estimate rather than an invented one.
  if (id("build:alpha").seconds !== null) throw new Error("an unmeasured package got a duration");
  if (id("build:e2e:odd_contracts").dir !== "e2e/contracts/odd") throw new Error("wrong cwd for an e2e package");
  return `${ops.length} ops from 2 members, 2 e2e packages and 1 binary crate`;
});

check_("addresses are printed in full, padded the way an explorer prints them", () => {
  const full = fullAddr("0x34ba56f92265f0868c57d3fe72ecab144fc96f97954bbbc4252cef8e8a979ba");
  if (full.length !== 66) throw new Error(`${full.length} characters, expected 66`);
  if (!full.startsWith("0x0")) throw new Error("not left-padded to 64 hex digits");
  if (fullAddr(null) !== "—") throw new Error("a missing address is not an address");
  return full.slice(0, 12) + "… (66 chars)";
});

{
  // The one button for adding an account restarted the stack with the count it
  // already had, so it discarded the chain and changed nothing.
  const h = await mount(120, 32);
  await new Promise((r) => setTimeout(r, 400));
  await h.press("b");
  await h.press("+");
  const frame = h.last();
  h.app.unmount();
  check_("`+` restarts with one MORE account than the stack has", () => {
    const m = /restart the stack with (\d+) user accounts \(it has (\d+)\)/.exec(frame);
    if (!m) throw new Error("no restart prompt");
    if (Number(m[1]) !== Number(m[2]) + 1) throw new Error(`${m[2]} → ${m[1]} is not one more`);
    if (!frame.includes("alice or bob only")) throw new Error("does not say the new account cannot run flows");
    return `${m[2]} → ${m[1]} accounts`;
  });
}

check_("no declared action shape asserts a chain fact it cannot read", () => {
  // `hydra leak transfer` used to ship `opensChannel: false` — the reassuring branch —
  // so the agent-facing surface answered NOT_DISCLOSED_BY_THIS_TX with the reason "the
  // caller states the channel already exists", about a caller who had stated nothing.
  // On a fresh stack that is wrong: get_num_of_channels(bob) is 0 before the first
  // transfer, so it DOES open a channel and DOES write bob's plaintext address.
  const src = readFileSync(new URL("../../cli/src/agentcmds.mjs", import.meta.url), "utf8");
  const table = src.slice(src.indexOf("const LEAK_ACTIONS"), src.indexOf("export const COMMANDS"));
  if (/opensChannel\s*:/.test(table)) throw new Error("a declared action shape asserts opensChannel");

  // And the consequence, measured rather than asserted: the omission has to reach the
  // report as UNKNOWN, not be defaulted somewhere downstream.
  const conf = leakConfig({ prover: { mode: "mock" } });
  const asserted = whatDoesThisLeak({ config: conf,
    actions: [{ type: "transfer", token: "STRK", amount: "50", counterparty: "bob", opensChannel: false }] });
  const honest = whatDoesThisLeak({ config: conf,
    actions: [{ type: "transfer", token: "STRK", amount: "50", counterparty: "bob" }] });
  const cells = (r) => r.parties.filter(([id]) =>
    r.fields.some((f) => r.disclosures[0].byParty[id][f].disclosure === UNKNOWN_WORD)).length;
  if (honest.unknownCount <= asserted.unknownCount) {
    throw new Error(`omitting it did not cost an answer: ${honest.unknownCount} vs ${asserted.unknownCount}`);
  }
  if (honest.disclosures[0].byParty.public.counterparty.disclosure !== UNKNOWN_WORD) {
    throw new Error("an undeclared channel state is not reported as UNKNOWN");
  }
  return `undeclared → ${honest.unknownCount} unknowns · asserted false → ${asserted.unknownCount}`;
});

check_("from and to are pickers over the stack's own accounts", () => {
  const accounts = [
    { name: "alice", flows: true }, { name: "bob", flows: true },
    { name: "admin", flows: false }, { name: "user3", flows: false },
  ];
  const f = Object.fromEntries(runFields(accounts).map((x) => [x.id, x]));
  if (f.from.kind !== "enum" || f.to.kind !== "enum") throw new Error("still free text");
  // `from` has to sign. control.mjs:41 wraps alice and bob only, and `up.mjs` records
  // which those are, so offering admin as a sender would be offering a call that 500s.
  if (f.from.options.join() !== ["alice", "bob", PASTE].join()) {
    throw new Error(`from offers ${f.from.options.join(", ")}`);
  }
  // `to` is anyone — a recipient does not sign.
  if (f.to.options.join() !== ["alice", "bob", "admin", "user3", PASTE].join()) {
    throw new Error(`to offers ${f.to.options.join(", ")}`);
  }
  // Cycling onto PASTE is a request for a value, not a value.
  if (advance(f.to, { to: "user3" }) !== TYPE) throw new Error("PASTE was stored as a value");
  if (advance(f.to, { to: "alice" }) !== "bob") throw new Error("the cycle does not advance");
  // A pasted address is not in the options, so the cycle resumes at the first name
  // rather than getting stuck.
  if (advance(f.to, { to: "0xdead" }) !== "alice") throw new Error("a pasted address traps the cycle");
  // And it is shortened for the column rather than truncated, so the tail survives.
  const shown = fieldValue(f.to, { to: "0x" + "ab".repeat(32) });
  if (!shown.startsWith("0xababab") || !shown.endsWith("ababab")) throw new Error(`shown as ${shown}`);
  // No stack, no options but the escape hatch — and the hint says why.
  const empty = Object.fromEntries(runFields([]).map((x) => [x.id, x]));
  if (empty.from.options.join() !== PASTE) throw new Error("invented an account with no stack");
  if (!/no stack/.test(empty.from.hint)) throw new Error("does not say why the picker is empty");
  return "from = signers + paste · to = every account + paste";
});

check_("a flow says which of two different reasons stops it running", () => {
  const flow = (o) => validate({ name: "f", type: "transfer", token: "STRK", ...o }).flow;
  if (flow({ from: "alice", to: "bob" }).runnable !== true) throw new Error("a plain transfer is not runnable");
  // Two failures, and they are not the same failure. One is a gap in this stack's
  // API; the other is a party nobody here holds a key for, which no API can fix.
  const pastedTo = flow({ from: "alice", to: "0xdead" });
  if (pastedTo.runnable || !/control API takes account names/.test(pastedTo.reason)) {
    throw new Error(`to-address: ${pastedTo.reason}`);
  }
  const pastedFrom = flow({ from: "0xdead", to: "bob" });
  if (pastedFrom.runnable || !/holds no key/.test(pastedFrom.reason)) {
    throw new Error(`from-address: ${pastedFrom.reason}`);
  }
  if (!/no control endpoint/.test(whyNotRunnable({ type: "withdraw", from: "alice", to: "bob" }))) {
    throw new Error("withdraw no longer reports its missing endpoint");
  }
  // A pasted address is 66 characters. The old 40-character clamp stored a prefix,
  // which is a different address and would have been queried as one.
  const long = "0x" + "c".repeat(64);
  if (flow({ from: "alice", to: long }).to !== long) throw new Error("the stored address was truncated");
  return "endpoint gap · unsignable from · unnamed to — three distinct reasons";
});

{
  const tools = await mcpTools();
  check_("the MCP tool surface is readable without starting the server", () => {
    // packages/mcp is gitignored, so a clone can genuinely lack it. That is a skip,
    // not a failure — but where it IS present the names have to be data.
    if (!tools) return { skip: "packages/mcp/src/manifest.mjs is not present here" };
    if (tools.length !== 9) throw new Error(`${tools.length} tools, expected 9`);
    const effects = tools.filter((t) => t.effects);
    if (effects.length !== 3) throw new Error(`${effects.length} side-effecting, expected 3`);
    for (const t of effects) {
      if (!t.confirm) throw new Error(`${t.name} changes something and names no confirmation`);
    }
    for (const t of tools) {
      if (!t.name || !t.title || !t.group || !t.wraps) throw new Error(`${t.name}: incomplete entry`);
    }
    return `${tools.length} tools · ${effects.length} side-effecting · read from the manifest`;
  });
}

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
