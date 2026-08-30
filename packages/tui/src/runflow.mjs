/**
 * Run: build a flow, then run it.
 *
 * The page is built around one awkward fact. `ACTION_TYPES` has five members and the
 * control API has three endpoints: `withdraw` and `invoke` can be described and
 * previewed but cannot be submitted, and `notes`/`advance` can be submitted but
 * describe no disclosure at all. The list shows both kinds and says which is which,
 * because a Run page that silently hid the two it cannot run would leave you
 * wondering why the vocabulary has five words in it.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C } from "./theme.mjs";
import { Block, pad, trunc } from "./layout.mjs";
import { Form, windowRows } from "./forms.mjs";
import { ACTION_TYPES } from "../../leak/src/facts.mjs";
import { RUNNABLE } from "../../core/src/flows.mjs";

export const RUN_FIELDS = [
  { id: "name", kind: "text", label: "name", placeholder: "my flow",
    hint: "what to call it in the list below" },
  { id: "type", kind: "enum", label: "action", options: ACTION_TYPES,
    hint: "enter cycles — withdraw and invoke can be previewed but not submitted" },
  { id: "from", kind: "text", label: "from", placeholder: "alice", hint: "account name" },
  { id: "to", kind: "text", label: "to", placeholder: "bob",
    hint: "recipient — the pool discloses this on the first transfer to them" },
  { id: "token", kind: "enum", label: "token", options: ["STRK", "ETH"], hint: "" },
  { id: "amount", kind: "text", label: "amount", placeholder: "50",
    hint: "whole tokens — converted to base units on the wire" },
];

export const RunPage = ({
  width, height, builtIn, flows, values, focus, selected, formSel, typing, txAvailable,
}) => {
  const formH = RUN_FIELDS.length + 3;
  const listH = Math.max(5, height - formH);

  const formRows = [
    ...Form({
      fields: RUN_FIELDS, values, selected: formSel,
      focused: focus === "form", typing, width: width - 2,
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
      kind: "saved", runnable: f.runnable, describes: true, flow: f,
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
            ? "no control endpoint — preview only"
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
