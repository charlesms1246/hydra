/**
 * The About page — what this tool is, why it exists, and how to drive it.
 *
 * It replaces the Keys page rather than sitting beside it, because a bare list of
 * 36 bindings answers the second question a new reader has and never the first.
 * The keymap is still here, generated from BINDINGS so it cannot go stale, as one
 * section among several.
 *
 * Sections are a second nav bar, drawn by the same `Bar` as the main one. It used
 * to have its own idiom — an underline where the main nav paints a solid cell —
 * which taught a selection vocabulary that appeared on exactly one page. `tab`
 * cycles them: the main nav already owns `a`/`d` and the arrows, and a page-local
 * nav that stole them would make the same key mean two things depending on which
 * page you were on.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C } from "./theme.mjs";
import { Bar } from "./chrome.mjs";
import { BINDINGS, helpGroups } from "./keymap.mjs";

/** Every claim here is either about this tool, or cited. Nothing is asserted. */
const PROSE = {
  what: [
    ["h", "HYDRA"],
    ["", "A local STRK20 privacy stack, and tooling that computes what a transaction"],
    ["", "actually discloses."],
    ["", ""],
    ["", "Building on StarkWare's Starknet privacy pool normally means pointing at two"],
    ["", "hosted services you do not control. HYDRA runs the whole thing locally —"],
    ["", "devnet, the pool deployed from source, funded accounts, a real local discovery"],
    ["", "service — and then tells you, per transaction and per configuration, exactly"],
    ["", "who learns what."],
    ["", ""],
    ["d", "Nothing it reports is asserted. Every claim is computed from the pool source"],
    ["d", "or measured, and carries a file:line citation."],
    ["", ""],
    ["h", "The packages"],
    ["k", "core     every operation as a plain function returning plain data"],
    ["k", "cli      the command surface — hydra-dev up, doctor, bootstrap, leak"],
    ["k", "tui      this program"],
    ["k", "leak     what_does_this_leak(tx) — the disclosure set, per party and field"],
    ["k", "linter   flags SDK configurations that disclose more than intended"],
    ["k", "mcp      an MCP server exposing endpoints, environment, lint and pool state"],
  ],
  finding: [
    ["h", "Why this exists"],
    ["", "Three questions were asked of the STRK20 design. All three were answered by"],
    ["", "reading upstream source, and they compose into one claim:"],
    ["", ""],
    ["w", "A default-path STRK20 user discloses a permanent, unscoped, unrevocable root"],
    ["w", "decryption key to at least two third parties."],
    ["", ""],
    ["h", "The auditor"],
    ["", "At registration the pool encrypts your private viewing key to an auditor key"],
    ["", "held in contract storage. It is mandatory, cannot be opted out of or"],
    ["", "substituted, and is write-once. This is true of every STRK20 integration, so"],
    ["", "this tool states it on every run rather than leaving it to documentation."],
    ["k", "upstream: packages/privacy/src/privacy.cairo:319-345"],
    ["", ""],
    ["h", "The discovery service"],
    ["", "The SDK's documented path posts the user's PRIVATE viewing key to a remote"],
    ["", "host, which decrypts server-side — and the documented happy path builds that"],
    ["", "provider with OHTTP off."],
    ["k", "upstream: sdk/src/internal/indexer-discovery.ts:160, sdk/src/factory.ts:108"],
    ["", ""],
    ["d", "Findings and two prepared upstream patches are held pending private contact"],
    ["d", "with StarkWare, and are not published here."],
  ],
  start: [
    ["h", "Getting started"],
    ["k", "hydra-dev doctor      verify the toolchain — it says how to fix whatever is missing"],
    ["k", "hydra-dev bootstrap   install node dependencies"],
    ["k", "hydra-dev up          devnet + pool + funded accounts + local discovery service"],
    ["k", "hydra             this program"],
    ["", ""],
    ["", "doctor is the honest starting point. It needs no dependencies itself, so it"],
    ["", "works before bootstrap does, and it prints the exact command for anything"],
    ["", "missing rather than telling you something is wrong."],
    ["", ""],
    ["h", "From in here"],
    ["k", "u    start the stack — output streams into the Log page"],
    ["k", "p    stop it, from recorded pids, even with devnet already gone"],
    ["k", "r    refresh this page's data now"],
    ["k", "q    quit — asks what to do with a running stack"],
    ["", ""],
    ["h", "Quitting"],
    ["", "A stack this program started is a devnet, a discovery service and a control"],
    ["", "API. Leaving them up is right when you are about to run `hydra-dev status` or a"],
    ["", "test, and wrong when you are done — so quitting asks rather than assuming."],
  ],
  agents: [
    ["h", "For agents"],
    ["", "Every page that reads is also a command, and every command takes --json:"],
    ["k", "hydra-dev leak      the disclosure matrix (the Disclosure page)"],
    ["k", "hydra-dev status    the stack (the Overview's stack block)"],
    ["k", "hydra-dev wallets   accounts and balances"],
    ["k", "hydra-dev blocks    recent chain activity"],
    ["k", "hydra-dev doctor    the toolchain rows"],
    ["", ""],
    ["", "Human output is a rendering of the same object, so this program and an agent"],
    ["", "cannot disagree — both read the same functions in packages/core."],
    ["", ""],
    ["h", "MCP"],
    ["", "packages/mcp is a stdio MCP server over the same code: endpoint resolution,"],
    ["", "environment checks, config linting, live pool state, what_does_this_leak, and"],
    ["", "a guarded stack-control surface. Its side-effecting tools take a confirmation"],
    ["", "that cannot be given by accident."],
    ["", ""],
    ["h", "Skills"],
    ["", "packages/skills holds agent skills for the pool's flows and for reasoning"],
    ["", "about disclosure. `node packages/skills/install.mjs` copies them into"],
    ["", ".agents/skills/. The Tools page reports whether they are installed."],
  ],
  safety: [
    ["h", "What this program will and will not do"],
    ["", ""],
    ["w", "It never modifies the pool contract."],
    ["", "Fixes go upstream. This tool compiles, deploys and measures; it does not edit"],
    ["", "Cairo."],
    ["", ""],
    ["w", "It shows the command before it runs it."],
    ["", "Every fix and every flow is confirmed first, with the exact command and its"],
    ["", "working directory on screen. Some of them are `curl … | sh` against a"],
    ["", "third-party host, which is precisely why you get to read them."],
    ["", ""],
    ["w", "It never claims privacy."],
    ["", "No value in the disclosure vocabulary means \"private\". not-by-tx is scoped to"],
    ["", "one transaction and says nothing about correlation across transactions,"],
    ["", "off-chain side channels, or any party's prior knowledge. UNKNOWN is never"],
    ["", "rendered as a pass."],
    ["k", "packages/leak/src/facts.mjs:25-33"],
    ["", ""],
    ["w", "The auditor row is always shown."],
    ["", "On every report, for every action, in every configuration."],
  ],
};

