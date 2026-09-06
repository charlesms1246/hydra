import type { Span } from "../scripts/ansi.ts";

/**
 * A frame of the terminal interface, as markup.
 *
 * Both renders on this site end here: `Terminal.tsx` reads `tui-frames.json` on the server and
 * passes the captured spans in, and `LiveTerminal.tsx` calls `render()` in the browser at the
 * reader's own width and passes those. **One component, so there is one answer to what a frame
 * looks like** — the same reason `scripts/ansi.ts` holds one `spans()` and `scripts/tui-fixture.ts`
 * holds one fixture. Two copies of this markup would agree until somebody edited one.
 *
 * ## Tones, not colours
 *
 * `spans()` translates the renderer's SGR codes to tone NAMES, and `globals.css` decides what each
 * one looks like — `.t-green` and `.t-yellow` are both `--g-80`, and blue, magenta and cyan are all
 * `--accent`. **The palette is deliberately flatter than a terminal's**, and that flattening is the
 * reason the mapping is by name: anything that consumed the escape codes directly would bring a
 * terminal's sixteen colours back in and stop matching the frame beside it.
 */
export function Screen({ lines, cols, fit }: {
  lines: Span[][];
  cols: number;
  /**
   * `"scale"` shrinks a fixed grid to the container; `"fixed"` keeps the type readable and lets
   * the caller decide how many columns fit.
   *
   * The captured frame has no choice: it was rendered at 96 columns on a build machine, so the
   * only way to fit a phone is to make the glyphs smaller — about 6.7px at 390px wide, against a
   * 5px floor. That is what a live render is for. It re-renders at the number of columns that fit
   * at a readable size instead, which is a different frame rather than a smaller picture of the
   * same one.
   */
  fit: "scale" | "fixed";
}) {
  return (
    <div className="term">
      <pre
        className={fit === "fixed" ? "term-screen term-live" : "term-screen"}
        style={{ ["--cols" as string]: String(cols) }}
        aria-label="The terminal interface, as it renders."
      >
        {lines.map((line, y) => (
          <span key={y} className="term-line">
            {line.map((s, i) => (
              <span key={i} className={s.c.length ? s.c.map((c) => `t-${c}`).join(" ") : undefined}>
                {s.t}
              </span>
            ))}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}
