/**
 * The only file in this package where a colour name is written.
 *
 * The old panels carried colour literals at 44 call sites and app.mjs's
 * leak→summary transform carried a second, disagreeing vocabulary, so CLEAR was
 * "red" in two places and could drift. Here it is defined once, keyed on the
 * constants imported from packages/leak — a rename upstream becomes a crash in
 * this file rather than a silently blank cell.
 */

import { CLEAR, DECRYPTABLE, NOT_DISCLOSED, UNKNOWN, NA } from "../../leak/src/facts.mjs";

/**
 * `ok` is bound to LIVENESS only — a process that answers, a pin that matches.
 * It is deliberately unreachable from DISCLOSURE below: facts.mjs:25-35 is
 * explicit that no value in the disclosure vocabulary means "private", and green
 * is the one colour that would say it does. A test asserts this.
 */
export const C = {
  ok: "green",
  warn: "yellow",
  bad: "red",
  unknown: "magenta",
  muted: "gray",
  accent: "cyan",
  border: "gray",
  borderFocus: "cyan",
};

/**
 * `long` is used wherever the column is wide enough; `short` exists for the party
 * and field LABELS, never for the cell words. The words are the payload —
 * DECRYPTABLE abbreviated to DECR. is a claim nobody can check — so the layout
 * gives ground on the labels and never on these.
 */
export const DISCLOSURE = {
  [CLEAR]: { color: C.bad, word: "CLEAR" },
  [DECRYPTABLE]: { color: C.warn, word: "DECRYPTABLE" },
  [NOT_DISCLOSED]: { color: C.muted, word: "not-by-tx" },
  // The loudest colour in the table, because UNKNOWN is the value most likely to
  // be read as a pass. facts.mjs:33: "Never treat as a pass."
  [UNKNOWN]: { color: C.unknown, word: "UNKNOWN" },
  [NA]: { color: C.muted, word: "—" },
};

/** The widest cell word, which is what every field column has to fit. */
export const WIDEST_MARK = Math.max(...Object.values(DISCLOSURE).map((d) => d.word.length));

export const mark = (disclosure) =>
  DISCLOSURE[disclosure] ?? { color: C.unknown, word: String(disclosure) };

/** Party labels at two widths. facts.mjs:41-48 fixes the ids and the print order. */
export const PARTY_SHORT = {
  public: "public chain",
  "pool-users": "pool users",
  counterparty: "counterparty",
  discovery: "discovery svc",
  prover: "prover svc",
  auditor: "THE AUDITOR",
};

/** Field headers at two widths. Cell words are never shortened; headers may be. */
export const FIELD_SHORT = {
  amount: "amount",
  token: "token",
  counterparty: "cpty",
  timing: "timing",
  addresses: "addresses",
};

/** Log severity. One stream, one glyph per line — there is no separate notifier. */
export const SEV = {
  ok: { glyph: " ", color: C.muted },
  info: { glyph: " ", color: C.muted },
  warn: { glyph: "!", color: C.warn },
  bad: { glyph: "x", color: C.bad },
};

/** Liveness glyphs, unchanged from the panels they came from. */
export const glyph = (up, warn) => (up ? "●" : warn ? "◐" : "○");
export const tone = (up, warn) => (up ? C.ok : warn ? C.warn : C.muted);
