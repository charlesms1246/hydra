/**
 * Run: build a flow, then run it.
 *
 * The page is built around one awkward fact. `ACTION_TYPES` has five members and the
 * control API has three endpoints: `withdraw` and `invoke` can be described and
 * previewed but cannot be submitted, and `notes`/`advance` can be submitted but
 * describe no disclosure at all. The list shows both kinds and says which is which,
 * because a Run page that silently hid the two it cannot run would leave you
 * wondering why the vocabulary has five words in it.
 *
 * `from` and `to` are pickers over the stack's own accounts, not free text — a
 * typed account name is a name the control API either knows or 500s on, and the
 * list of names it knows is already on screen two pages away. The last option is
 * `PASTE`, for an address that is not one of them: the pool's channel-count view
 * takes an address, so "does a transfer to THIS address open a channel?" is a
 * question worth being able to ask about a counterparty you do not hold keys for.
 * Such a flow previews and does not run, and the list says which of the two it is.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C } from "./theme.mjs";
import { Block, pad, trunc } from "./layout.mjs";
import { Form, windowRows, PASTE } from "./forms.mjs";
import { ACTION_TYPES } from "../../leak/src/facts.mjs";
import { RUNNABLE } from "../../core/src/flows.mjs";

/**
 * The builder's fields, for the accounts this stack actually has.
 *
 * A function rather than a constant because `from` and `to` are pickers over live
 * data: `hydra up --accounts 4` puts four names in the list without an edit here,
 * and a stack that is down puts none, which is honest — there is nothing to pick.
 *
 * @param accounts  status().accounts — `[{name, address, flows}]`
 * @param tokens    the tracked token symbols, which `n` on the Wallets page grows
 */
export function runFields(accounts = [], tokens = ["STRK", "ETH"]) {
  const names = accounts.map((a) => a.name).filter(Boolean);
  // Only the accounts this stack holds signing keys for can be a `from`, and the
  // recorded state says which (`up.mjs` writes `flows`). A stack recorded before
  // that field existed has it undefined, which reads as "capable" — the behaviour
  // it already had.
  const signers = accounts.filter((a) => a.flows !== false).map((a) => a.name).filter(Boolean);
  return [
    { id: "name", kind: "text", label: "name", placeholder: "my flow",
      hint: "what to call it in the list below" },
    { id: "type", kind: "enum", label: "action", options: ACTION_TYPES,
      hint: "enter cycles — withdraw and invoke can be previewed but not submitted" },
    { id: "from", kind: "enum", label: "from", options: [...signers, PASTE],
      hint: signers.length
        ? `enter cycles — ${signers.length} account${signers.length === 1 ? "" : "s"} this stack can sign as`
        : "no stack — u starts one, and its accounts appear here" },
    { id: "to", kind: "enum", label: "to", options: [...names, PASTE],
      hint: "recipient — the pool discloses this on the first transfer to them" },
    { id: "token", kind: "enum", label: "token", options: tokens, hint: "" },
    { id: "amount", kind: "text", label: "amount", placeholder: "50",
      hint: "whole tokens — converted to base units on the wire" },
  ];
}

/** The shape with no stack behind it — what the page draws before `u`. */
export const RUN_FIELDS = runFields();

export const RunPage = ({
  width, height, builtIn, flows, values, focus, selected, formSel, prompt, txAvailable,
  fields = RUN_FIELDS,
}) => {
  const formH = fields.length + 3;
  const listH = Math.max(5, height - formH);

  const formRows = [
    ...Form({
      fields, values, selected: formSel,
      focused: focus === "form", prompt, width: width - 2,
    }),
    html`<${Text} key="save" color=${C.muted} wrap="truncate">
      ${"  i saves this as a flow · tab moves to the list · enter previews what it discloses"}<//>`,
  ];

  // Built-ins first, then anything saved. Both render the same way; a flow you built
  // is not a second-class citizen of this page.
  const items = [
    ...builtIn.map((a) => ({
      id: a.id, name: a.label, kind: "built-in",
      runnable: Boolean(a.run), describes: Boolean(a.leak),
    })),
    ...flows.map((f) => ({
      id: f.id, name: `${f.name}  ·  ${f.type}${f.amount ? ` ${f.amount} ${f.token}` : ""}`,
      kind: "saved", runnable: f.runnable, describes: true, flow: f, reason: f.reason,
    })),
  ];

  const inner = listH - 2;
  const win = windowRows(items, selected, inner);
  const listRows = items.length
    ? win.rows.map((it, i) => {
        const idx = win.start + i;
        const on = focus === "list" && idx === selected;
        const why = !it.describes
          ? "submits, discloses nothing to report"
          : !it.runnable
            ? it.reason ?? "no control endpoint — preview only"
            : txAvailable ? "" : "needs a running stack";
        return html`
          <${Text} key=${it.id + idx} wrap="truncate">
            <${Text} color=${on ? C.accent : undefined}>${on ? "▸" : " "}<//>
            <${Text} color=${on ? C.accent : undefined} bold=${on}>
              ${pad(it.name, Math.max(16, Math.floor(width * 0.42)))}<//>
            <${Text} color=${C.muted}>${pad(it.kind, 10)}<//>
            <${Text} color=${it.runnable ? C.muted : C.warn}>
              ${trunc(why, Math.max(0, width - 16 - Math.floor(width * 0.42)))}<//>
          <//>`;
      })
    : [html`<${Text} color=${C.muted}>${"  nothing saved yet — fill the form above and press i"}<//>`];

  return html`
    <${Box} flexDirection="column" width=${width} height=${height} overflow="hidden">
      <${Block} w=${width} h=${formH} title="build a flow" focused=${focus === "form"}
        right=${RUNNABLE.length + " of " + ACTION_TYPES.length + " types are runnable here"}
        rows=${formRows} />
      <${Block} w=${width} h=${listH} title="flows" focused=${focus === "list"}
        right=${win.note || `${items.length} · enter previews · - forgets`} rows=${listRows} />
    <//>`;
};
