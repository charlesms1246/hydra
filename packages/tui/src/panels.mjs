/**
 * The rig: services, wallets, activity, tools — plus the confirm prompt, the log
 * and the help overlay.
 *
 * Ink requires every string to sit inside <Text>. A bare "${" "}" as a Box child
 * throws at render, so each row keeps its label in one Text and its value in
 * another — no loose strings between elements.
 *
 * Every pane is one object of the shape { title, items, row, detail }. That shape
 * is the point: a pane physically cannot render detail at list level, which is
 * what kept `blocks[].txs`, `balances[sym].raw`, txStatus() and the second line
 * of a doctor hint off the screen before. `enter` descends, `esc` ascends.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C, glyph, tone } from "./theme.mjs";
import { Frame, List, wrap, windowOf, indicatorFor } from "./layout.mjs";
import { Legend } from "./disclosure.mjs";
import { fixable } from "../../core/src/install.mjs";

const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);

/** Two columns, for every detail view. */
const Field = ({ k, v, color, w }) => html`
  <${Box}>
    <${Box} width=${16}><${Text} color=${C.muted}>${" " + k}<//><//>
    <${Text} color=${color}>${String(v ?? "—").slice(0, Math.max(1, w - 18))}<//>
  <//>`;

// ---------------------------------------------------------------------------
// services
// ---------------------------------------------------------------------------

const servicesPane = {
  id: "services",
  title: (s) => (s?.stack ? `rig · services · pool ${String(s.stack.poolAddress).slice(0, 14)}…` : "rig · services"),
  right: (s) => (s?.devnet?.up ? "stack up" : "no stack"),
  notice: (s) => (s === undefined ? "loading…" : s === null ? "status() failed — r retries" : null),
  items: (s) => {
    if (!s) return [];
    const sk = s.agents.skills;
    return [
      { name: "devnet", up: s.devnet.up, value: s.devnet.up ? s.devnet.url : (s.devnet.reason ?? "down"),
        note: s.devnet.up && s.devnet.blockNumber !== null ? `block ${s.devnet.blockNumber}` : null,
        detail: { url: s.devnet.url, chainId: s.devnet.chainId, block: s.devnet.blockNumber,
          pid: s.devnet.pid, "pid alive": String(s.devnet.pidAlive), reason: s.devnet.reason } },
      { name: "indexer", up: s.indexer.up && s.indexer.healthy, warn: s.indexer.up,
        value: s.indexer.up ? s.indexer.url : (s.indexer.reason ?? "down"),
        note: s.indexer.up
          ? `lag ${s.indexer.lagSecs ?? "?"}s${s.indexer.healthy ? "" : " · idle, not down"}`
          : null,
        detail: { url: s.indexer.url, status: s.indexer.status, block: s.indexer.blockNumber,
          "lag secs": s.indexer.lagSecs, pid: s.indexer.pid, "pid alive": String(s.indexer.pidAlive) } },
      // The old panel hard-coded up=false warn=true and the literal
      // "no proving URL needed" here. status() already carries prover.note;
      // rendering it is how the TUI and `hydra status --json` stay one sentence.
      { name: "prover", up: false, warn: true, value: s.prover.mode, note: s.prover.note,
        detail: { mode: s.prover.mode, note: s.prover.note } },
      { name: "mcp", up: s.agents.mcp.present, value: s.agents.mcp.present ? "present" : "missing",
        detail: { path: s.agents.mcp.path } },
      { name: "skills", up: sk.installed.length === sk.expected.length, warn: sk.installed.length > 0,
        value: `${sk.installed.length}/${sk.expected.length} installed`,
        detail: { dir: sk.dir, installed: sk.installed.join(", ") || "none", expected: sk.expected.join(", ") } },
      { name: "accounts", up: (s.accounts ?? []).length > 0, value: `${(s.accounts ?? []).length} funded`,
        detail: Object.fromEntries((s.accounts ?? []).map((a) => [a.name, a.address])) },
    ];
  },
  row: (it, i, sel, w) => html`
    <${Box} key=${it.name}>
      <${Box} width=${2}><${Text} color=${C.accent}>${sel ? "▸" : " "}<//><//>
      <${Box} width=${10}><${Text} color=${C.muted}>${it.name}<//><//>
      <${Box} width=${2}><${Text} color=${tone(it.up, it.warn)}>${glyph(it.up, it.warn)}<//><//>
      <${Text} color=${sel ? C.accent : undefined}>${pad(it.value, Math.max(1, w - 16))}<//>
    <//>`,
  detail: (it, s, w) => [
    ...Object.entries(it.detail ?? {}).map(([k, v]) => html`<${Field} key=${k} k=${k} v=${v} w=${w} />`),
    html`<${Text} key="src">${" "}<//>`,
    html`<${Text} key="src2" color=${C.muted} dimColor>
      ${"  status() — packages/core/src/services.mjs:30, the object `hydra status --json` prints"}<//>`,
  ],
};

