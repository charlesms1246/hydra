/**
 * The hydra TUI.
 *
 * The disclosure matrix is the home screen; the stack lives behind s/w/a/t. That
 * is the one structural decision here, and it follows from README:49 — "the
 * Transact pane is the point of the project" — which five equal tabs contradicted.
 *
 * Everything polled lives in sources.mjs, everything pure in layout / theme /
 * disclosure / panels, and every key in keymap.mjs. This file composes and
 * dispatches, and holds the seven pieces of state that are genuinely its own.
 *
 * Deleted outright: the leak→summary transform that used to live here. It was
 * not a lossy rendering of the report, it was a wrong one — see the header
 * comment in disclosure.mjs for the specific case it got backwards. The ledger
 * now holds whatDoesThisLeak's return value unmodified.
 */

import { render, Box, Text, useApp, useInput } from "ink";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { html, React } from "./ui.mjs";
import { C, glyph, mark, tone } from "./theme.mjs";
import { fit, useSize, MIN_COLS, MIN_ROWS } from "./layout.mjs";
import { BINDINGS, dispatch } from "./keymap.mjs";
import { PAGES, pageIndex, NavBar, StatusBar, QuitPrompt } from "./chrome.mjs";
import { About, SECTION_COUNT } from "./about.mjs";
import { WalletsPage } from "./wallets.mjs";
import { ActivityPage, ACTIVITY_FIELDS, rowsFor as activityRows } from "./activity.mjs";
import { RunPage, runFields } from "./runflow.mjs";
import { ToolsPage, TOOL_CATEGORIES, visibleRows } from "./toolspage.mjs";
import { BuildPage } from "./buildpage.mjs";
import { advance, isAddress, TYPE } from "./forms.mjs";
import { saveFlow as persistFlow, forgetFlow as dropFlow, leakActionFor } from "../../core/src/flows.mjs";
import { discoverOperations, runOperation, deployState } from "../../core/src/toolchain.mjs";
import { record } from "../../core/src/history.mjs";
import { upstreamPath } from "../../cli/src/doctor.mjs";
import { ARTIFACTS } from "../../cli/src/pins.mjs";
import { Overview } from "./overview.mjs";
import { Splash, timings } from "./splash.mjs";
import { measureCellAspect } from "./logo.mjs";
import { useSources } from "./sources.mjs";
import { LogPane, Confirm } from "./panels.mjs";
import {
  leakConfig, ConfigStrip, Ledger, Matrix, Legend, WhyDrawer, NotesDrawer, AnonDrawer, EmptyState,
} from "./disclosure.mjs";
import { faucet, addToken, exportWallets, toBaseUnits } from "../../core/src/wallets.mjs";
import { txStatus, opensChannelTo } from "../../core/src/chain.mjs";
import { startStack, stopStack } from "../../core/src/stack.mjs";
import { describeFix, runFix } from "../../core/src/install.mjs";
import { status } from "../../core/src/services.mjs";
import * as TX from "../../core/src/transact.mjs";
import { whatDoesThisLeak } from "../../leak/src/leak.mjs";
import { AUDITOR_NOTE } from "../../cli/src/notes.mjs";

const { useState, useEffect, useCallback, useRef, useMemo } = React;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const EXAMPLE = join(REPO, "packages", "leak", "examples", "private-transfer.json");

/**
 * The flows a developer wants first. Each carries the leak-report action it
 * corresponds to, so the disclosure shown afterwards describes what actually ran
 * rather than a generic example.
 */
export const TX_ACTIONS = [
  // Amounts are whole tokens on the label and base units on the wire. They used to
  // be the same string, so "100 STRK" deposited 100 base units — 1e-16 STRK.
  { id: "shield", label: "shield    100 STRK  alice",
    run: () => TX.shield({ who: "alice", amount: toBaseUnits("100"), token: "STRK" }),
    leak: { type: "deposit", token: "STRK", amount: "100" } },
  { id: "register", label: "register  bob",
    run: () => TX.register("bob"), leak: { type: "register" } },
  { id: "transfer", label: "transfer  50 STRK  alice → bob",
    run: () => TX.transfer({ from: "alice", to: "bob", amount: toBaseUnits("50"), token: "STRK" }),
    // `opensChannel` is deliberately absent. It used to be hardcoded `false` — the
    // reassuring branch — which asserted a fact this program cannot know from the
    // action alone, and turned 5 UNKNOWN cells into 1. It is resolved from chain
    // by `resolveLeak` below, and stays undefined (so: UNKNOWN) when that fails.
    recipient: "bob",
    leak: { type: "transfer", token: "STRK", amount: "50", counterparty: "bob" } },
  // `notesOnly`, not `run: null`. A saved flow can also have no `run` — when it is a
  // type with no endpoint, or names a party this stack holds no key for — and those
  // two must not take the same branch as this one.
  { id: "notes", label: "notes     re-discover for alice and bob", run: null, notesOnly: true,
    note: "the only discoverNotes() call there is" },
];

/**
 * Submit a saved flow. The three runnable types map onto the three control
 * endpoints; anything else never reaches here, because `flows.mjs whyNotRunnable`
 * has already marked it preview-only and `run` is null.
 */
function submitFlow(f) {
  const amount = toBaseUnits(f.amount ?? "0");
  if (f.type === "register") return TX.register(f.from ?? "bob");
  if (f.type === "deposit") return TX.shield({ who: f.from ?? "alice", amount, token: f.token });
  return TX.transfer({ from: f.from, to: f.to, amount, token: f.token });
}

/** A saved flow in the shape the confirm/run/report path already speaks. */
function flowAsAction(f) {
  return {
    id: f.id,
    label: `${f.name}  ·  ${f.type}${f.amount ? ` ${f.amount} ${f.token}` : ""}`,
    recipient: f.to,
    leak: leakActionFor(f),
    reason: f.reason,
    run: f.runnable ? () => submitFlow(f) : null,
  };
}

const LOG_MAX = 200;
const DRAWERS = ["why", "notes", "anon"];
const RIG_IDS = ["wallets", "activity", "tools"];
const clock = () => new Date().toTimeString().slice(0, 8);

