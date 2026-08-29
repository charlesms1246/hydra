/**
 * The hydra TUI.
 *
 * Every panel renders data from @hydra/core — the same functions the agent
 * commands call. A number the TUI shows and a number `hydra status --json`
 * returns come from one place, so they cannot disagree.
 */

import { render, Box, Text, useApp, useInput } from "ink";
import { html, React } from "./ui.mjs";
import { Services, Wallets, Activity, Tools, LogPane } from "./panels.mjs";
import { status } from "../../core/src/services.mjs";
import { wallets, faucet } from "../../core/src/wallets.mjs";
import { latestBlocks } from "../../core/src/chain.mjs";
import { startStack, stopStack } from "../../core/src/stack.mjs";
import { describeFix, runFix } from "../../core/src/install.mjs";
import { check } from "../../cli/src/doctor.mjs";

const { useState, useEffect, useCallback, useRef } = React;

const TABS = [
  ["s", "status", "Services"],
  ["w", "wallets", "Wallets"],
  ["a", "activity", "Activity"],
  ["t", "tools", "Tools"],
];

const POLL_MS = 2000;
const LOG_MAX = 200;

function App() {
  const { exit } = useApp();
  const [tab, setTab] = useState("status");
  const [svc, setSvc] = useState(null);
  const [wal, setWal] = useState(null);
  const [blk, setBlk] = useState(null);
  const [doc, setDoc] = useState(null);
  const [sel, setSel] = useState(0);
  const [toolSel, setToolSel] = useState(0);
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState([]);
  const [logTitle, setLogTitle] = useState("");
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const stackRef = useRef(null);

  const addLine = useCallback((l) => {
    setLog((prev) => [...prev, l].slice(-LOG_MAX));
  }, []);

  const rescan = useCallback(() => {
    try { setDoc({ rows: check() }); } catch { setDoc({ rows: [] }); }
  }, []);

  const refresh = useCallback(async () => {
    setSvc(await status().catch(() => null));
    if (tab === "wallets") setWal(await wallets().catch(() => null));
    if (tab === "activity") setBlk(await latestBlocks(10).catch(() => null));
    if (tab === "tools" && !doc) rescan();
  }, [tab, doc, rescan]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // A stack this TUI started is this TUI's to clean up.
  useEffect(() => () => { stackRef.current?.stop?.(); }, []);

  const bringUp = useCallback(() => {
    if (stackRef.current || busy) return;
    setBusy("starting the stack — this takes a moment");
    setLogTitle("hydra up");
    setLog([]);
    stackRef.current = startStack(addLine);
    stackRef.current.child.on("close", () => {
      stackRef.current = null;
      setBusy(null);
      addLine("stack process exited");
    });
    // up() reports readiness by printing; poll until devnet answers.
    const started = Date.now();
    const poll = setInterval(async () => {
      const s = await status().catch(() => null);
      if (s?.devnet.up) { setBusy(null); setMsg("stack up"); clearInterval(poll); }
      else if (Date.now() - started > 120000) { setBusy(null); setMsg("gave up waiting"); clearInterval(poll); }
    }, 1500);
  }, [busy, addLine]);

  const bringDown = useCallback(async () => {
    setBusy("stopping");
    if (stackRef.current) {
      await stackRef.current.stop();
      stackRef.current = null;
    } else {
      const r = await stopStack();
      addLine(r.ok ? `signalled ${r.killed.join(", ") || "nothing"}` : r.reason);
    }
    setBusy(null);
    setMsg("stack down");
  }, [addLine]);

  const doFix = useCallback(async (row) => {
    setConfirm(null);
    setBusy(`fixing ${row.name}`);
    setLogTitle(`fix: ${row.name}`);
    setLog([]);
    const r = await runFix(row, addLine);
    setBusy(null);
    setMsg(r.ok ? `${row.name} fixed` : `fix failed (exit ${r.code ?? "?"}) ${r.reason ?? ""}`);
    rescan();
  }, [addLine, rescan]);

  useInput((input, key) => {
    if (busy) return;                       // ignore keys while a command runs

    if (confirm) {
      if (input === "y") doFix(confirm.row);
      else if (input === "n" || key.escape) { setConfirm(null); setMsg("cancelled"); }
      return;
    }

    if (input === "q" || key.escape) return exit();
    const hit = TABS.find(([k]) => k === input);
    if (hit) { setTab(hit[1]); setMsg(""); return; }
    if (input === "r") { setMsg("refreshing…"); rescan(); refresh().then(() => setMsg("")); return; }
    if (input === "u") return bringUp();
    if (input === "d") return bringDown();

    if (tab === "wallets" && wal?.available) {
      if (key.downArrow || input === "j") setSel((i) => Math.min(i + 1, wal.wallets.length - 1));
      if (key.upArrow || input === "k") setSel((i) => Math.max(i - 1, 0));
      if (input === "f") {
        const target = wal.wallets[sel];
        if (!target) return;
        setMsg(`funding ${target.name}…`);
        faucet({ address: target.address })
          .then((r) => setMsg(r.ok ? `funded ${target.name}` : `faucet failed: ${r.error}`))
          .then(refresh);
      }
    }

    if (tab === "tools" && doc?.rows.length) {
      if (key.downArrow || input === "j") setToolSel((i) => Math.min(i + 1, doc.rows.length - 1));
      if (key.upArrow || input === "k") setToolSel((i) => Math.max(i - 1, 0));
      if (input === "i") {
        const row = doc.rows[toolSel];
        if (!row || row.status.trim() === "ok") { setMsg("nothing to fix on that row"); return; }
        const d = describeFix(row);
        if (!d.runnable) { setMsg(d.reason); return; }
        setConfirm({ row, cmd: d.cmd, cwd: d.cwd });
      }
    }
  });

  const running = svc?.devnet.up;

  const hints = busy
    ? "working…"
    : confirm
      ? "y run · n cancel"
      : [
          "r refresh · q quit",
          running ? "d stop stack" : "u start stack",
          tab === "wallets" ? "↑↓ select · f fund" : null,
          tab === "tools" ? "↑↓ select · i fix" : null,
        ].filter(Boolean).join(" · ");

  return html`
    <${Box} flexDirection="column" paddingX=${1}>
      <${Box} justifyContent="space-between">
        <${Text} bold>${"hydra"}<//>
        <${Text} color=${running ? "green" : "gray"}>${running ? "stack up" : "no stack"}<//>
      <//>

      <${Box} marginTop=${1}>
        ${TABS.map(([k, id, label]) => html`
          <${Box} key=${id} marginRight=${2}>
            <${Text} color=${tab === id ? "cyan" : "gray"} bold=${tab === id}>
              ${"[" + k + "] " + label}
            <//>
          <//>`)}
      <//>

      <${Box} marginTop=${1} flexDirection="column" minHeight=${12}>
        ${tab === "status" ? html`<${Services} s=${svc} />` : null}
        ${tab === "wallets" ? html`<${Wallets} w=${wal} selected=${sel} />` : null}
        ${tab === "activity" ? html`<${Activity} b=${blk} />` : null}
        ${tab === "tools" ? html`<${Tools} d=${doc} selected=${toolSel} confirm=${confirm} />` : null}
      <//>

      <${LogPane} lines=${log} title=${logTitle} />

      ${busy ? html`<${Box} marginTop=${1}><${Text} color="yellow">${busy}<//><//>` : null}
      ${!busy && msg ? html`<${Box} marginTop=${1}><${Text} color="yellow">${msg}<//><//>` : null}

      <${Box} marginTop=${1}><${Text} color="gray">${hints}<//><//>
      <${Box}>
        <${Text} color="gray" dimColor>${"every panel here is also `hydra <name> --json` for agents"}<//>
      <//>
    <//>`;
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