// ---------------------------------------------------------------------------
// wallets
// ---------------------------------------------------------------------------

const walletsPane = {
  id: "wallets",
  title: () => "rig · wallets",
  right: (w) => (w?.available ? "f funds the selected account" : ""),
  notice: (w) => (w === undefined ? "loading…" : w === null ? "wallets() failed — r retries"
    : !w.available ? `${w.reason} · u starts one` : null),
  items: (w) => (w?.available ? w.wallets : []),
  row: (x, i, sel, w) => html`
    <${Box} key=${x.name}>
      <${Box} width=${2}><${Text} color=${C.accent}>${sel ? "▸" : " "}<//><//>
      <${Box} width=${9}><${Text} color=${sel ? C.accent : undefined}>${x.name}<//><//>
      <${Box} width=${20}><${Text} color=${C.muted}>${x.address.slice(0, 18) + "…"}<//><//>
      <${Text}>${Object.entries(x.balances).map(([sym, b]) => `${b.formatted ?? "?"} ${sym}`).join("   ").slice(0, Math.max(1, w - 33))}<//>
    <//>`,
  // balances[sym].raw is fetched on every poll and was never shown. A formatted
  // balance rounds to four places; the raw u256 is the number the chain has.
  detail: (x, _w, width) => [
    html`<${Field} key="n" k="name" v=${x.name} w=${width} />`,
    html`<${Field} key="a" k="address" v=${x.address} w=${width} />`,
    html`<${Text} key="b">${" "}<//>`,
    ...Object.entries(x.balances).flatMap(([sym, b]) => [
      html`<${Field} key=${sym} k=${sym} v=${b.formatted ?? "?"} w=${width} />`,
      html`<${Field} key=${sym + "r"} k="  raw" v=${b.raw ?? "null"} color=${C.muted} w=${width} />`,
    ]),
  ],
};

// ---------------------------------------------------------------------------
// activity — the only pane three levels deep
// ---------------------------------------------------------------------------

