/**
 * The launch screen: the mark, filling cyan from the centre out as the real
 * sources land, then sealing red from the outside in once they all have.
 *
 * Both phases are driven by one number per cell — its normalised radius, from
 * logo.mjs `rings()` — compared against a moving threshold. No per-cell state and
 * no per-frame allocation of the geometry: `rings()` is memoised on the size, so
 * a 26x97 mark is 1,372 comparisons per frame, which is cheap enough to run at
 * 20fps without the event loop showing it.
 *
 * Colour is applied by grouping each row into runs of the same colour, so a row
 * costs a handful of <Text> nodes rather than one per glyph. Ink reconciles the
 * former in microseconds and chokes visibly on the latter at this cell count.
 */

import { Box, Text } from "ink";
import { html, React } from "./ui.mjs";
import { C } from "./theme.mjs";
import { scaled, rings } from "./logo.mjs";

const { useMemo } = React;

/**
 * Durations, overridable so the suite does not pay two seconds per mounted App
 * and the sandbox can skip straight to a page. `HYDRA_SPLASH_MS=0` disables the
 * hold entirely; the seal still runs for one frame, so the transition is still
 * exercised rather than branched around.
 */
const envMs = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
/**
 * Read per call, not once at import.
 *
 * ESM hoists imports above every statement in the importing module, so a test
 * that sets `process.env.HYDRA_SPLASH_MS` at the top of its own file still runs
 * after this module has been evaluated. Constants captured at import time were
 * silently ignored, and the suite spent every App assertion photographing the
 * loading screen.
 */
export const timings = () => ({
  seal: envMs("HYDRA_SEAL_MS", 700),
  hold: envMs("HYDRA_SPLASH_MS", 1200),
});

/**
 * One row, as runs of equal colour.
 *
 * `load` fills cyan outward: a cell is lit once the fill radius reaches it.
 * `seal` fills red inward from the rim: a cell turns once the rim has passed it.
 * Unreached cells stay white, which is what makes the mark readable from frame
 * one instead of appearing out of nothing.
 */
/**
 * The whole colour decision, as a pure function of one cell's radius.
 *
 * Extracted so it can be tested without a renderer: the component around it uses
 * hooks, and asserting the animation through rendered output does not work
 * either, because Ink's colour is chalk's and chalk turns itself off when the
 * stream is not a tty.
 */
export function colourAt(r, fill, seal) {
  if (seal !== null && seal !== undefined && r >= seal) return C.bad;
  return r <= fill ? C.accent : "white";
}

function runsFor(line, y, byRow, fill, seal) {
  const cells = byRow.get(y);
  if (!cells) return [{ text: line, color: C.muted }];
  const colorAt = new Map();
  for (const c of cells) colorAt.set(c.x, colourAt(c.r, fill, seal));
  const out = [];
  let run = "";
  let colour = null;
  for (let x = 0; x < line.length; x++) {
    const ch = line[x];
    const col = ch === " " ? colour ?? "white" : colorAt.get(x) ?? "white";
    if (colour === null || col === colour) { run += ch; colour = col; continue; }
    out.push({ text: run, color: colour });
    run = ch;
    colour = col;
  }
  if (run) out.push({ text: run, color: colour ?? "white" });
  return out;
}

/**
 * @param progress 0..1 — how much of the real work has reported in
 * @param seal     null while loading, else 0..1 — how far the red rim has closed
 * @param steps    [{ label, done }] — what is actually being waited on
 */
export const Splash = ({ cols, rows, progress, seal, steps, note }) => {
  // Two rows for the caption block, one for the step line, one of headroom.
  const artRows = Math.max(6, rows - 5);
  const art = useMemo(() => scaled(cols - 2, artRows), [cols, artRows]);
  const geom = useMemo(() => rings(art), [art]);
  const byRow = useMemo(() => {
    const m = new Map();
    for (const c of geom.cells) {
      if (!m.has(c.y)) m.set(c.y, []);
      m.get(c.y).push(c);
    }
    return m;
  }, [geom]);

  // Ease the fill so the middle of the mark does not fill in a single tick: the
  // centre holds few cells and the rim holds most, so a linear radius makes the
  // last 20% of the animation carry 60% of the glyphs.
  const fill = Math.pow(Math.max(0, Math.min(1, progress)), 0.7);
  const sealAt = seal === null ? null : 1 - Math.pow(Math.max(0, Math.min(1, seal)), 0.85);

  const pad = Math.max(0, Math.floor((cols - geom.cols) / 2));
  const left = " ".repeat(pad);

  const done = steps.filter((s) => s.done).length;
  const barW = Math.max(10, Math.min(48, cols - 20));
  const filled = Math.round(barW * (done / Math.max(1, steps.length)));
  const bar = "━".repeat(filled) + "─".repeat(barW - filled);
  const pending = steps.find((s) => !s.done);

  return html`
    <${Box} flexDirection="column" width=${cols} height=${rows}>
      ${art.map((line, y) => html`
        <${Text} key=${"r" + y} wrap="truncate">
          ${left}${runsFor(line, y, byRow, fill, sealAt).map((r, i) =>
            html`<${Text} key=${i} color=${r.color}>${r.text}<//>`)}
        <//>`)}
      <${Box} height=${1} />
      <${Box} justifyContent="center">
        <${Text} color=${sealAt !== null ? C.bad : C.accent}>${bar}<//>
      <//>
      <${Box} justifyContent="center">
        <${Text} color=${C.muted}>
          ${sealAt !== null
            ? note ?? "ready"
            : `${pending?.label ?? "ready"} · ${done}/${steps.length}`}
        <//>
      <//>
    <//>`;
};
