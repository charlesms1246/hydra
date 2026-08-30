/**
 * Sizing and windowing. Knows nothing about hydra.
 *
 * `fit()` is pure on purpose: the guarantee that matters — every region sum stays
 * under the terminal height, at every width — is then testable with no renderer
 * at all. It has to hold, because Ink clears the whole terminal the moment output
 * reaches stdout.rows (ink/build/ink.js:121) and a dashboard that repaints from
 * scratch every frame is unusable.
 */

import { Box, Text, useStdout } from "ink";
import { html, React } from "./ui.mjs";
import { C, WIDEST_MARK } from "./theme.mjs";

const { useState, useEffect } = React;

/** Below this nothing but the matrix and the drawer are drawn. */
export const MIN_COLS = 70;
export const MIN_ROWS = 20;

/** Live terminal size. Resize was previously not handled at all. */
export function useSize() {
  const { stdout } = useStdout();
  // The real size, not a clamped one. Clamping here once produced a frame 70
  // columns wide in a 60-column terminal, which is the same wrap-and-overflow
  // failure the clamp was meant to prevent. fit() does its own clamping.
  const read = () => {
    const cols = stdout?.columns ?? 80;
    const rows = stdout?.rows ?? 24;
    return { cols, rows, tooSmall: cols < MIN_COLS || rows < MIN_ROWS };
  };
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (!stdout?.on) return undefined;
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => stdout.off?.("resize", onResize);
  }, [stdout]);
  return size;
}

/**
 * Widest party column that still leaves every field column wide enough for the
 * longest cell word plus a separator. Returns null when all 30 cells cannot be
 * shown at full width — the layout then refuses to draw a matrix rather than
 * abbreviating one.
 */
function matrixGeom(interior) {
  for (const [want, minField] of [[31, WIDEST_MARK + 2], [16, WIDEST_MARK + 1], [13, WIDEST_MARK]]) {
    const fieldW = Math.min(WIDEST_MARK + 2, Math.floor((interior - want) / 5));
    if (fieldW >= minField) {
      // Fill the width. This used to cap the box near 98 columns on the grounds
      // that a wide label gutter is whitespace rather than information — true of
      // the gutter, but it left two thirds of a 190-column terminal empty and the
      // page has nothing else on it. So the party column takes a bounded share
      // and the five field columns divide the rest.
      const partyW = Math.max(13, Math.min(40, Math.floor(interior * 0.28)));
      const wide = Math.max(fieldW, Math.floor((interior - partyW) / 5));
      return { partyW: interior - wide * 5, fieldW: wide, marks: partyW >= 29 ? "long" : "short" };
    }
  }
  return null;
}

/**
 * Row budget for the home screen, in the ladder order things give ground:
 * ledger 3 rows → 1, then the drawer 4+2 → 3+1, then the notes band 2 → 1 → 0,
 * then the ledger entirely. The legend is never shed: an unglossed `not-by-tx`
 * reads as "private", which is the single misreading this tool exists to stop.
 * The matrix is never shed and never rolled up.
 */
export function fit(cols, rows, fixed = 4) {
  const draw = rows - 1;                       // one row of headroom, see above
  const padX = cols >= 80 ? 1 : 0;
  const contentW = cols - padX * 2;
  const interior = contentW - 2;               // minus the box border
  const geom = matrixGeom(interior);

  const MATRIX = 10;                           // 2 border + head + 5 parties + rule + auditor
  const LEGEND = 1;
  const FIXED = fixed;                         // chrome the page cannot use
  let remaining = draw - FIXED - MATRIX - LEGEND;

  const plan = { ledger: 4, drawerBody: 4, drawerCites: 2, notes: 2 };
  const cost = () => plan.ledger + plan.drawerBody + plan.drawerCites + 2 + plan.notes;
  const sheds = [
    () => (plan.ledger === 4 ? ((plan.ledger = 1), true) : false),
    () => (plan.drawerCites === 2 ? ((plan.drawerCites = 1), true) : false),
    () => (plan.drawerBody === 4 ? ((plan.drawerBody = 3), true) : false),
    () => (plan.notes === 2 ? ((plan.notes = 1), true) : false),
    () => (plan.notes === 1 ? ((plan.notes = 0), true) : false),
    () => (plan.ledger === 1 ? ((plan.ledger = 0), true) : false),
    () => (plan.drawerBody > 1 ? ((plan.drawerBody -= 1), true) : false),
  ];
  while (cost() > remaining && sheds.some((s) => s()));

  // Surplus height goes to the two regions that hold evidence, and then STOPS.
  // A 50-row terminal spending 10 rows on empty ledger padding looks broken; a
  // frame shorter than the terminal does not. `why` reaches 730 characters,
  // which is 8-12 wrapped lines, so the drawer stops being useful past that.
  let extra = remaining - cost();
  if (extra > 0) {
    const toLedger = Math.min(extra, 2);
    plan.ledger += toLedger;
    extra -= toLedger;
    plan.drawerBody += Math.min(extra, 8);
  }

  const ledgerRule = plan.ledger > 1;
  const ledgerRows = Math.max(0, plan.ledger - (ledgerRule ? 1 : 0));  // one row is the rule
  const rigRows = draw - FIXED;
  // The home screen's exact planned height, and the number app.mjs pins that
  // region to with overflow hidden. Shedding alone is not the guarantee — a
  // region that draws one row more than its budget (the `why` drawer's overflow
  // indicator did, below 78 columns) pushed the frame to stdout.rows and Ink
  // cleared the terminal every frame (ink/build/ink.js:121). Clipping is the
  // guarantee; the min() is what makes it hold even if the shed loop bottoms out.
  const reportRows = Math.min(
    rigRows,
    ledgerRows + (ledgerRule ? 1 : 0) + MATRIX + LEGEND + 2 + plan.drawerBody + plan.drawerCites + plan.notes
  );

  return {
    padX,
    contentW,
    interior,
    partyW: geom?.partyW ?? 0,
    fieldW: geom?.fieldW ?? 0,
    // The matrix box is exactly as wide as its 30 cells need, never wider.
    boxW: geom ? geom.partyW + geom.fieldW * 5 + 2 : contentW,
    marks: geom?.marks ?? "short",
    matrixFits: Boolean(geom),
    ledgerRows,
    ledgerRule,
    drawerBody: plan.drawerBody,
    drawerCites: plan.drawerCites,
    notesRows: plan.notes,
    // The drawer expanded over the matrix and the legend.
    expandedBody: plan.drawerBody + MATRIX + LEGEND - 2,
    // The rig overlay replaces everything between the config line and the status
    // line, so the header, config, status and footer never move under you.
    rigRows,
    reportRows,
    draw,
  };
}