const activityPane = {
  id: "activity",
  title: () => "rig · activity",
  right: (b) => (b?.available ? `head #${b.head}` : ""),
  notice: (b) => (b === undefined ? "loading…" : b === null ? "latestBlocks() failed — r retries"
    : !b.available ? `${b.reason} · u starts one` : !b.blocks.length ? "no blocks yet" : null),
  items: (b) => (b?.available ? b.blocks : []),
  row: (x, i, sel, w) => html`
    <${Box} key=${x.number}>
      <${Box} width=${2}><${Text} color=${C.accent}>${sel ? "▸" : " "}<//><//>
      <${Box} width=${9}><${Text} color=${C.accent}>${"#" + x.number}<//><//>
      <${Box} width=${8}><${Text} color=${x.txCount ? undefined : C.muted}>${x.txCount + " tx"}<//><//>
      <${Box} width=${18}><${Text} color=${C.muted}>${(x.status ?? "—")}<//><//>
      <${Text} color=${C.muted}>${x.hash.slice(0, Math.max(4, w - 39))}${"…"}<//>
    <//>`,
  /** Level 1: the block, with its tx hashes as a selectable sub-list. */
  subItems: (x) => x.txs ?? [],
  detail: (x, _d, width, sub = 0) => [
    html`<${Field} key="n" k="block" v=${"#" + x.number} w=${width} />`,
    html`<${Field} key="h" k="hash" v=${x.hash} w=${width} />`,
    html`<${Field} key="s" k="status" v=${x.status} w=${width} />`,
    html`<${Field} key="t" k="transactions" v=${x.txCount} w=${width} />`,
    html`<${Text} key="sp">${" "}<//>`,
    ...(x.txs ?? []).map((h, i) => html`
      <${Box} key=${h}>
        <${Box} width=${4}><${Text} color=${C.accent}>${i === sub ? "  ▸" : " "}<//><//>
        <${Text} color=${i === sub ? C.accent : C.muted}>${h.slice(0, Math.max(8, width - 8))}<//>
      <//>`),
    html`<${Text} key="hint" color=${C.muted} dimColor>
      ${"  enter on a hash runs txStatus() for it · esc goes up one level"}<//>`,
  ],
  /** Level 2: the receipt. txStatus() ships as `hydra tx` and the TUI never called it. */
  detail2: (x, hash, receipt, width) => {
    if (!receipt) return [html`<${Text} key="l" color=${C.muted}>${"  fetching the receipt…"}<//>`];
    if (!receipt.found) {
      return [
        html`<${Field} key="h" k="hash" v=${hash} w=${width} />`,
        html`<${Field} key="e" k="not found" v=${receipt.error ?? receipt.reason} color=${C.warn} w=${width} />`,
      ];
    }
    return [
      html`<${Field} key="h" k="hash" v=${receipt.hash} w=${width} />`,
      html`<${Field} key="f" k="finality" v=${receipt.finality} w=${width} />`,
      html`<${Field} key="x" k="execution" v=${receipt.execution}
        color=${receipt.execution === "SUCCEEDED" ? C.ok : C.bad} w=${width} />`,
      html`<${Field} key="b" k="block" v=${receipt.blockNumber} w=${width} />`,
      html`<${Field} key="a" k="actual fee" v=${JSON.stringify(receipt.actualFee)} w=${width} />`,
      html`<${Field} key="e2" k="events" v=${receipt.events} w=${width} />`,
      html`<${Field} key="r" k="revert" v=${receipt.revertReason ?? "—"} w=${width} />`,
      html`<${Text} key="sp">${" "}<//>`,
      html`<${Text} key="src" color=${C.muted} dimColor>
        ${"  txStatus() — packages/core/src/chain.mjs:28-45, the same object `hydra tx` prints."}<//>`,
      html`<${Text} key="src2" color=${C.muted} dimColor>
        ${"  events is a COUNT, not decoded events — it cannot verify a disclosure report."}<//>`,
    ];
  },
};

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const toolsPane = {
  id: "tools",
  title: (d) => {
    if (!d) return "rig · tools";
    const ok = d.rows.filter((r) => r.status.trim() === "ok").length;
    const warn = d.rows.filter((r) => r.status.trim() === "WARN").length;
    return `rig · tools · ${ok} ok · ${warn} warn · ${d.rows.length - ok - warn} missing`;
  },
  right: (d) => (d ? `${fixable(d.rows).length} fixable` : "scanning toolchain…"),
  notice: (d) => (d === undefined ? "scanning toolchain… (check() is synchronous and blocks the render loop)"
    : d === null ? "doctor check() failed — r retries" : d.error ? `doctor failed: ${d.error}` : null),
  items: (d) => d?.rows ?? [],
  row: (r, i, sel, w) => {
    const st = r.status.trim();
    const canFix = st !== "ok" && r.cmd;
    return html`
      <${Box} key=${r.name}>
        <${Box} width=${2}><${Text} color=${C.accent}>${sel ? "▸" : " "}<//><//>
        <${Box} width=${3}>
          <${Text} color=${st === "ok" ? C.ok : st === "WARN" ? C.warn : C.bad}>
            ${st === "ok" ? "●" : st === "WARN" ? "◐" : "○"}<//>
        <//>
        <${Box} width=${Math.min(29, Math.max(12, w - 45))}>
          <${Text} color=${sel ? C.accent : undefined}>${r.name}<//>
        <//>
        <${Box} width=${17}><${Text} color=${C.muted}>${"want " + String(r.want).slice(0, 11)}<//><//>
        <${Box} width=${12}><${Text} color=${st === "ok" ? C.muted : C.warn}>${r.got}<//><//>
        <${Text} color=${canFix ? "magenta" : C.muted}>${canFix ? "fixable" : ""}<//>
      <//>`;
  },
  // The whole hint, not `.split("\n")[0]`. The upstream-checkout row's second
  // line is "then set HYDRA_UPSTREAM=<dir>" — the half that tells you what to do.
  detail: (r, _d, width) => [
    html`<${Field} key="n" k="row" v=${r.name} w=${width} />`,
    html`<${Field} key="s" k="status" v=${r.status.trim()}
      color=${r.status.trim() === "ok" ? C.ok : C.warn} w=${width} />`,
    html`<${Field} key="w" k="want" v=${r.want} w=${width} />`,
    html`<${Field} key="g" k="got" v=${r.got} w=${width} />`,
    html`<${Text} key="sp">${" "}<//>`,
    html`<${Text} key="hl" color=${C.muted}>${"  hint"}<//>`,
    ...wrap(String(r.hint ?? "no hint"), width - 6).map((l, i) =>
      html`<${Text} key=${"h" + i}>${"    " + l}<//>`),
    html`<${Text} key="sp2">${" "}<//>`,
    r.cmd
      ? html`<${Field} key="c" k="fix cmd" v=${r.cmd} color=${C.warn} w=${width} />`
      : html`<${Field} key="c" k="fix cmd" v="none — this one needs a human" color=${C.muted} w=${width} />`,
    r.cmd ? html`<${Field} key="cw" k="in" v=${r.cwd ?? process.cwd()} w=${width} />` : null,
  ].filter(Boolean),
};

