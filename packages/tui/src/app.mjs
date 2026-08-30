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
import { BINDINGS, dispatch, footerFor, helpGroups } from "./keymap.mjs";
import { useSources } from "./sources.mjs";
import { PANES, Rig, LogPane, Confirm, Transact, Help, visibleItems } from "./panels.mjs";
import {
  leakConfig, ConfigStrip, Ledger, Matrix, Legend, WhyDrawer, NotesDrawer, AnonDrawer, EmptyState,
} from "./disclosure.mjs";
import { faucet } from "../../core/src/wallets.mjs";
import { txStatus } from "../../core/src/chain.mjs";
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
  { id: "shield", label: "shield    100 STRK  alice",
    run: () => TX.shield({ who: "alice", amount: "100", token: "STRK" }),
    leak: { type: "deposit", token: "STRK", amount: "100" } },
  { id: "register", label: "register  bob",
    run: () => TX.register("bob"), leak: { type: "register" } },
  { id: "transfer", label: "transfer  50 STRK  alice → bob",
    run: () => TX.transfer({ from: "alice", to: "bob", amount: "50", token: "STRK" }),
    leak: { type: "transfer", token: "STRK", amount: "50", counterparty: "bob", opensChannel: false } },
  { id: "notes", label: "notes     re-discover for alice and bob", run: null,
    note: "the only discoverNotes() call there is" },
];