/** Hard wrap. Ink's <Text wrap> wraps but gives no way to page, and a `why` runs to 730 chars. */
export function wrap(text, width) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else { out.push(line); line = word; }
      while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

/** Window `items` around `selected`, padded to `height` so frames never jitter. */
export function windowOf(len, selected, height) {
  if (height <= 0 || len === 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), len - height));
  return { start: Math.max(0, start), end: Math.min(len, Math.max(0, start) + height) };
}

export const indicatorFor = (len, start, end) =>
  len <= end - start ? `${len}/${len}` : `${start + 1}-${end}/${len}${start ? ` · ${start} above` : ""}`;

/**
 * A windowed list. Pads to `height` with blank rows, because a list that changes
 * height as you scroll drags every region below it up and down.
 */
export const List = ({ items, selected, height, renderRow, emptyText }) => {
  if (!items?.length) {
    const blanks = Array.from({ length: Math.max(0, height - 1) }, (_, i) => i);
    return html`
      <${Box} flexDirection="column">
        <${Text} color=${C.muted}>${emptyText ?? "nothing here"}<//>
        ${blanks.map((i) => html`<${Text} key=${"b" + i}>${" "}<//>`)}
      <//>`;
  }
  const { start, end } = windowOf(items.length, selected, height);
  const shown = items.slice(start, end);
  const pad = Array.from({ length: Math.max(0, height - shown.length) }, (_, i) => i);
  return html`
    <${Box} flexDirection="column">
      ${shown.map((it, i) => renderRow(it, start + i, start + i === selected))}
      ${pad.map((i) => html`<${Text} key=${"p" + i}>${" "}<//>`)}
    <//>`;
};

/** A one-row band title: a rule costs 1 row where a bordered box costs 2. */
export const Band = ({ left, right, width, color = C.muted }) => {
  const l = ` ${left} `;
  const r = right ? ` ${right} ` : "";
  const fill = Math.max(0, width - l.length - r.length - 3);
  return html`<${Text} color=${color}>${" ──" + l + "─".repeat(fill) + r}<//>`;
};

/**
 * A titled frame.
 *
 * Ink has no box title, and the titles here are load-bearing — "report is of the
 * declared action shape, not of the receipt" is an admission that must not be
 * droppable. So the top edge is drawn by hand as one Text and the box below it
 * carries only its left, right and bottom edges. Cost is still exactly two rows,
 * which is what the fit() budget assumes.
 */
export const Frame = ({ width, height, title, right, focused, children }) => {
  const l = title ? ` ${title} ` : "";
  const r = right ? ` ${right} ` : "";
  const fill = Math.max(0, width - 2 - l.length - r.length);
  const color = focused ? C.borderFocus : C.border;
  // `height` is the overlay's whole row budget, clipped. A child that draws one
  // row more than the caller budgeted for — a doctor row whose name wraps in a
  // 23-column gutter did, below 74 columns — otherwise pushes the frame to
  // stdout.rows and Ink clears the terminal (ink/build/ink.js:121).
  return html`
    <${Box} flexDirection="column" width=${width} height=${height}
      overflow=${height ? "hidden" : undefined}>
      <${Text} color=${color}>${"┌" + l + "─".repeat(fill) + r + "┐"}<//>
      <${Box}
        flexDirection="column"
        width=${width}
        borderStyle="round"
        borderTop=${false}
        borderColor=${color}>
        ${children}
      <//>
    <//>`;
};