/**
 * The rows a pane is actually showing. Exported because `enter` and `i` index
 * into this list, not into the unfiltered one — with `/` open they are different
 * lists, and acting on the wrong one runs a fix for a row you cannot see.
 */
export function visibleItems(pane, data, filter) {
  if (!pane || pane.notice(data)) return [];
  const all = pane.items(data) ?? [];
  if (!filter?.text) return all;
  const q = filter.text.toLowerCase();
  return all.filter((it) => JSON.stringify(it).toLowerCase().includes(q));
}

export const PANES = {
  services: servicesPane,
  wallets: walletsPane,
  activity: activityPane,
  tools: toolsPane,
};

/**
 * The rig overlay. Replaces the region between the config line and the status
 * line — Ink 5 cannot z-layer, so the header, config, status and footer stay put
 * and you are never lost.
 */
export const Rig = ({ pane, data, nav, width, height, filter, receipt }) => {
  const interior = width - 2;
  const notice = pane.notice(data);
  const items = visibleItems(pane, data, filter);
  const sel = Math.min(nav.sel[0] ?? 0, Math.max(0, items.length - 1));
  const body = height - 2;

  if (notice) {
    return html`
      <${Frame} width=${width} height=${height} focused=${true} title=${pane.title(data)} right=${pane.right(data)}>
        <${Text} color=${C.warn}>${" " + notice.slice(0, interior - 1)}<//>
        ${Array.from({ length: Math.max(0, body - 1) }, (_, i) =>
          html`<${Text} key=${"b" + i}>${" "}<//>`)}
      <//>`;
  }

  if (nav.level >= 1 && items[sel]) {
    const item = items[sel];
    const rows =
      nav.level === 2 && pane.detail2
        ? pane.detail2(item, (pane.subItems?.(item) ?? [])[nav.sel[1] ?? 0], receipt, interior)
        : pane.detail(item, data, interior, nav.sel[1] ?? 0);
    const shown = rows.slice(0, body);
    return html`
      <${Frame} width=${width} height=${height} focused=${true}
        title=${`${pane.title(data)} › ${String(item.name ?? item.number ?? sel)}`}
        right="esc goes back">
        ${shown}
        ${Array.from({ length: Math.max(0, body - shown.length) }, (_, i) =>
          html`<${Text} key=${"d" + i}>${" "}<//>`)}
      <//>`;
  }

  const { start, end } = windowOf(items.length, sel, body);
  return html`
    <${Frame} width=${width} height=${height} focused=${true}
      title=${pane.title(data) + (filter?.text ? ` · /${filter.text}${filter.typing ? "_" : ""}` : "")}
      right=${`${indicatorFor(items.length, start, end)} · ${pane.right(data)}`}>
      <${List} items=${items} selected=${sel} height=${body}
        emptyText=${filter?.text ? `nothing matches /${filter.text} — esc clears it` : "nothing here"}
        renderRow=${(it, i, on) => pane.row(it, i, on, interior)} />
    <//>`;
};

