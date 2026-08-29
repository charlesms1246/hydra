/**
 * The hydra TUI.
 *
 * Every panel renders data from @hydra/core — the same functions the agent
 * commands call. A number the TUI shows and a number `hydra status --json`
 * returns come from one place, so they cannot disagree.
 */

import { render, Box, Text, useApp, useInput, useStdin } from "ink";
import { html, React } from "./ui.mjs";
import { Services, Wallets, Activity, Tools } from "./panels.mjs";
import { status } from "../../core/src/services.mjs";
import { wallets, faucet } from "../../core/src/wallets.mjs";
import { latestBlocks } from "../../core/src/chain.mjs";
import { check } from "../../cli/src/doctor.mjs";

const { useState, useEffect, useCallback } = React;

const TABS = [
  ["s", "status", "Services"],
  ["w", "wallets", "Wallets"],
  ["a", "activity", "Activity"],
  ["t", "tools", "Tools"],
];

const POLL_MS = 2000;

function App() {
  const { exit } = useApp();
  // An agent or a pipe gets no raw mode. Render the panels and say so rather
  // than crashing — the same data is available as `hydra <name> --json`.
  const { isRawModeSupported } = useStdin();
  const [tab, setTab] = useState("status");
  const [svc, setSvc] = useState(null);
  const [wal, setWal] = useState(null);
  const [blk, setBlk] = useState(null);
  const [doc, setDoc] = useState(null);
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState("");

  const refresh = useCallback(async () => {
    setSvc(await status().catch(() => null));
    if (tab === "wallets") setWal(await wallets().catch(() => null));
    if (tab === "activity") setBlk(await latestBlocks(10).catch(() => null));
    if (tab === "tools" && !doc) {
      try { setDoc({ rows: check() }); } catch { setDoc({ rows: [] }); }
    }
  }, [tab, doc]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) return exit();
    const hit = TABS.find(([k]) => k === input);
    if (hit) { setTab(hit[1]); setMsg(""); return; }
    if (input === "r") { setMsg("refreshing…"); refresh().then(() => setMsg("")); return; }
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
  }, { isActive: isRawModeSupported });

  const running = svc?.devnet.up;

  return html`
    <${Box} flexDirection="column" paddingX=${1}>
      <${Box} justifyContent="space-between">
        <${Text} bold>${"hydra"}<//>
        <${Text} color=${running ? "green" : "gray"}>
          ${running ? "stack up" : "no stack"}
        <//>
      <//>

      <${Box} marginTop=${1}>
        ${TABS.map(([k, id, label]) => html`
          <${Box} key=${id} marginRight=${2}>
            <${Text} color=${tab === id ? "cyan" : "gray"} bold=${tab === id}>
              ${"["}${k}${"] "}${label}
            <//>
          <//>`)}
      <//>

      <${Box} marginTop=${1} flexDirection="column" minHeight=${12}>
        ${tab === "status" ? html`<${Services} s=${svc} />` : null}
        ${tab === "wallets" ? html`<${Wallets} w=${wal} selected=${sel} />` : null}
        ${tab === "activity" ? html`<${Activity} b=${blk} />` : null}
        ${tab === "tools" ? html`<${Tools} d=${doc} />` : null}
      <//>

      ${msg ? html`<${Box}><${Text} color="yellow">${msg}<//><//>` : null}

      <${Box} marginTop=${1}>
        <${Text} color="gray">
          ${isRawModeSupported
            ? "r refresh · q quit" + (tab === "wallets" ? " · ↑↓ select · f fund" : "")
            : "no tty — keys disabled; use `hydra <name> --json`"}
        <//>
      <//>
      <${Box}>
        <${Text} color="gray" dimColor>
          ${"every panel here is also `hydra <name> --json` for agents"}
        <//>
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
