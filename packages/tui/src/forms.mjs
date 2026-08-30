/**
 * The form half of a sectioned page.
 *
 * Three field kinds, and only one of them can swallow the keyboard. `text` opens
 * typing mode, where every printable key is data — so `q` types a q rather than
 * quitting, and Esc is the only way out. `enum` and `bool` never do: Enter cycles
 * them in place, which is why the Run page can be driven entirely without ever
 * entering a mode you have to escape from.
 *
 * Fields are data, not components, so a page's form is a list its keymap can walk
 * with the existing `list` bindings and its state is one plain object.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C, glyph, tone } from "./theme.mjs";
import { pad, trunc } from "./layout.mjs";

/** The rendered value of one field, before it is padded into its column. */
export function fieldValue(f, values) {
  const v = values?.[f.id];
  if (f.kind === "bool") return v ? "yes" : "no";
  if (f.kind === "enum") return String(v ?? f.options?.[0] ?? "—");
  return v === undefined || v === "" ? (f.placeholder ?? "—") : String(v);
}

/**
 * Advance a field without entering a mode.
 *
 * Returns the next value, or `TYPE` to say "this one needs the keyboard". Pure, so
 * the keymap can call it and the tests can assert the cycle without a renderer.
 */
export const TYPE = Symbol("type");
export function advance(f, values) {
  if (f.kind === "bool") return !values?.[f.id];
  if (f.kind === "enum") {
    const opts = f.options ?? [];
    const i = opts.indexOf(values?.[f.id] ?? opts[0]);
    return opts[(i + 1) % Math.max(1, opts.length)];
  }
  return TYPE;
}

export const Form = ({ fields, values, selected, focused, typing, width }) => {
  const labelW = Math.min(18, Math.max(10, Math.floor(width * 0.22)));
  return fields.map((f, i) => {
    const on = focused && i === selected;
    const editing = on && typing;
    const value = fieldValue(f, values);
    const hintW = Math.max(0, width - labelW - 4 - Math.min(30, Math.floor(width * 0.3)));
    return html`
      <${Text} key=${f.id} wrap="truncate">
        <${Text} color=${on ? C.accent : undefined}>${on ? "▸" : " "}<//>
        <${Text} color=${C.muted}>${pad(f.label, labelW)}<//>
        <${Text} color=${editing ? undefined : on ? C.accent : undefined} bold=${on}>
          ${pad(editing ? value : value, Math.min(30, Math.floor(width * 0.3)))}<//>
        <${Text} color=${C.accent}>${editing ? "▌" : " "}<//>
        <${Text} color=${C.muted}>${trunc(f.hint ?? "", hintW)}<//>
      <//>`;
  });
};

/** One-line summary of a set of liveness flags, for a form's right-hand title. */
export const dot = (up, warn) => html`<${Text} color=${tone(up, warn)}>${glyph(up, warn)}<//>`;

/**
 * A windowed list that pads to its height and reports what it dropped.
 *
 * `List` in layout.mjs pads but does not report; every list on a sectioned page has
 * to say when it is showing you a subset, so this wraps it with the indicator the
 * Block title expects.
 */
export function windowRows(items, selected, height) {
  if (items.length <= height) return { rows: items, start: 0, note: "" };
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  return {
    rows: items.slice(start, start + height),
    start,
    note: `${start + 1}-${start + height}/${items.length}`,
  };
}
