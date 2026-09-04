/**
 * Dithered ASCII imagery, generated from the project's own drawing at build time.
 *
 * **This is the site's picture, and it had to be generated rather than found.** The reference's
 * visual mass is dense dithered fields rendered from real images; the equivalent here cannot be a
 * rasterised logo, because the mark is a third party's trademark and absent from a public build.
 * `art.txt` — the hydra the TUI draws on its own Disclosure screen — is the project's, is
 * committed, and ships in both builds.
 *
 * ## Turning a silhouette into a field
 *
 * The source is effectively binary: 100×52 of `.` and space. Rendered straight it is a flat
 * stencil. What gives the reference's art depth is a **continuous** luminance per cell, so:
 *
 * 1. **Box-sample with a soft radius.** Each output cell averages a disc of source cells, which
 *    turns a hard edge into a gradient — the interior reads solid, the boundary falls off, and
 *    the falloff is what the ramp has something to say about.
 * 2. **Bayer-dither the result.** An ordered 4×4 threshold breaks banding into texture at the
 *    scale of a character, which is the difference between a shape filled with `#` and a shape
 *    that looks drawn.
 * 3. **Two channels out, not one.** Each cell gets a glyph from the ramp *and* a step on the grey
 *    scale. The reference does the same, and it is why its fields have depth rather than being
 *    monochrome noise: brightness is carried twice, by which character and by how bright it is.
 *
 * ## Why runs rather than a span per character
 *
 * A 190×96 field is 18,000 glyphs. One element each is a page nobody can scroll. Consecutive
 * glyphs sharing a grey step are emitted as a single span, which takes it to a few hundred — the
 * output is static markup, so this is the difference between a page that ships and one that
 * hangs, and it costs nothing at render time because the grouping happens here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Darkest to brightest. The reference's ramp, with the leading space kept so voids stay void. */
const RAMP = " .:-=+*#%@";

/** Grey steps the glyphs are drawn in, matching the palette's ramp variables. */
export const GREYS = [8, 12, 20, 32, 48, 64, 80] as const;

/** Ordered 4×4 threshold matrix, normalised to 0..1. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

export type Cell = { ch: string; grey: number };

let source: string[] | null = null;

function art(): string[] {
  if (!source) {
    source = readFileSync(join(process.cwd(), "art.txt"), "utf8").replace(/\n$/, "").split("\n");
  }
  return source;
}

export type PanelOptions = {
  cols: number;
  rows: number;
  /** Region of the source to show, 0..1. Different crops give different panels one drawing. */
  crop?: { x: number; y: number; w: number; h: number };
  /** Sampling radius in source cells. Larger is softer and reads as more distant. */
  blur?: number;
  /** Multiplies luminance before the ramp. Above 1 blows out the interior; below 1 thins it. */
  gain?: number;
  /** Rotates the sampled field, so two panels of one drawing do not read as the same object. */
  rotate?: number;
};

/**
 * Render one panel as rows of cells.
 *
 * Deterministic: same options in, same field out, so this can run at build time and the markup is
 * stable across rebuilds. Nothing here is random — the texture comes from the dither, not noise.
 */
export function panel({
  cols,
  rows,
  crop = { x: 0, y: 0, w: 1, h: 1 },
  blur = 1.6,
  gain = 1,
  rotate = 0,
}: PanelOptions): Cell[][] {
  const src = art();
  const sh = src.length;
  const sw = Math.max(...src.map((l) => l.length));
  const ink = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= sw || y >= sh) return 0;
    const c = src[Math.floor(y)]?.[Math.floor(x)];
    return c && c !== " " ? 1 : 0;
  };

  const cos = Math.cos(rotate);
  const sin = Math.sin(rotate);
  const out: Cell[][] = [];

  for (let r = 0; r < rows; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < cols; c++) {
      // Normalised position inside the crop, then rotated about the crop's centre.
      let u = crop.x + (c / (cols - 1)) * crop.w;
      let v = crop.y + (r / (rows - 1)) * crop.h;
      if (rotate) {
        const du = u - 0.5;
        const dv = v - 0.5;
        u = 0.5 + du * cos - dv * sin;
        v = 0.5 + du * sin + dv * cos;
      }
      const sx = u * sw;
      const sy = v * sh;

      // Soft box sample: the step that turns a stencil into something with a falloff.
      let sum = 0;
      let n = 0;
      for (let dy = -blur; dy <= blur; dy += 1) {
        for (let dx = -blur; dx <= blur; dx += 1) {
          if (dx * dx + dy * dy > blur * blur) continue;
          sum += ink(sx + dx, sy + dy);
          n++;
        }
      }
      const d = Math.min(1, (sum / Math.max(n, 1)) * gain);

      // Ordered dither, then split the same value across both output channels.
      const t = BAYER[r % 4][c % 4];
      const lit = Math.max(0, Math.min(0.999, d + (d > 0 ? (t - 0.5) * 0.22 : 0)));
      const ch = RAMP[Math.floor(lit * (RAMP.length - 1))];
      const grey = GREYS[Math.min(GREYS.length - 1, Math.floor(lit * GREYS.length))];
      row.push({ ch, grey });
    }
    out.push(row);
  }
  return out;
}

/** One row collapsed into runs of equal grey — see the note above on why this is not optional. */
export function runs(row: Cell[]): { text: string; grey: number }[] {
  const out: { text: string; grey: number }[] = [];
  for (const cell of row) {
    const last = out[out.length - 1];
    if (last && last.grey === cell.grey) last.text += cell.ch;
    else out.push({ text: cell.ch, grey: cell.grey });
  }
  return out;
}
