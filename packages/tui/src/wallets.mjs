/**
 * The Wallets page: what you have, and what you can do to it.
 *
 * Two sections. The top one is the management surface — the page used to be a
 * read-only table, so funding was a key you had to already know about and there
 * was no way at all to track a token or get the addresses out. The bottom is the
 * table itself, which is where the selection lives.
 *
 * One action is deliberately not what it looks like. devnet fixes its account set
 * at spawn (`--accounts N`); there is no call that adds one to a running chain.
 * So "another account" restarts the stack with a higher count and says so, rather
 * than pretending to mint an account into an existing devnet.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C, glyph, tone } from "./theme.mjs";

const trunc = (s, w) =>
  String(s ?? "").length <= w ? String(s ?? "") : String(s ?? "").slice(0, Math.max(0, w - 1)) + "…";
const pad = (s, w) => trunc(s, w).padEnd(w);
const addr = (a) => (a ? `${String(a).slice(0, 10)}…${String(a).slice(-6)}` : "—");

/** The management actions, in the order they are offered. */
export const WALLET_ACTIONS = [
  { key: "m", id: "fund", label: "mint devnet funds to the selected account",
    note: "devnet only — there is no faucet on mainnet" },
  { key: "n", id: "token", label: "track another ERC20 by address",
    note: "validated with a real balanceOf before it is stored" },
  { key: "v", id: "export", label: "export addresses and balances to JSON",
    note: "no private keys — this process never holds them" },
  { key: "+", id: "account", label: "restart the stack with one more account",
    note: "devnet fixes its accounts at spawn; this is the only way to add one" },
];

const Frame = ({ w, h, title, right, rows, tone: t = C.border }) => {
  const inner = Math.max(0, h - 2);
  const shown = rows.slice(0, inner);
  const blanks = Array.from({ length: Math.max(0, inner - shown.length) }, (_, i) => i);
  const dropped = rows.length - shown.length;
  const l = ` ${title} `;
  const r = dropped > 0 ? ` +${dropped} more ` : right ? ` ${right} ` : "";
  const fill = Math.max(0, w - 2 - l.length - r.length);
  return html`
    <${Box} flexDirection="column" width=${w} height=${h} overflow="hidden">
      <${Text} color=${t}>${"┌" + l + "─".repeat(fill) + r + "┐"}<//>
      <${Box} flexDirection="column" width=${w} borderStyle="round" borderTop=${false}
        borderColor=${t} overflow="hidden">
        ${shown.map((row, i) => html`<${Box} key=${"r" + i} width=${w - 2}>${row}<//>`)}
        ${blanks.map((i) => html`<${Text} key=${"p" + i}>${" "}<//>`)}
      <//>
    <//>`;
};

/**
 * @param prompt  null, or {label, value} while a field is being typed into
 */
export const WalletsPage = ({ width, height, data, selected, prompt, tokens }) => {
  // The manage block is fixed; the table takes the rest. A management surface
  // that shrinks as accounts appear would put the actions somewhere different on
  // every stack.
  const manageRows = WALLET_ACTIONS.length + (prompt ? 2 : 1);
  const manageH = Math.min(manageRows + 2, Math.max(6, height - 6));
  const tableH = Math.max(4, height - manageH);

  const available = Boolean(data?.available);
  const accounts = available ? data.wallets : [];
  const syms = Object.keys(tokens ?? data?.tokens ?? {});

  const actionRows = WALLET_ACTIONS.map((a, i) => html`
    <${Text} key=${a.id} wrap="truncate">
      <${Text} color=${C.ok} bold>${"  " + a.key + "  "}<//>
      <${Text} color=${available || a.id === "account" ? undefined : C.muted}>
        ${pad(a.label, Math.max(10, Math.floor(width * 0.42)))}<//>
      <${Text} color=${C.muted}>${trunc(a.note, Math.max(0, width - 8 - Math.floor(width * 0.42)))}<//>
    <//>`);

  if (prompt) {
    actionRows.push(html`<${Text} key="sp">${" "}<//>`);
    actionRows.push(html`
      <${Text} key="prompt" wrap="truncate">
        <${Text} color=${C.accent} bold>${"  " + prompt.label + " "}<//>
        <${Text}>${prompt.value}<//>
        <${Text} color=${C.accent}>${"▌"}<//>
        <${Text} color=${C.muted}>${"   enter accepts · esc cancels"}<//>
      <//>`);
  } else {
    actionRows.push(html`
      <${Text} key="hint" color=${C.muted} wrap="truncate">
        ${"  w s move the selection · tracking " + (syms.length ? syms.join(", ") : "nothing yet")}<//>`);
  }

  // Column widths from the data, so a long symbol list does not collide with the
  // address the way a fixed 12-wide address column did on the dashboard.
  const nameW = 9;
  const addrW = Math.min(22, Math.max(14, Math.floor(width * 0.24)));
  const balW = Math.max(10, Math.floor((width - nameW - addrW - 4) / Math.max(1, syms.length)));

  const tableRows = available
    ? [
        html`<${Text} key="h" color=${C.muted} wrap="truncate">
          ${" " + pad("account", nameW) + pad("address", addrW) +
            syms.map((sy) => pad(sy, balW)).join("")}<//>`,
        ...accounts.map((a, i) => html`
          <${Text} key=${"a" + i} wrap="truncate">
            <${Text} color=${i === selected ? C.accent : undefined}>${i === selected ? "▸" : " "}<//>
            <${Text} color=${i === selected ? C.accent : undefined} bold=${i === selected}>
              ${pad(a.name, nameW)}<//>
            <${Text} color=${C.muted}>${pad(addr(a.address), addrW)}<//>
            ${syms.map((sy) => html`
              <${Text} key=${sy}>${pad(a.balances?.[sy]?.formatted ?? "—", balW)}<//>`)}
          <//>`),
      ]
    : [html`<${Text} color=${C.muted}>${"  " + (data?.reason ?? "loading…")}<//>`];

  return html`
    <${Box} flexDirection="column" width=${width} height=${height} overflow="hidden">
      <${Frame} w=${width} h=${manageH} title="manage"
        tone=${prompt ? C.accent : C.border}
        right=${available ? "" : "no stack — u starts one"} rows=${actionRows} />
      <${Frame} w=${width} h=${tableH} title="accounts"
        right=${available ? `${accounts.length} accounts · ${syms.length} tokens` : ""}
        rows=${tableRows} />
    <//>`;
};
