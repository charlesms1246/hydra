/**
 * The overview dashboard — what a first run should open on.
 *
 * The screen this replaces opened on the disclosure matrix, which is the most
 * important thing this tool computes and the worst possible first screen: it
 * answers a question the reader has not asked yet, about a transaction that has
 * not happened. The matrix is still one keypress away, on its own page.
 *
 * Every block is a fixed rectangle sized by `plan()`, so the dashboard is exactly
 * as tall as the terminal and never one row more. Nothing scrolls; a block with
 * more rows than it has room for says how many it dropped, because a silently
 * truncated list reads as a complete one.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C, glyph, tone } from "./theme.mjs";
import { scaled } from "./logo.mjs";

const trunc = (s, w) =>
  String(s ?? "").length <= w ? String(s ?? "") : String(s ?? "").slice(0, Math.max(0, w - 1)) + "…";
const addr = (a) => (a ? `${String(a).slice(0, 8)}…${String(a).slice(-4)}` : "—");
const pad = (s, w) => trunc(s, w).padEnd(w);

/**
 * A titled rectangle of exact size.
 *
 * `height` includes both border rows. Children are padded to fill and clipped to
 * fit — the clipping is what holds the no-scroll guarantee when a list is longer
 * than its block, and it has to be here rather than at each call site because
 * every block does it.
 */
const Block = ({ w, h, title, right, rows, tone: titleTone = C.border }) => {
  const inner = Math.max(0, h - 2);
  const shown = rows.slice(0, inner);
  const blanks = Array.from({ length: Math.max(0, inner - shown.length) }, (_, i) => i);
  const dropped = rows.length - shown.length;
  const l = ` ${title} `;
  const r = dropped > 0 ? ` +${dropped} more ` : right ? ` ${right} ` : "";
  const fill = Math.max(0, w - 2 - l.length - r.length);
  return html`
    <${Box} flexDirection="column" width=${w} height=${h} overflow="hidden">
      <${Text} color=${titleTone}>${"┌" + l + "─".repeat(fill) + r + "┐"}<//>
      <${Box} flexDirection="column" width=${w} borderStyle="round" borderTop=${false}
        borderColor=${titleTone} overflow="hidden">
        ${shown.map((row, i) => html`<${Box} key=${"r" + i} width=${w - 2}>${row}<//>`)}
        ${blanks.map((i) => html`<${Text} key=${"p" + i}>${" "}<//>`)}
      <//>
    <//>`;
};

/** `label  ● value` — the shape every status row in here uses. */
const Row = ({ label, w, up, warn, value, valueColor }) =>
  html`<${Text} wrap="truncate">
    <${Text} color=${C.muted}>${label.padEnd(Math.min(10, Math.max(6, Math.floor(w * 0.35))))}<//>
    ${up === undefined ? null : html`<${Text} color=${tone(up, warn)}>${glyph(up, warn) + " "}<//>`}
    <${Text} color=${valueColor ?? undefined}>${trunc(value, Math.max(0, w - 13))}<//>
  <//>`;

/**
 * Row budget for the dashboard.
 *
 * Bands are sized to what they actually have to say and nothing is inflated to
 * consume the terminal. A 57-row terminal does not contain 57 rows of facts about
 * a three-account devnet, and a block padded to twice its content reads as broken
 * far more than a short frame does.
 *
 * The mark is shed first, then the standing note. Neither band of blocks is ever
 * dropped: a dashboard missing its wallets is not a smaller dashboard, it is a
 * broken one.
 */
export function plan(cols, rows, counts = {}) {
  // Three columns need roughly 32 each before the label gutter stops fitting.
  // Measured against the CONTENT width, which is the terminal less its padding.
  const wide = cols >= 96;
  const need = (n, min) => Math.max(min, n ?? min) + 2;
  // The tallest of the three columns, not the tooling one: stack and chain both
  // carry six rows, and sizing the band to the shortest is what made it drop them.
  const aRows = wide ? Math.max(6, counts.tooling ?? 6) : 12 + (counts.tooling ?? 6);
  const bandA = Math.min(need(aRows, 5), Math.max(7, rows - 7));
  const bandB = Math.min(
    need(Math.max(counts.wallets ?? 0, counts.activity ?? 0) + 1, 4),
    Math.max(6, rows - bandA - 5)
  );
  let room = rows - bandA - bandB;
  // The mark takes at most a third of the screen and only when the blocks have
  // already been given everything they asked for.
  const logo = room >= 9 ? Math.min(Math.floor(rows / 3), room - 4) : 0;
  room -= logo;
  const strip = rows < 18 ? 0 : room >= 8 ? 7 : room >= 3 ? 3 : 0;
  return { wide, logo, strip, bandA, bandB };
}

