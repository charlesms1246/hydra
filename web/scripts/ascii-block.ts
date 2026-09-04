/**
 * The nav panel's glyph field, generated at build time.
 *
 * Ported from the reference's `AsciiBlock`, including its seeded hash so the field is
 * deterministic — which here is load-bearing rather than tidy: this is rendered on the server and
 * sent as markup, so a random field would differ between the build and any re-render.
 *
 * The reference re-rolls the visible window every 190ms in JavaScript by sampling `r - frame`,
 * which walks the reading window down a fixed infinite pattern so each row inherits the one above
 * it. This emits twice the visible rows and CSS translates it, which is the same idea with the
 * loop in the compositor instead of on the main thread.
 */

/** The reference's glyphs, with Hydra's letters in place of Gestalt's. */
const GLYPHS = ["H", "Y", "D", "R", "A", ".", "/", ":", "-", ">", "<", " ", " ", " "];

const seeded = (i: number): number => {
  const n = Math.sin(i * 12.9898) * 43758.5453;
  return n - Math.floor(n);
};

export function asciiBlock(rows = 28, cols = 46): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      // Weighted toward blank so the block reads as sparse scatter rather than a wall of type.
      line += seeded(i) > 0.62 ? GLYPHS[Math.floor(seeded(i + 7) * GLYPHS.length)] : " ";
    }
    out.push(line);
  }
  return out.join("\n");
}
