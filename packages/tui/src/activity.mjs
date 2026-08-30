/**
 * Activity: a query form over the chain, and the transactions it returns.
 *
 * Two fields the brief asked for are not here, because the data cannot answer them.
 * There is no **sender** anywhere in what we read — `starknet_getBlockWithTxHashes`
 * returns hashes only (`core/src/chain.mjs:14`) and the receipt carries no sender
 * (`chain.mjs:34-44`). And **action type** is unknowable, because `txStatus` returns
 * `events` as a COUNT, not decoded events (`chain.mjs:42`). Offering either as a
 * filter would have been a box that silently matched nothing.
 *
 * What is answerable: how deep to look, a hash to find, a substring to match, and
 * whether to hide empty blocks.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C } from "./theme.mjs";
import { Block, pad, trunc } from "./layout.mjs";
import { Form, windowRows } from "./forms.mjs";

export const ACTIVITY_FIELDS = [
  { id: "depth", kind: "text", label: "depth", placeholder: "8",
    hint: "how many blocks back to read — this is the n of latestBlocks(n)" },
  { id: "hash", kind: "text", label: "tx hash", placeholder: "any",
    hint: "jump straight to one transaction's receipt" },
  { id: "match", kind: "text", label: "match", placeholder: "any",
    hint: "substring, against the block number and the tx hash" },
  { id: "txonly", kind: "bool", label: "with tx only",
    hint: "hide blocks that carried no transactions" },
];

/** Flatten blocks to one row per transaction, keeping empty blocks unless filtered. */
export function rowsFor(blocks, values) {
  const out = [];
  for (const b of blocks ?? []) {
    const hashes = b.txs ?? b.transactions ?? [];
    if (!hashes.length) {
      if (!values?.txonly) out.push({ block: b.number, hash: null, ts: b.timestamp, count: 0 });
      continue;
    }
    for (const h of hashes) out.push({ block: b.number, hash: h, ts: b.timestamp, count: b.txCount });
  }
  const m = String(values?.match ?? "").trim().toLowerCase();
  if (!m) return out;
  return out.filter((r) => `${r.block} ${r.hash ?? ""}`.toLowerCase().includes(m));
}

const Receipt = ({ receipt, width }) => {
  if (!receipt) return [html`<${Text} key="l" color=${C.muted}>${"  reading the receipt…"}<//>`];
  if (!receipt.available) return [html`<${Text} key="e" color=${C.warn}>${"  " + receipt.reason}<//>`];
  if (!receipt.found) {
    return [html`<${Text} key="n" color=${C.warn}>${"  not found: " + (receipt.error ?? "")}<//>`];
  }
  const rows = [
    ["hash", receipt.hash],
    ["finality", receipt.finality ?? "—"],
    ["execution", receipt.execution ?? "—"],
    ["block", receipt.blockNumber ?? "—"],
    ["actual fee", receipt.actualFee ? `${receipt.actualFee.amount ?? "?"} ${receipt.actualFee.unit ?? ""}` : "—"],
    // A count, not a list. chain.mjs:42 does `(rc.events ?? []).length` — the events
    // themselves are never decoded, which is why this page cannot filter by action.
    ["events", `${receipt.events} (count only — events are not decoded)`],
  ];
  return rows.map(([k, v]) => html`
    <${Text} key=${k} wrap="truncate">
      <${Text} color=${C.muted}>${pad("  " + k, 14)}<//>
      <${Text}>${trunc(String(v), Math.max(0, width - 16))}<//>
    <//>`);
};

export const ActivityPage = ({
  width, height, data, values, focus, selected, formSel, typing, receipt, level,
}) => {
  const formH = ACTIVITY_FIELDS.length + 2;
  const listH = Math.max(4, height - formH);
  const rows = rowsFor(data?.blocks, values);
  const head = data?.available ? `head #${data.blocks?.[0]?.number ?? "?"}` : "";

  const formRows = Form({
    fields: ACTIVITY_FIELDS, values, selected: formSel,
    focused: focus === "form", typing, width: width - 2,
  });

  let listRows;
  let listTitle;
  let listRight;
  if (level > 0) {
    listTitle = "receipt";
    listRight = "esc goes back";
    listRows = Receipt({ receipt, width: width - 2 });
  } else if (!data?.available) {
    listTitle = "transactions";
    listRight = "";
    listRows = [html`<${Text} color=${C.muted}>${"  " + (data?.reason ?? "loading…")}<//>`];
  } else {
    const inner = listH - 2;
    const win = windowRows(rows, selected, inner);
    listTitle = "transactions";
    listRight = win.note || `${rows.length} rows`;
    listRows = rows.length
      ? [
          html`<${Text} key="h" color=${C.muted} wrap="truncate">
            ${" " + pad("block", 9) + pad("tx", Math.max(12, width - 34)) + pad("in block", 10)}<//>`,
          ...win.rows.map((r, i) => {
            const on = focus === "list" && win.start + i === selected;
            return html`
              <${Text} key=${"r" + i} wrap="truncate">
                <${Text} color=${on ? C.accent : undefined}>${on ? "▸" : " "}<//>
                <${Text} color=${on ? C.accent : C.muted} bold=${on}>${pad("#" + r.block, 9)}<//>
                <${Text}>${pad(r.hash ? trunc(r.hash, 24) : "— no transactions", Math.max(12, width - 34))}<//>
                <${Text} color=${C.muted}>${pad(r.hash ? `${r.count} tx` : "", 10)}<//>
              <//>`;
          }),
        ]
      : [html`<${Text} color=${C.muted}>${"  nothing matched — esc clears the filter"}<//>`];
  }

  return html`
    <${Box} flexDirection="column" width=${width} height=${height} overflow="hidden">
      <${Block} w=${width} h=${formH} title="query" focused=${focus === "form"}
        right=${head} rows=${formRows} />
      <${Block} w=${width} h=${listH} title=${listTitle} focused=${focus === "list"}
        right=${listRight} rows=${listRows} />
    <//>`;
};