export const Overview = ({ cols, rows, svc, wal, blocks, doctor, ledger, control, note }) => {
  const counts = {
    tooling: 2 + (doctor?.rows ?? []).filter((r) => r.status.trim() !== "ok").length,
    wallets: wal?.available ? wal.wallets.length : 1,
    activity: ledger?.length || blocks?.blocks?.length || 1,
  };
  const { wide, logo, strip, bandA, bandB } = plan(cols, rows, counts);
  const third = Math.floor(cols / 3);
  const cols3 = wide ? [third, third, cols - 2 * third] : [cols];
  const half = Math.floor(cols * 0.46);
  const cols2 = wide ? [half, cols - half] : [cols];

  const dn = svc?.devnet;
  const ix = svc?.indexer;
  const st = svc?.stack;
  const mcp = svc?.agents?.mcp;
  const skills = svc?.agents?.skills;

  const stackRows = [
    html`<${Row} label="devnet" w=${cols3[0]} up=${Boolean(dn?.up)}
      value=${dn?.up ? `block ${dn.blockNumber ?? "?"}` : dn?.reason ?? "down"} />`,
    html`<${Row} label="indexer" w=${cols3[0]} up=${Boolean(ix?.up && ix?.healthy)} warn=${Boolean(ix?.up)}
      value=${ix?.up
        ? ix.healthy ? `lag ${ix.lagSecs ?? 0}s` : `lagging ${ix.lagSecs ?? "?"}s`
        : ix?.reason ?? "down"} />`,
    html`<${Row} label="prover" w=${cols3[0]} up=${false} warn=${true} value=${svc?.prover?.mode ?? "?"} />`,
    // status() carries no controlUrl; whether the control API answers is exactly
    // what transactAvailable() reports, and it is what "can I run a flow" means.
    html`<${Row} label="control" w=${cols3[0]} up=${Boolean(control)}
      value=${control ? "ready — x runs a flow" : "no stack"} />`,
    html`<${Row} label="mcp" w=${cols3[0]} up=${Boolean(mcp?.present)}
      value=${mcp?.present ? "server present" : "missing"} />`,
    html`<${Row} label="skills" w=${cols3[0]}
      up=${Boolean(skills && skills.installed.length === skills.expected.length)}
      warn=${Boolean(skills?.installed.length)}
      value=${skills ? `${skills.installed.length}/${skills.expected.length} installed` : "—"} />`,
  ];

  const chainRows = [
    html`<${Row} label="network" w=${cols3[1]}
      value=${dn?.chainId === "0x534e5f5345504f4c4941" ? "SN_SEPOLIA (devnet)" : dn?.chainId ?? "—"} />`,
    html`<${Row} label="pool" w=${cols3[1]} value=${addr(st?.poolAddress)} />`,
    html`<${Row} label="STRK" w=${cols3[1]} value=${addr(svc?.tokens?.STRK)} />`,
    html`<${Row} label="ETH" w=${cols3[1]} value=${addr(svc?.tokens?.ETH)} />`,
    html`<${Row} label="block" w=${cols3[1]} value=${dn?.blockNumber ?? "—"} />`,
    html`<${Row} label="started" w=${cols3[1]}
      value=${st?.startedAt ? String(st.startedAt).slice(11, 19) : "—"} />`,
  ];

  const rowsD = doctor?.rows ?? [];
  const okN = rowsD.filter((r) => r.status.trim() === "ok").length;
  const missN = rowsD.filter((r) => r.status.trim() === "MISS").length;
  const warnN = rowsD.filter((r) => r.status.trim() === "WARN").length;
  const toolRows = rowsD.length
    ? [
        html`<${Row} label="pinned" w=${cols3[2]} up=${missN === 0} warn=${missN === 0 && warnN > 0}
          value=${`${okN}/${rowsD.length} ok${missN ? ` · ${missN} missing` : ""}${warnN ? ` · ${warnN} warn` : ""}`} />`,
        ...rowsD
          .filter((r) => r.status.trim() !== "ok")
          .slice(0, 4)
          .map((r, i) =>
            html`<${Row} key=${"t" + i} label=${trunc(r.name, 10)} w=${cols3[2]}
              up=${false} warn=${r.status.trim() === "WARN"} value=${r.got} />`),
        missN === 0 && warnN === 0
          ? html`<${Text} color=${C.muted}>${"  every pin and artifact present"}<//>`
          : html`<${Text} color=${C.muted}>${"  t opens tools to fix them"}<//>`,
      ]
    : [html`<${Text} color=${C.muted}>${"  t opens tools to scan"}<//>`];

  // A table, not a list: three accounts with two balances each only reads at a
  // glance if the columns line up, and `formatted` is already fixed-precision.
  const wCols = (() => {
    const w = cols2[0] - 2;
    const name = 8;
    // addr() is exactly 13 characters; anything narrower runs the balance into it.
    const address = Math.min(20, Math.max(15, Math.floor(w * 0.26)));
    const bal = Math.max(9, Math.floor((w - name - address - 2) / 2));
    return { name, address, bal };
  })();
  const walletRows = wal?.available
    ? [
        html`<${Text} key="wh" color=${C.muted} wrap="truncate">
          ${pad("account", wCols.name) + pad("address", wCols.address) +
            pad("STRK", wCols.bal) + pad("ETH", wCols.bal)}<//>`,
        ...wal.wallets.map((a, i) => html`
          <${Text} key=${"w" + i} wrap="truncate">
            <${Text} color=${C.accent}>${pad(a.name, wCols.name)}<//>
            <${Text} color=${C.muted}>${pad(addr(a.address), wCols.address)}<//>
            <${Text}>${pad(a.balances?.STRK?.formatted ?? "—", wCols.bal)}<//>
            <${Text}>${pad(a.balances?.ETH?.formatted ?? "—", wCols.bal)}<//>
          <//>`),
      ]
    : [html`<${Text} color=${C.muted}>${"  " + (wal?.reason ?? "no stack — u starts one")}<//>`];

  // The ledger is what this session ran; chain blocks are what the chain saw. The
  // former is more use when it exists, because it carries the flow name.
  const txRows = ledger?.length
    ? ledger.slice(0, Math.max(1, bandB - 2)).map((r, i) => html`
        <${Text} key=${"x" + i} wrap="truncate">
          <${Text} color=${C.muted}>${pad(r.at ?? "", 9)}<//>
          <${Text}>${pad(r.label ?? r.id ?? "run", Math.max(6, cols2[1] - 22))}<//>
          <${Text} color=${r.ok ? C.ok : C.bad}>${r.ok ? "  ok" : "  failed"}<//>
        <//>`)
    : blocks?.available && blocks.blocks?.length
      ? blocks.blocks.slice(0, Math.max(1, bandB - 2)).map((b, i) => html`
          <${Text} key=${"b" + i} wrap="truncate">
            <${Text} color=${C.muted}>${pad("block " + b.number, 12)}<//>
            <${Text}>${`${b.txCount} tx`}<//>
          <//>`)
      : [html`<${Text} color=${C.muted}>${"  nothing yet — x runs a flow"}<//>`];

  const mark = logo > 0 ? scaled(cols, logo) : [];
  const markPad = Math.max(0, Math.floor((cols - Math.max(0, ...mark.map((l) => l.length))) / 2));

  const band = (widths, blocks_) =>
    html`<${Box} flexDirection=${widths.length > 1 ? "row" : "column"}>${blocks_}<//>`;

  return html`
    <${Box} flexDirection="column" width=${cols} height=${rows} overflow="hidden">
      ${logo > 0 ? html`
        <${Box} flexDirection="column" height=${logo} overflow="hidden">
          ${mark.map((line, i) => html`
            <${Text} key=${"m" + i} color=${C.bad} wrap="truncate">${" ".repeat(markPad) + line}<//>`)}
        <//>` : null}
      ${band(cols3, wide
        ? [
            html`<${Block} key="s" w=${cols3[0]} h=${bandA} title="stack" rows=${stackRows} />`,
            html`<${Block} key="c" w=${cols3[1]} h=${bandA} title="chain" rows=${chainRows} />`,
            html`<${Block} key="t" w=${cols3[2]} h=${bandA} title="tooling"
              tone=${missN ? C.bad : C.border} rows=${toolRows} />`,
          ]
        : [html`<${Block} key="s" w=${cols} h=${bandA} title="stack · chain · tooling"
            rows=${[...stackRows, ...chainRows, ...toolRows]} />`])}
      ${band(cols2, wide
        ? [
            html`<${Block} key="w" w=${cols2[0]} h=${bandB} title="wallets"
              right=${wal?.available ? `${wal.wallets.length} accounts · b manages` : ""} rows=${walletRows} />`,
            html`<${Block} key="x" w=${cols2[1]} h=${bandB}
              title=${ledger?.length ? "this session" : "recent blocks"} rows=${txRows} />`,
          ]
        : [html`<${Block} key="w" w=${cols} h=${bandB} title="wallets · activity"
            rows=${[...walletRows, ...txRows]} />`])}
      ${strip > 0 ? html`
        <${Block} w=${cols} h=${strip} title="the auditor" tone=${C.warn}
          right="f shows the full matrix"
          rows=${[
            html`<${Text} wrap="truncate" key="h">
              <${Text} color=${C.warn}>${"  can decrypt every field of every action, in every configuration"}<//>
              <${Text} color=${C.muted}>${"  ·  contract-enforced, write-once"}<//>
            <//>`,
            // The standing note only when there is room for it. It is the one
            // disclosure true of every STRK20 deployment, so surplus rows go here
            // rather than into padding.
            ...(strip >= 7
              ? String(note ?? "").trim().split("\n").map((line, i) =>
                  html`<${Text} key=${"n" + i} color=${C.muted} wrap="truncate">${"  " + line.trim()}<//>`)
              : []),
          ]} />` : null}
    <//>`;
};