/**
 * The report's title is a permanent admission, not decoration. doTx computes from
 * TX_ACTIONS[i].leak — a hand-written literal — and txStatus() returns an event
 * COUNT (chain.mjs:42), not decoded events, so nothing here can check the report
 * against the transaction that was actually sent. Say so, at every width.
 */
const SHAPE_CAVEAT = "declared action shape, not the receipt";

function App() {
  const { exit } = useApp();
  const { cols, rows, tooSmall } = useSize();
  const geom = fit(Math.max(MIN_COLS, cols), Math.max(MIN_ROWS, rows));

  const [ledger, setLedger] = useState([]);
  const [cursor, setCursorState] = useState({
    run: 0, action: 0, party: 0, field: 0, drawer: "why", expanded: false, scroll: 0,
  });
  const [page, setPage] = useState("overview");
  const [navCursor, setNavCursor] = useState(0);
  // Splash phases: the mark fills cyan while the real sources report in, seals
  // red once they all have, then hands over. `ready` is the steady state.
  const [phase, setPhase] = useState("loading");
  const [sealT, setSealT] = useState(0);
  const [quitting, setQuitting] = useState(false);
  const [section, setSection] = useState(0);
  const [prompt, setPromptState] = useState(null);
  // Which of a sectioned page's two halves has the cursor. One value, reset on page
  // change, because no page has more than two sections.
  const [focus, setFocus] = useState("list");
  const [formSel, setFormSel] = useState(0);
  const [forms, setForms] = useState({
    activity: { depth: "8", hash: "", match: "", txonly: false },
    run: { name: "", type: "transfer", from: "alice", to: "bob", token: "STRK", amount: "50" },
  });
  const [catSel, setCatSel] = useState(0);
  const [buildSel, setBuildSel] = useState(0);
  const [buildResults, setBuildResults] = useState({});
  const [buildResult, setBuildResult] = useState(null);
  const [buildLines, setBuildLines] = useState([]);
  const [, setTick] = useState(0);
  const bornAt = useRef(Date.now());
  const [navs, setNavs] = useState({});
  const [runSel, setRunSel] = useState(0);
  const [logSel, setLogSel] = useState(0);
  const [filter, setFilter] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [msg, setMsg] = useState({ text: "nothing has been run yet", sev: "info", at: clock() });
  const [log, setLog] = useState([]);
  const [logTitle, setLogTitle] = useState("");
  // Set independently of the ledger. The old code did setTx({available:false})
  // on a failed probe, which destroyed `last` and `leak` — a disclosure report
  // vanished because devnet blinked. A report is evidence; a probe is weather.
  const [txAvailable, setTxAvailable] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const stackRef = useRef(null);
  // bringUp's readiness poller. Held in a ref because it outlives the callback:
  // `q` stays live during startup (keymap.mjs:156), so unmount can happen while
  // the poller is still ticking, and an uncleared 1.5s interval kept the process
  // alive for the poller's whole 120-second deadline after Ink had exited.
  const pollRef = useRef(null);

  const { data, staleness, refresh } = useSources(page);

  // Read once from the checkout's manifests. Not on a timer: a workspace member
  // does not appear while the TUI is open, and readdirSync on every frame would
  // put three synchronous stats in the render path.
  const ops = useMemo(() => discoverOperations(upstreamPath()), []);

  // Entering a page puts the cursor where the work is: the list on pages that show
  // one, the categories on Tools. Without this, `tab` state leaked across pages and
  // a form could hold focus on a page that has no form.
  useEffect(() => {
    setFocus(page === "tools" ? "top" : page === "activity" || page === "run" ? "form" : "list");
    setFormSel(0);
  }, [page]);
  const svc = data.status;
  const up = Boolean(svc?.devnet?.up);

  // The Run builder's `from` and `to` are pickers over the stack's own accounts, so
  // the field list is derived rather than typed. `hydra-dev up` with more accounts puts
  // them in the picker; no stack puts none, and the hint says so.
  const runFieldDefs = useMemo(() => {
    const syms = Object.keys(svc?.tokens ?? {});
    return runFields(svc?.accounts ?? [], syms.length ? syms : ["STRK", "ETH"]);
  }, [svc?.accounts, svc?.tokens]);

  const addLine = useCallback((text, sev = "info") => {
    setLog((prev) => [...prev, { text, sev }].slice(-LOG_MAX));
    setLogSel(-1);                       // -1 pins the view to the tail
  }, []);
  const note = useCallback((text, sev = "info") => {
    setMsg({ text, sev, at: clock() });
    setLog((prev) => [...prev, { text, sev }].slice(-LOG_MAX));
  }, []);

  useEffect(() => {
    let alive = true;
    const id = setInterval(() => {
      TX.transactAvailable().then((v) => alive && setTxAvailable(v)).catch(() => {});
    }, 4000);
    TX.transactAvailable().then((v) => alive && setTxAvailable(v)).catch(() => {});
    return () => { alive = false; clearInterval(id); };
  }, []);

  // A stack this TUI started is this TUI's to clean up, and so is its poller.
  useEffect(() => () => {
    clearInterval(pollRef.current);
    stackRef.current?.stop?.();
  }, []);

  const entry = ledger[cursor.run] ?? null;
  const report = entry?.report ?? null;
  const nav = navs[page] ?? { level: 0, sel: [0, 0] };
  // RIG_IDS is the set of pages whose data source is named differently from the page.
  const paneId = RIG_IDS.includes(page) ? page : null;

  const cursorSet = useCallback((patch) => setCursorState((c) => ({ ...c, ...patch })), []);
  const setNav = useCallback((patch) => {
    setNavs((n) => ({ ...n, [page]: { ...(n[page] ?? { level: 0, sel: [0, 0] }), ...patch } }));
  }, [page]);

  // ---- the list under the cursor, whichever it is ------------------------
  const listCtx = useMemo(() => {
    // On a sectioned page the focused half owns the cursor.
    if (page === "activity") {
      return focus === "form"
        ? { len: ACTIVITY_FIELDS.length, get: () => formSel, set: setFormSel, height: ACTIVITY_FIELDS.length }
        : { len: activityRows(data.blocks?.blocks, forms.activity).length,
            get: () => nav.sel[0] ?? 0, set: (v) => setNav({ sel: [v, 0] }), height: geom.rigRows - 4 };
    }
    if (page === "run") {
      const total = TX_ACTIONS.length + (data.flows?.flows?.length ?? 0);
      return focus === "form"
        ? { len: runFieldDefs.length, get: () => formSel, set: setFormSel, height: runFieldDefs.length }
        : { len: total, get: () => runSel, set: setRunSel, height: 8 };
    }
    if (page === "build") {
      return { len: ops.length, get: () => buildSel, set: setBuildSel, height: 8 };
    }
    if (page === "tools" && focus === "top") {
      return { len: TOOL_CATEGORIES.length, get: () => catSel, set: setCatSel, height: TOOL_CATEGORIES.length };
    }
    // No entry for `about`: it lays out in columns to fit and never scrolls, so
    // there is no selection to move.
    if (page === "log") {
      return { len: log.length, get: () => (logSel < 0 ? log.length - 1 : logSel),
        set: setLogSel, height: geom.rigRows - 2 };
    }
    if (page === "wallets") {
      return { len: (data.wallets?.wallets ?? []).length, get: () => nav.sel[0] ?? 0,
        set: (v) => setNav({ sel: [v, 0] }), height: geom.rigRows - 4 };
    }
    return { len: 0, get: () => 0, set: () => {}, height: 1 };
  }, [page, paneId, data, nav, filter, runSel, logSel, log.length, geom.rigRows, setNav,
      focus, formSel, forms, catSel, buildSel, ops, runFieldDefs]);

  // The Activity detail block sits ABOVE the list and describes whatever the cursor
  // is on, so the receipt has to follow the selection rather than wait for a key.
  // Debounced, because holding `s` down would otherwise issue one pair of RPC calls
  // per keypress, and guarded, because a slow reply must not overwrite a newer one.
  const activeHash = page === "activity"
    ? activityRows(data.blocks?.blocks, forms.activity)[nav.sel[0] ?? 0]?.hash ?? null
    : null;
  useEffect(() => {
    setReceipt(null);
    if (!activeHash) return undefined;
    let live = true;
    const id = setTimeout(() => {
      txStatus(activeHash)
        .then((r) => live && setReceipt(r))
        .catch(() => live && setReceipt({ available: true, found: false, error: "txStatus failed" }));
    }, 200);
    return () => { live = false; clearTimeout(id); };
  }, [activeHash]);

  // ---- the things that touch the world -----------------------------------
  const bringUp = useCallback((env = {}) => {
    if (stackRef.current) return note("a stack is already supervised by this TUI", "warn");
    setBusy({ label: "starting the stack — this takes a moment", since: Date.now() });
    setLogTitle("hydra-dev up");
    setLog([]);
    setPage("log");
    setNavCursor(pageIndex("log"));
    stackRef.current = startStack((l) => addLine(l), env);
    stackRef.current.child.on("close", () => {
      stackRef.current = null;
      setBusy(null);
      clearInterval(pollRef.current);
      addLine("stack process exited", "warn");
    });
    // up() reports readiness by printing; poll until devnet answers.
    const started = Date.now();
    const poll = setInterval(async () => {
      const s = await status().catch(() => null);
      if (s?.devnet.up) { setBusy(null); note("stack up", "ok"); clearInterval(poll); }
      else if (Date.now() - started > 120000) { setBusy(null); note("gave up waiting for devnet", "bad"); clearInterval(poll); }
    }, 1500);
    pollRef.current = poll;
  }, [addLine, note]);

  const bringDown = useCallback(async () => {
    setBusy({ label: "stopping the stack", since: Date.now() });
    if (stackRef.current) {
      await stackRef.current.stop();
      stackRef.current = null;
      setBusy(null);
      return note("stack down", "ok");
    }
    // No supervised child: signal the recorded pids. This is the path `d` takes
    // when devnet has already died and the indexer from the same `hydra-dev up` is
    // still alive, which is why the binding is not gated on a live devnet.
    const r = await stopStack();
    addLine(r.ok ? `signalled ${r.killed.join(", ") || "nothing"}` : r.reason, r.ok ? "info" : "warn");
    setBusy(null);
    return note(r.ok ? `stack down — signalled ${r.killed.join(", ") || "nothing"}` : r.reason,
      r.ok ? "ok" : "warn");
  }, [addLine, note]);

  /** Runs one flow, then records the whole disclosure report against it. */
  /**
   * The leak action for a flow, with anything chain-dependent actually read.
   *
   * Only `opensChannel` today. The pool's channel count is a public view, so this
   * is computable rather than assertable — and when the read fails the field is
   * left undefined, which packages/leak reports as UNKNOWN rather than as "no".
   */
  const resolveLeak = useCallback(async (action) => {
    if (!action?.leak) return null;
    if (!action.recipient) return action.leak;
    // A recipient is either one of this stack's account names or a pasted address.
    // The pool's view takes an address either way, which is the whole reason pasting
    // one is worth offering: "does a transfer to THIS party open a channel?" is
    // answerable about a counterparty nobody here holds a key for.
    const named = (svc?.accounts ?? []).find((a) => a.name === action.recipient);
    const address = named?.address ?? (isAddress(action.recipient) ? action.recipient : null);
    const opens = await opensChannelTo(address).catch(() => undefined);
    return opens === undefined ? action.leak : { ...action.leak, opensChannel: opens };
  }, [svc]);

  const doFlow = useCallback(async (action, leakAction) => {
    // A flow with no `run` is preview-only — a type with no endpoint, or a party
    // this stack holds no key for. It is not the notes flow, and running the notes
    // flow instead of it would submit something nobody asked for.
    if (!action.run && !action.notesOnly) {
      return note(action.reason ?? "this one cannot be submitted here — the preview is all there is", "warn");
    }
    if (action.notesOnly) {
      setBusy({ label: "re-discovering notes for alice and bob", since: Date.now() });
      const [a, b] = await Promise.all([TX.notes("alice"), TX.notes("bob")]);
      setBusy(null);
      note(`notes — alice ${(a.notes ?? []).length}, bob ${(b.notes ?? []).length}`, "ok");
      return;
    }
    setBusy({ label: `${action.label} — proving and submitting`, since: Date.now() });
    setLogTitle(action.label);
    setLog([]);
    addLine("building, proving, advancing past note maturity, submitting…");
    const r = await action.run();
    addLine(r.ok ? `ok in ${r.ms ?? "?"}ms  tx ${r.txHash ?? "(none)"}` : `failed: ${r.error}`,
      r.ok ? "info" : "bad");
    // Recorded here because this is the point that already knows the outcome. Nothing
    // kept any of this before: the log is cleared on every flow and the ledger is in
    // memory, so "recent failures" was unanswerable.
    record({ kind: "flow", name: action.label, ok: r.ok, ms: r.ms, detail: r.error }).catch(() => {});

    const la = leakAction ?? action.leak;
    const rep = la ? whatDoesThisLeak({ config: leakConfig(svc), actions: [la] }) : null;
    setLedger((prev) => [
      { id: `${Date.now()}`, at: clock(), label: action.label, ok: r.ok, txHash: r.txHash,
        ms: r.ms, error: r.error, report: rep, source: "run" },
      ...prev,
    ].slice(0, 50));
    setCursorState((c) => ({ ...c, run: 0, action: 0, scroll: 0 }));
    setBusy(null);
    note(r.ok ? `${action.label} done in ${r.ms ?? "?"} ms · ${SHAPE_CAVEAT}` : `failed: ${String(r.error).slice(0, 70)}`,
      r.ok ? "ok" : "bad");
  }, [addLine, note, svc]);

  const doFix = useCallback(async (row) => {
    setBusy({ label: `fixing ${row.name}`, since: Date.now() });
    setLogTitle(`fix: ${row.name}`);
    setLog([]);
    setPage("log");
    setNavCursor(pageIndex("log"));
    const r = await runFix(row, (l) => addLine(l, /error|warning/i.test(l) ? "warn" : "info"));
    setBusy(null);
    note(r.ok ? `${row.name} fixed` : `fix failed (exit ${r.code ?? "?"}) ${r.reason ?? ""}`, r.ok ? "ok" : "bad");
    refresh("doctor");
  }, [addLine, note, refresh]);

  // ---- the api the keymap drives -----------------------------------------
  const api = useMemo(() => ({
    exit,
    note,
    cursor: cursorSet,
    selectRun: (i) => setCursorState((c) => ({
      ...c, run: Math.max(0, Math.min(ledger.length - 1, i)), action: 0, scroll: 0,
    })),
    cycleDrawer: (d) => setCursorState((c) => ({
      ...c, drawer: DRAWERS[(DRAWERS.indexOf(c.drawer) + d + DRAWERS.length) % DRAWERS.length], scroll: 0,
    })),
    moveSel: (d) => listCtx.set(Math.max(0, Math.min(listCtx.len - 1, listCtx.get() + d))),
    jumpSel: (w) => listCtx.set(w === "first" ? 0 : Math.max(0, listCtx.len - 1)),
    pageSel: (d) => listCtx.set(Math.max(0, Math.min(listCtx.len - 1, listCtx.get() + d * listCtx.height))),
    startFilter: () => setFilter({ text: "", typing: true }),
    setFilter,
    goto: (id) => {
      setFilter(null);
      setPage(id);
      setNavCursor(pageIndex(id));
    },
    navMove: (d) => setNavCursor((i) => Math.max(0, Math.min(PAGES.length - 1, i + d))),
    toggleFocus: () => setFocus((f) =>
      page === "tools" ? (f === "top" ? "list" : "top")
        : page === "build" ? (f === "list" ? "out" : "list")
          : f === "form" ? "list" : "form"),
    /**
     * Enter on a form row. Enum and bool fields advance in place and never enter a
     * mode you have to escape from; only text fields take the keyboard.
     */
    editField: () => {
      const fields = page === "activity" ? ACTIVITY_FIELDS : runFieldDefs;
      const f = fields[formSel];
      if (!f) return undefined;
      const next = advance(f, forms[page]);
      if (next !== TYPE) {
        return setForms((all) => ({ ...all, [page]: { ...all[page], [f.id]: next } }));
      }
      // A picker that has cycled round to PASTE opens EMPTY. Seeding it with the
      // account name it was on would mean backspacing over "alice" before typing an
      // address, which is not what asking for a different value looks like.
      const seed = f.kind === "enum" ? "" : String(forms[page]?.[f.id] ?? "");
      return setPromptState({
        // The id, so the form knows WHICH cell to draw the typed text into. Without
        // it the cell kept showing the saved value and the field read as dead.
        field: f.id,
        label: f.kind === "enum" ? `${f.label} — 0x address:` : `${f.label}:`,
        value: seed,
        onSubmit: (v) => {
          const val = String(v).trim();
          // A picker's escape hatch takes an ADDRESS or nothing. Storing whatever was
          // typed would put a value in the field that is neither one of the accounts
          // nor something the chain can be asked about — and an empty submit is a
          // change of mind, not an instruction to blank the field.
          if (f.kind === "enum") {
            if (!val) return note(`nothing typed — ${f.label} is unchanged`, "info");
            if (!isAddress(val)) {
              return note(`${f.label} takes an account from the list or a 0x address`, "warn");
            }
          }
          setForms((all) => ({ ...all, [page]: { ...all[page], [f.id]: val } }));
          if (page === "activity" && f.id === "depth") refresh("blocks");
          return undefined;
        },
      });
    },
    saveFlow: () => {
      const v = forms.run;
      note(`saving ${v.name || "(unnamed)"}…`);
      persistFlow(v).then((r) => {
        note(r.ok ? `saved ${r.flow.name}${r.flow.runnable ? "" : " — preview only, no control endpoint"}`
                  : `not saved: ${r.error}`, r.ok ? "ok" : "bad");
        refresh("flows");
      });
    },
    forgetFlow: () => {
      const saved = data.flows?.flows ?? [];
      const f = saved[runSel - TX_ACTIONS.length];
      if (!f) return note("that one is built in — it cannot be forgotten", "warn");
      return dropFlow(f.id).then((r) => {
        note(r.ok ? `forgot ${f.name}` : r.error, r.ok ? "ok" : "bad");
        refresh("flows");
      });
    },
    askOperation: () => {
      const op = ops[buildSel];
      if (!op) return undefined;
      // Per-operation, because e2e/contracts/* are separate Scarb workspaces and
      // cannot be built from the root the way the members can.
      const cwd = join(upstreamPath(), op.dir ?? ".");
      return setConfirm({
        kind: "operation", op,
        prompt: `run ${op.label}?`,
        cmd: op.cmd,
        cwd,
        lines: [
          op.seconds === null || op.seconds === undefined
            ? "never timed on this machine — there is no estimate for this one"
            : `about ${op.seconds >= 60 ? Math.round(op.seconds / 60) + " minutes" : op.seconds + " seconds"} on this machine, measured`,
          op.mutates ? `writes ${op.mutates}` : "writes nothing outside target/",
          "once started it cannot be cancelled from here — it keeps running in the background",
        ],
      });
    },
    cycleSection: (d) => setSection((i) => (i + d + SECTION_COUNT) % SECTION_COUNT),
    openCursor: () => {
      setFilter(null);
      setPage(PAGES[navCursor]?.id ?? "overview");
    },
    /**
     * Re-read the selected transaction. The detail block above the list already
     * follows the cursor, so Enter is a retry rather than a drill-down — which is
     * what it is for when the first read failed.
     */
    reloadReceipt: () => {
      if (page !== "activity") return undefined;
      const row = activityRows(data.blocks?.blocks, forms.activity)[nav.sel[0] ?? 0];
      if (!row?.hash) return note("that block carried no transactions", "warn");
      setReceipt(null);
      return txStatus(row.hash)
        .then(setReceipt)
        .catch(() => setReceipt({ available: true, found: false, error: "txStatus failed" }));
    },
    /** esc, in one fixed order. Never quits — q is the documented quit. */
    escape: () => {
      if (filter) return setFilter(null);
      if (cursor.expanded) return cursorSet({ expanded: false });
      if (nav.level > 0) return setNav({ level: nav.level - 1 });
      if (page !== "overview") { setPage("overview"); return setNavCursor(0); }
      return note("esc has nothing to close — q quits", "info");
    },
    refreshFocused: () => {
      const src = paneId ? srcOf(paneId) : "status";
      note(`refreshing ${src}…`);
      refresh(src);
      if (src !== "status") refresh("status");
    },
    bringUp, bringDown,
    setPrompt: (value) => setPromptState((p) => (p ? { ...p, value } : p)),
    closePrompt: () => { setPromptState(null); note("cancelled"); },
    submitPrompt: () => {
      const p = prompt;
      setPromptState(null);
      if (p?.onSubmit) p.onSubmit(p.value);
    },
    askToken: () => setPromptState({
      label: "token to track  SYMBOL 0xaddress",
      value: "",
      onSubmit: (raw) => {
        const [sym, address] = String(raw).trim().split(/\s+/);
        note(`checking ${sym ?? "?"}…`);
        addToken({ symbol: sym, address })
          .then((r) => note(r.ok ? `tracking ${r.symbol}` : `not tracked: ${r.error}`, r.ok ? "ok" : "bad"))
          .then(() => { refresh("wallets"); refresh("status"); });
      },
    }),
    exportWallets: () => {
      note("exporting…");
      exportWallets()
        .then((r) => note(r.ok ? `wrote ${r.accounts} accounts to ${r.path}` : `export failed: ${r.error}`,
          r.ok ? "ok" : "bad"));
    },
    /**
     * devnet has no add-an-account call — its set is fixed by `--accounts N` at
     * spawn — so this is a restart, and the prompt says so rather than implying
     * the running chain is about to grow one.
     */
    askMoreAccounts: () => {
      // The recorded set includes admin, which is not a user account. HYDRA_ACCOUNTS
      // counts USER accounts (up.mjs passes `userAccounts`), so the two differ by one.
      const users = Math.max(2, (svc?.accounts ?? []).filter((a) => a.name !== "admin").length);
      const want = users + 1;
      if (want > 16) return note("devnet is capped at 16 accounts here", "warn");
      // `count` used to be `have` — the same number it already had — so the one
      // button for adding an account restarted the stack and changed nothing.
      return setConfirm({
        kind: "accounts", count: want,
        prompt: `restart the stack with ${want} user accounts (it has ${users})?`,
        lines: [
          "devnet fixes its accounts when it starts; there is no call that adds one.",
          "this stops the running stack and starts a new one — the chain is discarded.",
          "the new account holds funds and can be minted to; pool flows still run as",
          "alice or bob only (packages/cli/src/control.mjs:41).",
        ],
      });
    },
    fundWallet: () => {
      const target = (data.wallets?.wallets ?? [])[nav.sel[0] ?? 0];
      if (!target) return note("no account selected", "warn");
      note(`funding ${target.name}…`);
      faucet({ address: target.address })
        .then((r) => note(r.ok ? `funded ${target.name}` : `faucet failed: ${r.error}`, r.ok ? "ok" : "bad"))
        .then(() => refresh("wallets"));
    },
    askFix: () => {
      // The FILTERED list, the same one on screen. Reading the unfiltered rows here
      // would offer to run a fix for a row the filter has hidden.
      const row = visibleRows(data.doctor?.rows, filter)[nav.sel[0] ?? 0];
      if (!row) return note("no row selected", "warn");
      if (row.status.trim() === "ok") return note("nothing to fix on that row", "info");
      const d = describeFix(row);
      if (!d.runnable) return note(d.reason, "warn");
      setConfirm({
        kind: "fix", row, cmd: d.cmd, cwd: d.cwd,
        prompt: "run this? it executes a real command",
        // install.mjs:29-51 returns a promise with no kill handle, so this is the
        // honest wording until an abort handle exists upstream of this stream.
        lines: ["once started it cannot be cancelled from here — it keeps running in the background"],
      });
    },
    askFlow: async () => {
      // Built-ins first, then whatever has been saved — the same order the list
      // draws. `enter` on a saved flow used to fall off the end of TX_ACTIONS and
      // do nothing at all, so a flow you built could be saved and never looked at.
      const saved = data.flows?.flows ?? [];
      const action = runSel < TX_ACTIONS.length
        ? TX_ACTIONS[runSel]
        : (saved[runSel - TX_ACTIONS.length] ? flowAsAction(saved[runSel - TX_ACTIONS.length]) : null);
      if (!action) return undefined;
      // Resolved before the preview is built, so the cells you are shown are the
      // cells the run will report. The read is one starknet_call and needs no
      // proving; when there is no stack it returns undefined and the recipient
      // column reads UNKNOWN, which is the honest answer.
      const leakAction = await resolveLeak(action);
      // The preview is computed by whatDoesThisLeak, which is pure and needs no
      // stack, so it is shown either way. Only `y` needs a running control API.
      const preview = leakAction
        ? whatDoesThisLeak({ config: leakConfig(svc), actions: [leakAction] })
        : null;
      return setConfirm({
        leakAction,
        kind: "flow", action,
        prompt: action.run
          ? `run ${action.label}? it submits a real transaction`
          : action.notesOnly ? `run ${action.label}?` : `${action.label} — preview only`,
        // mark(), not a local replace(): this screen is shown immediately before a
        // real transaction is submitted, and it used to carry a second vocabulary —
        // raw enum words where the matrix renders `—`, and no legend at all, so an
        // unglossed `not-by-tx` read as "private" on the one screen that matters.
        lines: (txAvailable ? [] : ["no running stack — y will not be able to submit; u starts one"]).concat(preview
          ? ["this is what it will disclose, under the config strip above:"]
            .concat(preview.parties.map(([id, label]) =>
              `  ${label.padEnd(27)}${preview.fields.map((f) => mark(preview.disclosures[0].byParty[id][f].disclosure).word.padEnd(12)).join("")}`))
          : ["this one runs discoverNotes() and submits nothing"])
          .concat(action.reason ? [`it will not be submitted: ${action.reason}`] : []),
        legend: Boolean(preview),
      });
    },
    /**
     * Quitting is a question, not a confirmation.
     *
     * A stack this TUI started is a devnet, a discovery service and a control API,
     * and both answers are right some of the time: leaving them up is what you want
     * before running `hydra-dev status` or a test, and wrong when you are done. The old
     * prompt only appeared when something was mid-flight and always signalled the
     * stack, so the background case needed you to kill the terminal instead.
     */
    askQuit: () => setQuitting(true),
    cancelQuit: () => setQuitting(false),
    quitLeaveRunning: () => {
      // Drop the supervision handle first: the unmount effect signals whatever it
      // still holds, which is exactly what "leave it running" must not do.
      stackRef.current = null;
      clearInterval(pollRef.current);
      exit();
    },
    quitAndStop: async () => {
      setQuitting(false);
      setBusy({ label: "stopping the stack", since: Date.now() });
      try {
        if (stackRef.current) { await stackRef.current.stop(); stackRef.current = null; }
        else await stopStack();
      } catch { /* reported below either way */ }
      clearInterval(pollRef.current);
      exit();
    },
    confirmYes: () => {
      const c = confirm;
      setConfirm(null);
      if (c.kind === "fix") return doFix(c.row);
      if (c.kind === "operation") {
        const op = c.op;
        setBuildResult(null);
        setBuildLines([]);
        setBusy({ label: op.label, since: Date.now(), seconds: op.seconds });
        setLogTitle(op.label);
        setLog([]);
        return runOperation(op, c.cwd, (l) => {
          addLine(l);
          setBuildLines((prev) => [...prev, l].slice(-200));
        }).then((r) => {
          setBusy(null);
          setBuildResult(r);
          setBuildResults((prev) => ({ ...prev, [op.id]: r }));
          note(`${op.label} — ${r.verdict?.text ?? (r.ok ? "ok" : "failed")}`, r.ok ? "ok" : "bad");
          return record({ kind: op.group, name: op.label, ok: r.ok, ms: r.ms,
            detail: r.verdict?.text });
        });
      }
      if (c.kind === "accounts") {
        note("restarting with one more account…");
        return bringDown().then(() => bringUp({ HYDRA_ACCOUNTS: String(c.count) }));
      }
      if (c.kind === "flow") {
        if (c.action.run && !txAvailable) return note("no running stack — u starts one", "warn");
        // Land on Disclosure, not back on the run menu: the point of running a
        // flow is the report it produces, and it is one page away.
        setPage("disclosure");
        setNavCursor(pageIndex("disclosure"));
        return doFlow(c.action, c.leakAction);
      }
      return undefined;
    },
    confirmNo: () => { setConfirm(null); note("cancelled"); },
    loadExample: () => {
      try {
        const tx = JSON.parse(readFileSync(EXAMPLE, "utf8"));
        setLedger((prev) => [{
          id: `ex${Date.now()}`, at: clock(), label: "example · private-transfer.json",
          ok: true, txHash: null, ms: null, report: whatDoesThisLeak(tx), source: "example",
        }, ...prev]);
        setCursorState((c) => ({ ...c, run: 0, action: 0, scroll: 0 }));
        note("loaded a report from disk — this is not a measurement of this machine", "warn");
      } catch (e) {
        note(`could not read ${EXAMPLE}: ${e.message}`, "bad");
      }
    },
  }), [exit, note, cursorSet, ledger.length, listCtx, paneId, nav, data, filter, cursor.expanded,
       page, navCursor, section, prompt, refresh, resolveLeak, bringUp, bringDown, confirm, doFix, doFlow, runSel, svc, txAvailable, setNav, ops, buildSel]);

  const keyState = {
    cursor, report, page, navCursor, quitting, confirm, filter, prompt, busy, up, focus,
    partyCount: report?.parties?.length ?? 6,
    fieldCount: report?.fields?.length ?? 5,
    actionCount: report?.disclosures?.length ?? 1,
  };
  useInput((input, key) => dispatch(keyState, input, key, api));

  // ---- splash -------------------------------------------------------------
  // Progress is real: each step is a source that has actually reported. The
  // elapsed-time floor only stops a warm stack from flashing the mark for 80ms —
  // it can move the bar forward, never mark a step done that is not.
  const steps = useMemo(() => [
    { label: "reading the recorded stack state", done: data.status !== undefined },
    { label: "probing devnet", done: svc?.devnet !== undefined },
    { label: "probing the discovery service", done: svc?.indexer !== undefined },
    { label: "checking the toolchain", done: data.doctor !== undefined },
  ], [data.status, data.doctor, svc]);
  const allDone = steps.every((x) => x.done);

  useEffect(() => { refresh("doctor"); }, [refresh]);

  // Held in a ref so the one interval below can read the current value without
  // being torn down and rebuilt every time a source lands.
  const allDoneRef = useRef(false);
  allDoneRef.current = allDone;

  // One clock for the whole splash.
  //
  // This was two effects and a `setSealT((t) => t)` used as a "poke" — which sets
  // an identical value, so React bails out of the re-render, the effect's deps
  // never change, and the splash sits at 4/4 for ever. A repaint is not a
  // scheduler: if a transition depends on wall-clock time, something has to
  // actually be ticking.
  useEffect(() => {
    if (phase !== "loading") return undefined;
    const id = setInterval(() => {
      setTick((n) => n + 1);
      if (allDoneRef.current && Date.now() - bornAt.current >= timings().hold) setPhase("sealing");
    }, 60);
    return () => clearInterval(id);
  }, [phase]);

  // The seal has its own clock. 40ms is 25fps: smooth over a 700ms sweep, and
  // cheap enough that a blocked event loop drops frames rather than queueing them.
  useEffect(() => {
    if (phase !== "sealing") return undefined;
    const began = Date.now();
    const seal = Math.max(1, timings().seal);
    const id = setInterval(() => {
      const t = (Date.now() - began) / seal;
      if (t >= 1) { clearInterval(id); setSealT(1); setPhase("ready"); }
      else setSealT(t);
    }, 40);
    return () => clearInterval(id);
  }, [phase]);

  // ---- render -------------------------------------------------------------
  const cfg = leakConfig(svc);
  const age = staleness("status");

  // Below the floor there is no layout to degrade. Say the size and stop, in
  // fewer rows than the terminal has.
  if (tooSmall) {
    return html`
      <${Box} flexDirection="column" width=${cols}>
        <${Text} bold>${" hydra".slice(0, cols)}<//>
        <${Text} color=${C.warn}>${` ${MIN_COLS}x${MIN_ROWS} needed`.slice(0, cols)}<//>
        <${Text} color=${C.muted}>${` this is ${cols}x${rows} · q quits`.slice(0, cols)}<//>
      <//>`;
  }

  if (phase !== "ready") {
    const elapsed = Date.now() - bornAt.current;
    const done = steps.filter((x) => x.done).length;
    return html`
      <${Box} flexDirection="column" width=${cols} height=${rows - 1} overflow="hidden">
        <${Splash} cols=${cols} rows=${rows - 1}
          progress=${Math.max(done / steps.length, Math.min(0.92, elapsed / Math.max(1, timings().hold)))}
          seal=${phase === "sealing" ? sealT : null} steps=${steps}
          note=${up ? "stack up" : "no stack — u starts one"} />
      <//>`;
  }

  // The doctor already probes every artifact; reusing its rows here means the Build
  // page cannot disagree with the Tools page about what is built.
  // Keyed by the artifact PATH, which is the one thing doctor's rows and the
  // discovered operations both name. Keying by operation id meant a renamed op
  // silently stopped reporting whether it had built.
  const artifactState = {};
  for (const r of data.doctor?.rows ?? []) {
    const m = /^artifact: (.+)$/.exec(r.name);
    const rel = m && ARTIFACTS[m[1]];
    if (rel) artifactState[rel] = r.status.trim() === "ok";
  }

  // One row of headroom below everything: Ink clears the whole terminal the
  // moment a frame reaches stdout.rows (ink/build/ink.js:121).
  const draw = rows - 1;
  const showStatusBar = page !== "overview";
  const bodyRows = draw - 1 - 1 - (showStatusBar ? 1 : 0);   // nav, message, status
  const W = geom.contentW;

  let content;
  if (quitting) {
    content = html`
      <${Box} flexDirection="column" height=${bodyRows} overflow="hidden">
        <${QuitPrompt} width=${W} running=${up || Boolean(svc?.stack)}
          managed=${Boolean(stackRef.current)} />
      <//>`;
  } else if (confirm) {
    content = html`
      <${Box} flexDirection="column" height=${bodyRows} overflow="hidden">
        <${Confirm} c=${confirm} width=${W} />
      <//>`;
  } else if (page === "overview") {
    content = html`
      <${Overview} cols=${W} rows=${bodyRows} svc=${svc} wal=${data.wallets}
        blocks=${data.blocks} doctor=${data.doctor} ledger=${ledger} control=${txAvailable}
        note=${AUDITOR_NOTE} />`;
  } else if (page === "about") {
    content = html`<${About} width=${W} height=${bodyRows} section=${section} />`;
  } else if (page === "log") {
    content = html`
      <${LogPane} lines=${log} title=${logTitle} width=${W} height=${bodyRows}
        selected=${logSel < 0 ? log.length - 1 : logSel} filter=${filter} />`;
  } else if (page === "activity") {
    const gated = data.blocks === undefined && !up
      ? { available: false, reason: "no running stack — u starts one" }
      : data.blocks;
    content = html`
      <${ActivityPage} width=${W} height=${bodyRows} data=${gated} values=${forms.activity}
        focus=${focus} selected=${nav.sel[0] ?? 0} formSel=${formSel}
        prompt=${prompt} receipt=${receipt} />`;
  } else if (page === "run") {
    content = html`
      <${RunPage} fields=${runFieldDefs} width=${W} height=${bodyRows} builtIn=${TX_ACTIONS}
        flows=${data.flows?.flows ?? []} values=${forms.run} focus=${focus}
        selected=${runSel} formSel=${formSel} prompt=${prompt}
        txAvailable=${txAvailable} />`;
  } else if (page === "tools") {
    content = html`
      <${ToolsPage} width=${W} height=${bodyRows} doctor=${data.doctor} svc=${svc}
        hist=${data.history} focus=${focus} selected=${nav.sel[0] ?? 0} catSel=${catSel}
        filter=${filter} />`;
  } else if (page === "build") {
    content = html`
      <${BuildPage} ops=${ops} width=${W} height=${bodyRows} selected=${buildSel} focus=${focus}
        results=${buildResults} artifacts=${artifactState} busy=${busy?.seconds ? busy : null}
        result=${buildResult} lines=${buildLines}
        deploy=${deployState(upstreamPath(), svc?.stack?.startedAt)} />`;
  } else if (page === "wallets") {
    content = html`
      <${WalletsPage} width=${W} height=${bodyRows}
        data=${data.wallets === undefined && !up ? { available: false, reason: "no running stack — u starts one" } : data.wallets}
        selected=${nav.sel[0] ?? 0} prompt=${prompt} tokens=${svc?.tokens} />`;
  } else if (!report) {
    content = html`
      <${Box} flexDirection="column" height=${bodyRows} overflow="hidden">
        <${ConfigStrip} cfg=${cfg} width=${W} />
        <${EmptyState} hasStack=${up} width=${geom.boxW} height=${bodyRows - 1} />
      <//>`;
  } else {
    const drawerW = geom.boxW;
    const drawer =
      cursor.drawer === "notes"
        ? html`<${NotesDrawer} report=${report} auditorNote=${AUDITOR_NOTE} width=${drawerW}
            bodyRows=${cursor.expanded ? geom.expandedBody : geom.drawerBody + geom.drawerCites}
            scroll=${cursor.scroll} focused=${true} />`
        : cursor.drawer === "anon"
          ? html`<${AnonDrawer} report=${report} actionIndex=${cursor.action} width=${drawerW}
              bodyRows=${cursor.expanded ? geom.expandedBody : geom.drawerBody + geom.drawerCites}
              scroll=${cursor.scroll} focused=${true} />`
          : html`<${WhyDrawer} report=${report} actionIndex=${cursor.action} cursor=${cursor}
              width=${drawerW} bodyRows=${cursor.expanded ? geom.expandedBody : geom.drawerBody}
              citeRows=${geom.drawerCites} scroll=${cursor.scroll}
              focused=${true} expanded=${cursor.expanded} />`;

    const right = geom.boxW - 2 >= 90
      ? `${SHAPE_CAVEAT} · ${report.upstreamCommit.slice(0, 8)}`
      : SHAPE_CAVEAT;
    const headline = `who learns what · ${entry.label}`.slice(0, Math.max(8, geom.boxW - 10 - right.length));
    content = html`
      <${Box} flexDirection="column" height=${bodyRows} overflow="hidden">
        <${ConfigStrip} cfg=${cfg} width=${W} />
        ${geom.ledgerRows > 0 ? html`
          <${Ledger} runs=${ledger} selected=${cursor.run} rows=${geom.ledgerRows} width=${W} />` : null}
        ${cursor.expanded ? null : html`
          <${Matrix} report=${report} actionIndex=${cursor.action} cursor=${cursor}
            geom=${geom} width=${geom.boxW} focused=${true}
            headline=${headline} right=${right} />`}
        ${cursor.expanded ? null : html`<${Legend} width=${W} />`}
        ${drawer}
      <//>`;
  }

  const statusText = quitting
    ? "choose what happens to the stack"
    : busy
      ? `${busy.label}  (l watches the log)`
      : msg.text;
  const statusColour = busy ? C.warn
    : msg.sev === "bad" ? C.bad : msg.sev === "ok" ? C.ok : msg.sev === "warn" ? C.warn : C.muted;

  return html`
    <${Box} flexDirection="column" paddingX=${geom.padX} width=${cols} height=${draw}
      overflow="hidden">
      ${showStatusBar ? html`<${StatusBar} width=${W} svc=${svc} />` : null}
      <${NavBar} width=${W} active=${page} cursor=${navCursor} />
      ${content}
      <${Box} width=${W} height=${1} overflow="hidden">
        <${Text} color=${statusColour}>${(" " + statusText).slice(0, Math.max(0, W - 8))}<//>
        <${Box} flexGrow=${1} />
        <${Text} color=${C.muted}>${age === null ? "" : `↻${age}s`}<//>
      <//>
    <//>`;
}

