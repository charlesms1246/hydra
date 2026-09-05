import { panel, runs, type PanelOptions } from "../../scripts/ascii-art.ts";

/**
 * A dithered ASCII field rendered as page content, not as a backdrop.
 *
 * **This is the site's visual mass.** The reference's pages are carried by large dense fields
 * rendered from real imagery; without an equivalent this site is a document with rules on it. The
 * field is generated from `art.txt` — the hydra the TUI draws — so it is the project's own
 * picture, it ships in the public build, and it costs no request.
 *
 * Sized by container query rather than by a fixed font size: the glyph grid has a known column
 * count, so `100cqw / (cols × 0.6)` is the size at which exactly that many monospace advances fill
 * the panel. It stays a grid at every width instead of wrapping or clipping.
 *
 * `aria-hidden` — unlike the figures, this carries no argument. It is the picture.
 */
export function AsciiPanel({
  tag,
  className,
  ...options
}: PanelOptions & { tag?: string; className?: string }) {
  const grid = panel(options);
  return (
    <div className={`panel${className ? ` ${className}` : ""}`}>
      {tag && <span className="panel-tag">{tag}</span>}
      <pre
        className="panel-art"
        aria-hidden
        style={{ ["--cols" as string]: String(options.cols) }}
      >
        {grid.map((row, y) => (
          <span key={y} className="panel-row">
            {runs(row).map((r, i) => (
              /*
                `--g` carries the run's grey step into CSS so the field can DEVELOP without any
                of it being recomputed in the browser — see `Develop.tsx` and `.panel-art span`.
                The colour is the same value; this is the one number the reveal needs, and
                emitting it here costs nothing because the run is already being written.
              */
              <span key={i} style={{ color: `var(--g-${r.grey})`, ["--g" as string]: r.grey }}>
                {r.text}
              </span>
            ))}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}
