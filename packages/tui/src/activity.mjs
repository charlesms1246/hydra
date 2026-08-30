/**
 * Activity: one transaction in full, a query over the chain, and the transactions
 * it returned — in that order, top to bottom.
 *
 * The detail block is FIRST because it is the answer; the query and the list are
 * how you get to it. It is a grid rather than a column because the ten facts a
 * receipt carries are pairs, and a single column of ten spends half the page on
 * whitespace.
 *
 * One field the brief asked for is still not here, and the reason is the RPC
 * rather than this file. **Action type** is unknowable: a receipt returns its
 * events as a COUNT (`core/src/chain.mjs`), and an invoke's calls are encoded in
 * `calldata` as `[n, (to, selector, len, ...args) * n]`, which this does not
 * decode. So there is no `to`, no transferred value, and no action filter —
 * offering any of them would be a box that silently matched nothing.
 *
 * **Sender** used to be on that list and no longer is. It was never missing from
 * the chain, only from what we asked for: it lives on the transaction object, not
 * the receipt, and `txStatus` now reads both.
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

const when = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const age = Math.max(0, Math.round(Date.now() / 1000 - ts));
  const ago = age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
  return `${d.toISOString().slice(0, 19).replace("T", " ")}  ${ago} ago`;
};

const fee = (f) => {
  if (!f) return "—";
  const amt = f.amount ?? f;
  try { return `${BigInt(amt).toString()} ${f.unit ?? ""}`.trim(); } catch { return String(amt); }
};

/**
 * The detail grid, as label/value pairs.
 *
 * Pure and exported so the pairs can be asserted without a renderer — this is the
 * block that would most easily start showing a plausible value for something the
 * node never returned.
 */
export function detailPairs(row, receipt, head) {
  if (!row) return [["", "select a transaction below — w and s move, tab switches section"]];
  if (!row.hash) {
    return [
      ["block", `#${row.block}`],
      ["timestamp", when(row.ts)],
      ["", "this block carried no transactions"],
    ];
  }
  const r = receipt;
  if (!r) return [["tx hash", row.hash], ["", "reading the receipt…"]];
  if (!r.available) return [["tx hash", row.hash], ["", r.reason, C.warn]];
  if (!r.found) return [["tx hash", row.hash], ["", `not found: ${r.error ?? ""}`, C.warn]];

  const depth = head !== undefined && head !== null && r.blockNumber !== null
    ? Math.max(0, head - r.blockNumber) : null;
  const conf = depth === null ? "—" : `${depth} block${depth === 1 ? "" : "s"}`;
  const ok = r.execution === "SUCCEEDED";
  return [
    ["tx hash", r.hash],
    ["type", `${r.type ?? "—"}${r.version ? `  v${Number(r.version)}` : ""}`],
    ["status", `${r.finality ?? "—"} · ${r.execution ?? "—"}`, ok ? C.ok : C.bad],
    ["block", r.blockNumber === null ? "—" : `#${r.blockNumber}`],
    ["confirmations", conf],
    ["timestamp", when(row.ts)],
    ["from", r.sender ?? "— not on this transaction type"],
    ["nonce", r.nonce === null ? "—" : String(Number(r.nonce))],
    ["actual fee", fee(r.actualFee)],
    // Counts, not contents. chain.mjs returns `(rc.events ?? []).length` and the
    // length of the encoded call array; neither is decoded, and saying so here is
    // what stops the grid reading like a block explorer that knows more than it does.
    // Ahead of `gas` deliberately: a narrow terminal drops from the tail, and the
    // caveat is worth more than the resource counts.
    ["events", `${r.events} (count only — events are not decoded)`],
    ["calls", r.calldata === null ? "—" : `${r.calldata} felts of calldata, not decoded`],
    ["gas", r.gas ? `l1 ${r.gas.l1} · l1 data ${r.gas.l1Data} · l2 ${r.gas.l2}` : "—"],
    ...(r.revertReason ? [["reverted", r.revertReason, C.bad]] : []),
  ];
}

/**
 * Pairs laid out two to a row — except the ones that do not fit in half the width,
 * which take a whole row rather than being cut. A truncated address or hash is not
 * a shorter address, it is an address you cannot use.
 */
function gridRows(pairs, width) {
  const labelW = 16;
  const half = Math.floor(width / 2);
  const fits = (p) => !p || String(p[1]).length <= half - labelW;
  const cell = (p, w, key) => {
    if (!p) return html`<${Box} key=${key} width=${w} />`;
    const [k, v, colour] = p;
    return html`
      <${Box} key=${key} width=${w}>
        <${Text} color=${C.muted}>${pad("  " + k, labelW)}<//>
        <${Text} color=${colour} wrap="truncate">${trunc(String(v), Math.max(0, w - labelW))}<//>
      <//>`;
  };
  const out = [];
  for (let i = 0; i < pairs.length; ) {
    if (!fits(pairs[i])) {
      out.push(html`<${Box} key=${"g" + i}>${cell(pairs[i], width, "a")}<//>`);
      i += 1;
    } else if (fits(pairs[i + 1]) && pairs[i + 1]) {
      out.push(html`<${Box} key=${"g" + i}>${cell(pairs[i], half, "a")}${cell(pairs[i + 1], half, "b")}<//>`);
      i += 2;
    } else {
      out.push(html`<${Box} key=${"g" + i}>${cell(pairs[i], half, "a")}<//>`);
      i += 1;
    }
  }
  return out;
}

export const ActivityPage = ({
  width, height, data, values, focus, selected, formSel, prompt, receipt,
}) => {
  const rows = rowsFor(data?.blocks, values);
  const row = rows[selected] ?? null;
  const head = data?.head ?? data?.blocks?.[0]?.number;

  // The query is fixed; the detail gives ground before the list does, because a
  // truncated grid still says which transaction you are looking at and a
  // one-row list does not tell you what else there is.
  const queryH = ACTIVITY_FIELDS.length + 2;
  const detailH = Math.min(9, Math.max(3, height - queryH - 5));
  const listH = Math.max(3, height - queryH - detailH);

  const detail = gridRows(detailPairs(row, row?.hash ? receipt : null, head), width - 2);

  const formRows = Form({
    fields: ACTIVITY_FIELDS, values, selected: formSel,
    focused: focus === "form", prompt, width: width - 2,
  });

  let listRows;
  let listRight;
  if (!data?.available) {
    listRight = "";
    listRows = [html`<${Text} color=${C.muted}>${"  " + (data?.reason ?? "loading…")}<//>`];
  } else {
    const inner = listH - 2;
    const win = windowRows(rows, selected, inner - 1);
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
      <${Block} w=${width} h=${detailH} title="transaction"
        right=${row?.hash ? "the selected row, read back from the node" : ""} rows=${detail} />
      <${Block} w=${width} h=${queryH} title="query" focused=${focus === "form"}
        right=${head === undefined ? "" : `head #${head}`} rows=${formRows} />
      <${Block} w=${width} h=${listH} title="transactions" focused=${focus === "list"}
        right=${listRight} rows=${listRows} />
    <//>`;
};