const LOG_MAX = 200;
const DRAWERS = ["why", "notes", "anon"];
const RIG_IDS = ["services", "wallets", "activity", "tools"];
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
  const [overlay, setOverlay] = useState(null);
  const [navs, setNavs] = useState({});
  const [runSel, setRunSel] = useState(0);
  const [logSel, setLogSel] = useState(0);
  const [helpSel, setHelpSel] = useState(0);
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

  const { data, staleness, refresh } = useSources(overlay);
  const svc = data.status;
  const up = Boolean(svc?.devnet?.up);

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
  const nav = navs[overlay] ?? { level: 0, sel: [0, 0] };
  const paneId = overlay?.startsWith("rig:") ? overlay.slice(4) : null;
  const pane = paneId ? PANES[paneId] : null;

  const cursorSet = useCallback((patch) => setCursorState((c) => ({ ...c, ...patch })), []);
  const setNav = useCallback((patch) => {
    setNavs((n) => ({ ...n, [overlay]: { ...(n[overlay] ?? { level: 0, sel: [0, 0] }), ...patch } }));
  }, [overlay]);

  // ---- the list under the cursor, whichever it is ------------------------
  const listCtx = useMemo(() => {
    if (overlay === "run") return { len: TX_ACTIONS.length, get: () => runSel, set: setRunSel, height: 6 };
    // `?` is a list like any other. It has to be: 45 bindings do not fit on one
    // screen at any size this TUI supports, and an unscrollable `?` documents
    // fewer than half of them.
    if (overlay === "help") return { len: BINDINGS.length, get: () => helpSel, set: setHelpSel, height: geom.rigRows - 2 };
    if (overlay === "log") return { len: log.length, get: () => (logSel < 0 ? log.length - 1 : logSel), set: setLogSel, height: geom.rigRows - 2 };
    if (pane) {
      const items = visibleItems(pane, data[srcOf(paneId)], filter);
      if (nav.level === 1 && pane.subItems) {
        return { len: (pane.subItems(items[nav.sel[0]] ?? {}) ?? []).length,
          get: () => nav.sel[1] ?? 0, set: (v) => setNav({ sel: [nav.sel[0] ?? 0, v] }), height: geom.rigRows - 2 };
      }
      return { len: items.length, get: () => nav.sel[0] ?? 0,
        set: (v) => setNav({ sel: [v, 0] }), height: geom.rigRows - 2 };
    }
    return { len: 0, get: () => 0, set: () => {}, height: 1 };
  }, [overlay, pane, paneId, data, nav, filter, runSel, logSel, helpSel, log.length, geom.rigRows, setNav]);

  // ---- the things that touch the world -----------------------------------
  const bringUp = useCallback(() => {
    if (stackRef.current) return note("a stack is already supervised by this TUI", "warn");
    setBusy({ label: "starting the stack — this takes a moment", since: Date.now() });
    setLogTitle("hydra up");
    setLog([]);
    setOverlay("log");
    stackRef.current = startStack((l) => addLine(l));
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
    // when devnet has already died and the indexer from the same `hydra up` is
    // still alive, which is why the binding is not gated on a live devnet.
    const r = await stopStack();
    addLine(r.ok ? `signalled ${r.killed.join(", ") || "nothing"}` : r.reason, r.ok ? "info" : "warn");
    setBusy(null);
    return note(r.ok ? `stack down — signalled ${r.killed.join(", ") || "nothing"}` : r.reason,
      r.ok ? "ok" : "warn");
  }, [addLine, note]);

  /** Runs one flow, then records the whole disclosure report against it. */
  const doFlow = useCallback(async (action) => {
    if (!action.run) {
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

    const rep = action.leak
      ? whatDoesThisLeak({ config: leakConfig(svc), actions: [action.leak] })
      : null;
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
    setOverlay("log");
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
    toggleOverlay: (id) => {
      setFilter(null);
      setOverlay((o) => (o === id ? null : id));
    },
    /** enter descends: list → item → sub-item. Nothing else changes depth. */
    descend: () => {
      if (!pane) return;
      const max = pane.detail2 ? 2 : 1;
      const next = Math.min(max, nav.level + 1);
      if (next === 2) {
        const item = visibleItems(pane, data[srcOf(paneId)], filter)[nav.sel[0] ?? 0];
        const hash = (pane.subItems?.(item) ?? [])[nav.sel[1] ?? 0];
        setReceipt(null);
        if (hash) txStatus(hash).then(setReceipt).catch(() => setReceipt({ found: false, error: "txStatus failed" }));
      }
      setNav({ level: next });
    },
    /** esc, in one fixed order. Never quits — q is the documented quit. */
    escape: () => {
      if (filter) return setFilter(null);
      if (cursor.expanded) return cursorSet({ expanded: false });
      if (nav.level > 0) return setNav({ level: nav.level - 1 });
      if (overlay) return setOverlay(null);
      return note("esc has nothing to close — q quits", "info");
    },
    refreshFocused: () => {
      const src = paneId ? srcOf(paneId) : "status";
      note(`refreshing ${src}…`);
      refresh(src);
      if (src !== "status") refresh("status");
    },
    bringUp, bringDown,
    fundWallet: () => {
      const target = visibleItems(PANES.wallets, data.wallets, filter)[nav.sel[0] ?? 0];
      if (!target) return note("no account selected", "warn");
      note(`funding ${target.name}…`);
      faucet({ address: target.address })
        .then((r) => note(r.ok ? `funded ${target.name}` : `faucet failed: ${r.error}`, r.ok ? "ok" : "bad"))
        .then(() => refresh("wallets"));
    },
    askFix: () => {
      const row = visibleItems(PANES.tools, data.doctor, filter)[nav.sel[0] ?? 0];
      if (!row) return note("no row selected", "warn");
      if (row.status.trim() === "ok") return note("nothing to fix on that row", "info");
      const d = describeFix(row);
      if (!d.runnable) return note(`${d.reason} — enter opens the whole hint`, "warn");
      setConfirm({
        kind: "fix", row, cmd: d.cmd, cwd: d.cwd,
        prompt: "run this? it executes a real command",
        // install.mjs:29-51 returns a promise with no kill handle, so this is the
        // honest wording until an abort handle exists upstream of this stream.
        lines: ["once started it cannot be cancelled from here — it keeps running in the background"],
      });
    },
    askFlow: () => {
      const action = TX_ACTIONS[runSel];
      if (!action) return undefined;
      // The preview is computed by whatDoesThisLeak, which is pure and needs no
      // stack, so it is shown either way. Only `y` needs a running control API.
      const preview = action.leak
        ? whatDoesThisLeak({ config: leakConfig(svc), actions: [action.leak] })
        : null;
      return setConfirm({
        kind: "flow", action,
        prompt: action.run ? `run ${action.label}? it submits a real transaction` : `run ${action.label}?`,
        // mark(), not a local replace(): this screen is shown immediately before a
        // real transaction is submitted, and it used to carry a second vocabulary —
        // raw enum words where the matrix renders `—`, and no legend at all, so an
        // unglossed `not-by-tx` read as "private" on the one screen that matters.
        lines: (txAvailable ? [] : ["no running stack — y will not be able to submit; u starts one"]).concat(preview
          ? ["this is what it will disclose, under the config strip above:"]
            .concat(preview.parties.map(([id, label]) =>
              `  ${label.padEnd(27)}${preview.fields.map((f) => mark(preview.disclosures[0].byParty[id][f].disclosure).word.padEnd(12)).join("")}`))
          : ["this one runs discoverNotes() and submits nothing"]),
        legend: Boolean(preview),
      });
    },
    askQuit: () => setConfirm({
      kind: "quit", prompt: `${busy?.label ?? "something"} is running — quit anyway?`,
      lines: ["a stack this TUI started will be signalled; a fix will keep running in the background"],
    }),
    confirmYes: () => {
      const c = confirm;
      setConfirm(null);
      if (c.kind === "fix") return doFix(c.row);
      if (c.kind === "flow") {
        if (c.action.run && !txAvailable) return note("no running stack — u starts one", "warn");
        setOverlay(null);
        return doFlow(c.action);
      }
      if (c.kind === "quit") return exit();
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
  }), [exit, note, cursorSet, ledger.length, listCtx, pane, paneId, nav, data, filter, cursor.expanded,
       overlay, refresh, bringUp, bringDown, confirm, doFix, doFlow, runSel, svc, txAvailable, busy, setNav]);

  const keyState = {
    cursor, report, overlay, confirm, filter, busy, up,
    partyCount: report?.parties?.length ?? 6,
    fieldCount: report?.fields?.length ?? 5,
    actionCount: report?.disclosures?.length ?? 1,
  };
  useInput((input, key) => dispatch(keyState, input, key, api));

  // ---- render -------------------------------------------------------------
  const cfg = leakConfig(svc);
  const age = staleness("status");
  const W = geom.contentW;

  // Assembled to an exact width rather than laid out with flex. Ink wraps a Box
  // whose children overflow, and a header that silently becomes two rows pushes
  // the whole frame past stdout.rows — which is the one thing that must not happen.
  const brand = cols >= 100 ? " hydra ── six heads " : " hydra ─ six heads ";
  const glyphs = [
    [glyph(up), tone(up), " devnet  "],
    [glyph(svc?.indexer?.up && svc?.indexer?.healthy, svc?.indexer?.up),
     tone(svc?.indexer?.up && svc?.indexer?.healthy, svc?.indexer?.up), " indexer  "],
    ["◐", C.warn, ` prover ${svc?.prover?.mode ?? "?"}  `],
  ];
  const glyphW = glyphs.reduce((n, [g, , t]) => n + g.length + t.length, 0);
  // "no stack" next to two lit dots reads as a contradiction. Devnet answering
  // with no recorded state is not "no stack", it is "no pool address recorded".
  const poolAddr = svc?.stack?.poolAddress;
  const poolPart = poolAddr
    ? `pool ${poolAddr.slice(0, 8)}…${poolAddr.slice(-4)}`
    : up ? "no pool addr" : "no stack";
  // The age is the one droppable word here, so it is dropped first rather than
  // pushing the line past W and wrapping it into a second row — which at 70
  // columns is what takes the frame to stdout.rows. height/overflow below is the
  // guarantee; this is what keeps it from having to clip anything.
  const room = W - brand.length - glyphW;
  const withAge = poolPart + (age === null ? "  ↻ idle" : `  ↻${age}s`);
  const tail = withAge.length < room ? withAge : poolPart.slice(0, Math.max(0, room - 1));
  const gap = Math.max(1, room - tail.length);
  const header = html`
    <${Box} width=${W} height=${1} overflow="hidden">
      <${Text} bold>${brand.slice(0, W)}<//>
      <${Text} color=${C.muted}>${(cols >= 100 ? "─".repeat(gap - 1) + " " : " ".repeat(gap))}<//>
      ${glyphs.map(([g, col, t]) => html`
        <${Box} key=${t}>
          <${Text} color=${col}>${g}<//>
          <${Text} color=${C.muted}>${t}<//>
        <//>`)}
      <${Text} color=${C.muted}>${tail}<//>
    <//>`;

  const statusLine = html`
    <${Box} width=${W}>
      <${Text} color=${busy ? C.warn : msg.sev === "bad" ? C.bad : msg.sev === "ok" ? C.ok : msg.sev === "warn" ? C.warn : C.muted}>
        ${(" " + (busy ? `${busy.label}  (L watches the log)` : msg.text)).slice(0, W - 7)}<//>
      <${Box} flexGrow=${1} />
      <${Text} color=${C.muted}>${busy ? clock().slice(0, 5) : msg.at.slice(0, 5)}<//>
    <//>`;

  const footer = html`
    <${Text} color=${C.muted}>${" " + footerFor(keyState, W)}<//>`;

  // Below the floor there is no layout to degrade — the matrix cannot show 30
  // cells at full width, and a summary would be worse than an absence. Say the
  // size and stop, in fewer rows than the terminal has.
  if (tooSmall) {
    return html`
      <${Box} flexDirection="column" width=${cols}>
        <${Text} bold>${" hydra".slice(0, cols)}<//>
        <${Text} color=${C.warn}>${` ${MIN_COLS}x${MIN_ROWS} needed · ? for keys`.slice(0, cols)}<//>
        <${Text} color=${C.muted}>${` this is ${cols}x${rows} · q quits`.slice(0, cols)}<//>
      <//>`;
  }

  let content;
  if (confirm) {
    content = html`
      <${Box} flexDirection="column" height=${geom.rigRows}>
        <${Confirm} c=${confirm} width=${W} />
      <//>`;
  } else if (overlay === "help") {
    content = html`<${Help} groups=${helpGroups()} width=${W} height=${geom.rigRows} selected=${helpSel} />`;
  } else if (overlay === "log") {
    content = html`
      <${LogPane} lines=${log} title=${logTitle} width=${W} height=${geom.rigRows}
        selected=${logSel < 0 ? log.length - 1 : logSel} filter=${filter} />`;
  } else if (overlay === "run") {
    content = html`
      <${Box} flexDirection="column" height=${geom.rigRows}>
        <${Transact} actions=${TX_ACTIONS} selected=${runSel} width=${W} height=${Math.min(9, geom.rigRows)} />
        ${txAvailable ? null : html`
          <${Text} color=${C.warn}>${"  no running stack — u starts one; the preview still works"}<//>`}
      <//>`;
  } else if (pane) {
    // A gated source never runs, so its data stays undefined and the pane would
    // sit on "loading…" forever with a dead devnet. Hand it the reason instead:
    // an error state has to say what to do next.
    const gated = data[srcOf(paneId)] === undefined && !up && (paneId === "wallets" || paneId === "activity")
      ? { available: false, reason: "no running stack" }
      : data[srcOf(paneId)];
    content = html`
      <${Rig} pane=${pane} data=${gated} nav=${nav} width=${W}
        height=${geom.rigRows} filter=${filter} receipt=${receipt} />`;
  } else if (!report) {
    content = html`
      <${Box} flexDirection="column" height=${geom.rigRows}>
        <${EmptyState} hasStack=${up} width=${geom.boxW} height=${geom.rigRows} />
      <//>`;
  } else {
    const drawerRows = geom.drawerBody;
    const drawerW = geom.boxW;
    const drawer =
      cursor.drawer === "notes"
        ? html`<${NotesDrawer} report=${report} auditorNote=${AUDITOR_NOTE} width=${drawerW}
            bodyRows=${cursor.expanded ? geom.expandedBody : drawerRows + geom.drawerCites}
            scroll=${cursor.scroll} focused=${true} />`
        : cursor.drawer === "anon"
          ? html`<${AnonDrawer} report=${report} actionIndex=${cursor.action} width=${drawerW}
              bodyRows=${cursor.expanded ? geom.expandedBody : drawerRows + geom.drawerCites}
              scroll=${cursor.scroll} focused=${true} />`
          : html`<${WhyDrawer} report=${report} actionIndex=${cursor.action} cursor=${cursor}
              width=${drawerW} bodyRows=${cursor.expanded ? geom.expandedBody : drawerRows}
              citeRows=${geom.drawerCites} scroll=${cursor.scroll}
              focused=${true} expanded=${cursor.expanded} />`;

    // The caveat is the frame's right title, where it fits at every width. The
    // upstream commit joins it only when there is room: the admission that the
    // report describes the DECLARED action, not the receipt, is not droppable.
    const right = geom.boxW - 2 >= 90
      ? `${SHAPE_CAVEAT} · ${report.upstreamCommit.slice(0, 8)}`
      : SHAPE_CAVEAT;
    const headline = `who learns what · ${entry.label}`.slice(0, Math.max(8, geom.boxW - 10 - right.length));
    // Pinned to the planned height and clipped. fit() budgets these regions, but a
    // budget a region can quietly exceed is not a guarantee — see layout.mjs
    // reportRows. This is the guarantee: the frame is FIXED + reportRows, which is
    // at most rows-1, at every width, with a report on screen.
    content = html`
      <${Box} flexDirection="column" height=${geom.reportRows} overflow="hidden">
        ${geom.ledgerRows > 0 ? html`
          <${Box} flexDirection="column">
            ${geom.ledgerRule ? html`
              <${Text} color=${C.muted}>
                ${(" ── ran this session " + "─".repeat(Math.max(0, W - 46)) +
                   ` ${ledger.length} runs · ${report.unknownCount} UNKNOWN cells ──`).slice(0, W)}<//>` : null}
            <${Ledger} runs=${ledger} selected=${cursor.run} rows=${geom.ledgerRows} width=${W} />
          <//>` : null}
        ${cursor.expanded ? null : html`
          <${Matrix} report=${report} actionIndex=${cursor.action} cursor=${cursor}
            geom=${geom} width=${geom.boxW} focused=${true}
            headline=${headline} right=${right} />`}
        ${cursor.expanded ? null : html`<${Legend} width=${W} />`}
        ${drawer}
        ${geom.notesRows > 0 ? html`
          <${Text} color=${C.muted}>
            ${(" ── notes " + report.notes.length + " · anonymity set " +
               (report.anonymitySets[cursor.action]?.size ?? "UNKNOWN") + " " +
               "─".repeat(Math.max(0, W - 60)) + " tab cycles this region ──").slice(0, W)}<//>` : null}
        ${geom.notesRows > 1 ? html`
          <${Text} color=${C.unknown}>
            ${("  " + (report.notes.find((n) => n.kind === "unknown")?.text ?? report.notes[0]?.text ?? "")).slice(0, W)}<//>` : null}
      <//>`;
  }

  return html`
    <${Box} flexDirection="column" paddingX=${geom.padX} width=${cols}>
      ${header}
      <${ConfigStrip} cfg=${cfg} width=${W} />
      ${content}
      ${statusLine}
      ${footer}
    <//>`;
}

/** Pane id → the source that feeds it. One place, so they cannot drift. */
function srcOf(paneId) {
  return { services: "status", wallets: "wallets", activity: "blocks", tools: "doctor" }[paneId];
}

export async function start() {
  // No tty means no TUI. Ink needs raw mode for input and throws without it, and
  // a half-drawn dashboard is no use to whatever is reading the pipe. Print the
  // status snapshot instead — the same data, in a form a pipe can consume.
  if (!process.stdin.isTTY) {
    const { COMMANDS } = await import("../../cli/src/agentcmds.mjs");
    const s = await COMMANDS.status.run();
    console.log("\n" + COMMANDS.status.render(s));
    console.log("\n  (not a tty — no TUI. `hydra help` lists the --json commands.)\n");
    return;
  }
  const app = render(html`<${App} />`);
  await app.waitUntilExit();
}

export { App, RIG_IDS, BINDINGS };