/**
 * Shared output pane — stack startup, fix commands and transaction progress all
 * stream here, each line with a severity glyph. LOG_MAX keeps 200 lines and the
 * old pane showed `slice(-8)`, so 192 lines of scarb output were held in memory
 * and unreachable by any keystroke. This is a real viewport over all of them,
 * wrapped to the terminal width rather than a hardcoded 92.
 */
export const LogPane = ({ lines, title, width, height, selected, filter }) => {
  const interior = (width ?? 94) - 2;
  const all = (lines ?? []).map((l) => (typeof l === "string" ? { text: l, sev: "info" } : l));
  const shown = filter?.text
    ? all.filter((l) => l.text.toLowerCase().includes(filter.text.toLowerCase()))
    : all;
  const body = Math.max(1, (height ?? 10) - 2);
  const sel = Math.min(selected ?? Math.max(0, shown.length - 1), Math.max(0, shown.length - 1));
  const { start, end } = windowOf(shown.length, sel, body);
  const win = shown.slice(start, end);
  return html`
    <${Frame} width=${width ?? 94} height=${height ?? 10} focused=${true}
      title=${`log · ${title || "hydra"}${filter?.text ? ` · /${filter.text}${filter.typing ? "_" : ""}` : ""}`}
      right=${`${indicatorFor(shown.length, start, end)} · / filter · G end`}>
      ${win.map((l, i) => {
        const sev = l.sev === "warn" ? C.warn : l.sev === "bad" ? C.bad : C.muted;
        return html`
          <${Box} key=${start + i}>
            <${Box} width=${2}>
              <${Text} color=${sev}>${l.sev === "warn" ? "!" : l.sev === "bad" ? "x" : " "}<//>
            <//>
            <${Text} color=${start + i === sel ? undefined : sev}>
              ${l.text.slice(0, interior - 2)}<//>
          <//>`;
      })}
      ${Array.from({ length: Math.max(0, body - win.length) }, (_, i) =>
        html`<${Text} key=${"lp" + i}>${" "}<//>`)}
    <//>`;
};

/**
 * One confirm component for every irreversible thing: a doctor fix and a real
 * transaction ask the same way. Descending into something that touches the world
 * asks first — one rule, not two.
 */
export const Confirm = ({ c, width }) => html`
  <${Box} flexDirection="column" marginTop=${1}>
    <${Text} color=${C.warn}>${"  " + c.prompt}<//>
    ${c.cmd ? html`<${Box} marginLeft=${4}><${Text}>${("$ " + c.cmd).slice(0, width - 6)}<//><//>` : null}
    ${c.cwd ? html`<${Box} marginLeft=${4}><${Text} color=${C.muted}>${("in " + c.cwd).slice(0, width - 6)}<//><//>` : null}
    ${(c.lines ?? []).map((l, i) =>
      html`<${Box} key=${i} marginLeft=${4}><${Text} color=${C.muted}>${l.slice(0, width - 6)}<//><//>`)}
    ${c.legend ? html`<${Legend} width=${width} />` : null}
    <${Text} color=${C.warn}>${"  y run · n cancel"}<//>
  <//>`;