/** Pane id → the source that feeds it. One place, so they cannot drift. */
function srcOf(paneId) {
  return { wallets: "wallets", activity: "blocks", tools: "doctor" }[paneId];
}

export async function start() {
  // No tty means no TUI. Ink needs raw mode for input and throws without it, and
  // a half-drawn dashboard is no use to whatever is reading the pipe. Print the
  // status snapshot instead — the same data, in a form a pipe can consume.
  if (!process.stdin.isTTY) {
    const { COMMANDS } = await import("../../cli/src/agentcmds.mjs");
    const s = await COMMANDS.status.run();
    console.log("\n" + COMMANDS.status.render(s));
    console.log("\n  (not a tty — no TUI. `hydra-dev help` lists the --json commands.)\n");
    return;
  }
  // What shape a cell is, asked of the terminal rather than assumed, so the mark is
  // round here and round on a terminal with a different line height. Ink has not
  // taken stdin yet — after it does, the terminal's reply arrives as keystrokes.
  await measureCellAspect();
  // Clear the terminal, including its scrollback, before the first frame. Ink
  // draws in place and never owns the rows above it, so without this the mark
  // comes up under whatever the shell was already showing.
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  const app = render(html`<${App} />`);
  await app.waitUntilExit();
}

export { App, RIG_IDS, BINDINGS };
