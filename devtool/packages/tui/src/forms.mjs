/**
 * The form half of a sectioned page.
 *
 * Three field kinds, and only one of them can swallow the keyboard. `text` opens
 * typing mode, where every printable key is data — so `q` types a q rather than
 * quitting, and Esc is the only way out. `enum` and `bool` never do: Enter cycles
 * them in place, which is why the Run page can be driven entirely without ever
 * entering a mode you have to escape from.
 *
 * One `enum` option is special. `PASTE`, when it comes round, is not a value — it
 * is the request for one, and `advance` returns `TYPE` for it so the same prompt
 * a `text` field opens handles the case an enum cannot: an address that is not one
 * of this stack's accounts. That is one mechanism, not two: a picker with an
 * escape hatch, rather than a picker plus a separate free-text field.
 *
 * The open prompt is passed in whole rather than as a boolean. It used to be
 * `typing={Boolean(prompt)}`, so the cell kept rendering the SAVED value while you
 * typed: every keystroke was recorded and none of them appeared, which is
 * indistinguishable from a field that does not work.
 *
 * Fields are data, not components, so a page's form is a list its keymap can walk
 * with the existing `list` bindings and its state is one plain object.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C, glyph, tone } from "./theme.mjs";
import { pad, trunc } from "./layout.mjs";

/** The label of the "not one of these" option. Never stored as a value. */
export const PASTE = "paste an address…";

/** A felt address, as opposed to one of this stack's account names. */
export const isAddress = (v) => /^0x[0-9a-fA-F]{1,64}$/.test(String(v ?? "").trim());

/** The rendered value of one field, before it is padded into its column. */
export function fieldValue(f, values) {
  const v = values?.[f.id];
  if (f.kind === "bool") return v ? "yes" : "no";
  if (f.kind === "enum") {
    const raw = String(v ?? f.options?.[0] ?? "—");
    // A pasted address is 66 characters in a 30-wide cell. Shortened here rather
    // than truncated by the padder, so the tail — which is what distinguishes two
    // addresses at a glance — survives.
    return isAddress(raw) && raw.length > 24 ? `${raw.slice(0, 10)}…${raw.slice(-6)}` : raw;
  }
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
    const cur = values?.[f.id];
    // A pasted address is not in the option list, so `indexOf` is -1 and the cycle
    // starts again at the first name. That is the wanted behaviour: the address is
    // held until you cycle off it, and cycling off it goes back to the accounts.
    const i = opts.indexOf(cur ?? opts[0]);
    const next = opts[(i + 1) % Math.max(1, opts.length)];
    return next === PASTE ? TYPE : next;
  }
  return TYPE;
}

export const Form = ({ fields, values, selected, focused, prompt, width }) => {
  const labelW = Math.min(18, Math.max(10, Math.floor(width * 0.22)));
  const valW = Math.min(30, Math.floor(width * 0.3));
  return fields.map((f, i) => {
    const on = focused && i === selected;
    // Matched on the field id, not on "a prompt is open": the wallets page opens
    // prompts of its own, and a bare boolean would have this form show one of them.
    const editing = Boolean(prompt) && prompt.field === f.id;
    // While typing, the tail — a 66-character address typed into a 30-wide cell
    // otherwise shows a frozen prefix and no cursor movement.
    const typed = String(prompt?.value ?? "");
    const value = editing
      ? (typed.length > valW - 1 ? typed.slice(-(valW - 1)) : typed)
      : fieldValue(f, values);
    const hintW = Math.max(0, width - labelW - 4 - valW);
    return html`
      <${Text} key=${f.id} wrap="truncate">
        <${Text} color=${on ? C.accent : undefined}>${on ? "▸" : " "}<//>
        <${Text} color=${C.muted}>${pad(f.label, labelW)}<//>
        <${Text} color=${editing ? undefined : on ? C.accent : undefined} bold=${on}>
          ${pad(value, valW)}<//>
        <${Text} color=${C.accent}>${editing ? "▌" : " "}<//>
        <${Text} color=${C.muted}>${trunc(editing ? "enter accepts · esc cancels" : f.hint ?? "", hintW)}<//>
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