/** The run menu. Each flow carries the leak action type it maps to. */
export const Transact = ({ actions, selected, width, height }) => {
  const body = Math.max(1, (height ?? 8) - 2);
  return html`
    <${Frame} width=${width} height=${height ?? 8} focused=${true} title="x · run a flow"
      right="each one confirms before it runs">
      <${List} items=${actions} selected=${selected} height=${body - 1}
        renderRow=${(a, i, on) => html`
          <${Box} key=${a.id}>
            <${Box} width=${2}><${Text} color=${C.accent}>${on ? "▸" : " "}<//><//>
            <${Box} width=${Math.min(46, width - 30)}>
              <${Text} color=${on ? C.accent : undefined}>${a.label}<//>
            <//>
            <${Text} color=${C.muted}>${a.leak ? `leak action: ${a.leak.type}` : a.note ?? ""}<//>
          <//>`} />
      <${Text} color=${C.muted}>${"  enter previews the disclosure this flow will produce, then y runs it"}<//>
    <//>`;
};

/**
 * Generated from keymap.mjs. A binding cannot exist undocumented — and, since the
 * table outgrew the screen, cannot be off screen either: this is a real viewport
 * over all of them. It used to slice off the tail and print "+23 more — a taller
 * terminal shows them", which at 80x24 hid 23 of 39 bindings behind a terminal
 * the reader may not have, while README claimed `?` lists every key.
 */
export const Help = ({ groups, width, height, selected = 0 }) => {
  const rows = [];
  for (const g of groups) {
    for (const [i, r] of g.rows.entries()) {
      rows.push({ scope: i === 0 ? g.title : "", keys: r.keys, label: r.label });
    }
  }
  const body = Math.max(1, (height ?? 20) - 2);
  const sel = Math.min(Math.max(0, selected), Math.max(0, rows.length - 1));
  const { start, end } = windowOf(rows.length, sel, body);
  const shown = rows.slice(start, end);
  return html`
    <${Frame} width=${width} height=${height} focused=${true} title="? keys"
      right=${`${indicatorFor(rows.length, start, end)} · jk scrolls · g G ends`}>
      ${shown.map((r, i) => html`
        <${Box} key=${start + i}>
          <${Box} width=${10}><${Text} color=${C.accent}>${" " + r.scope}<//><//>
          <${Box} width=${14}><${Text} color=${start + i === sel ? C.accent : undefined}>${r.keys}<//><//>
          <${Text} color=${C.muted}>${r.label.slice(0, Math.max(1, width - 28))}<//>
        <//>`)}
      ${Array.from({ length: Math.max(0, body - shown.length) }, (_, i) =>
        html`<${Text} key=${"hp" + i}>${" "}<//>`)}
    <//>`;
};

// The five names the previous panels.mjs exported, kept so `hydra` consumers and
// the existing render tests keep working. Each is now the pane contract rendered
// at list level, which is the only place list rendering can happen.
const paneOnly = (pane) => ({ data, selected = 0, width = 96, height = 12 }) =>
  html`<${Rig} pane=${pane} data=${data} nav=${{ level: 0, sel: [selected] }}
    width=${width} height=${height} />`;

export const Services = ({ s, selected, width, height }) =>
  paneOnly(servicesPane)({ data: s === null ? null : s, selected, width, height });
export const Wallets = ({ w, selected, width, height }) =>
  paneOnly(walletsPane)({ data: w === null ? null : w, selected, width, height });
export const Activity = ({ b, selected, width, height }) =>
  paneOnly(activityPane)({ data: b === null ? null : b, selected, width, height });
export const Tools = ({ d, selected, width, height }) =>
  paneOnly(toolsPane)({ data: d === null ? null : d, selected, width, height });