const SECTIONS = [
  { id: "what", label: "What it is", short: "What" },
  { id: "finding", label: "Why it exists", short: "Why" },
  { id: "start", label: "Getting started", short: "Start" },
  { id: "keys", label: "Keys", short: "Keys" },
  { id: "agents", label: "Agents & MCP", short: "Agents" },
  { id: "safety", label: "Safety", short: "Safe" },
];

export const SECTION_COUNT = SECTIONS.length;

const TONE = { h: C.accent, w: C.warn, k: C.ok, d: C.muted, "": undefined };

/** The keymap section, generated so it cannot drift from the table. */
function keyLines(width) {
  const out = [["h", "Every key, and none of them needs a modifier"]];
  const keyW = Math.max(...BINDINGS.map((b) => b.keys.join(" / ").length)) + 2;
  for (const g of helpGroups()) {
    // No blank line before each header. At 51 bindings the separators alone were 13
    // rows — half a column — and the headers are already accented and bold.
    out.push(["h", g.title]);
    for (const r of g.rows) {
      out.push(["k2", r.keys.padEnd(keyW) + r.label.slice(0, Math.max(0, width - keyW - 2))]);
    }
  }
  return out;
}

/** The section bar — the main nav's component, so the two cannot drift apart. */
const SectionBar = ({ width, selected }) => html`
  <${Box} width=${width}>
    <${Bar} width=${width - 8} items=${SECTIONS} active=${SECTIONS[selected]?.id} />
    <${Box} flexGrow=${1} />
    <${Text} color=${C.muted}>${"tab \u2192 "}<//>
  <//>`;

export const About = ({ width, height, section = 0 }) => {
  const sec = SECTIONS[section] ?? SECTIONS[0];
  const bodyW = sec.id === "keys" ? Math.max(24, Math.floor(width / Math.max(1, Math.floor(width / 36)))) : width;
  const lines = sec.id === "keys" ? keyLines(bodyW) : PROSE[sec.id] ?? [];
  const bodyRows = Math.max(1, height - 2);

  // Columns, not scrolling. The keys section is ~60 lines and the tallest common
  // terminal gives about 26, so it has to divide or it silently shows half of
  // itself — which is the failure the old help overlay had.
  // 44 was tuned for 36 bindings; the table has grown, so the keys section needs
  // a narrower column before it starts dropping rows.
  // 38 was tuned for 40 bindings; the table keeps growing, so the keys section
  // needs a narrower column before it starts dropping rows.
  const maxCols = Math.max(1, Math.floor(width / 36));
  const nCols = Math.max(1, Math.min(maxCols, Math.ceil(lines.length / bodyRows)));
  const colW = Math.floor(width / nCols);
  const perCol = nCols === 1 ? bodyRows : Math.ceil(lines.length / nCols);
  const columns = Array.from({ length: nCols }, (_, i) =>
    lines.slice(i * perCol, Math.min(lines.length, (i + 1) * perCol)));
  const shown = columns.reduce((n, c) => n + c.length, 0);

  return html`
    <${Box} flexDirection="column" width=${width} height=${height} overflow="hidden">
      <${SectionBar} width=${width} selected=${section} />
      <${Box}>
        ${columns.map((col, ci) => html`
          <${Box} key=${"c" + ci} flexDirection="column" width=${colW}>
            ${col.map(([kind, text], i) => html`
              <${Box} key=${"l" + i} width=${colW} height=${1}>
                <${Text} color=${kind === "k2" ? C.ok : TONE[kind]}
                  bold=${kind === "h"} wrap="truncate">
                  ${(kind === "k" || kind === "k2" ? "  " : " ") + text}<//>
              <//>`)}
          <//>`)}
      <//>
      <${Text} color=${C.muted}>
        ${shown < lines.length
          ? `  ${lines.length - shown} more lines — a taller terminal shows them`
          : `  ${section + 1} of ${SECTIONS.length} · tab for the next section`}
      <//>
    <//>`;
};
