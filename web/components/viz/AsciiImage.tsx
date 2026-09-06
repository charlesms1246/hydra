import { imagePanel, runs } from "../../scripts/ascii-art.ts";

/**
 * A source image resolved into ASCII — Gestalt's `AsciiImage`, rendered at build time.
 *
 * **This is the per-card counterpart to the full-bleed drawing.** The drawing is the project's own
 * mark and has one subject; these have three, one per card, which is what stops the three cards
 * reading as one picture cropped three ways.
 *
 * The sources are the reference's own greyscale placeholders, and its docstring is honest about
 * what they are: *"generated placeholders, not artwork — three plain greyscale figures written by
 * a script so the ASCII pipeline could be verified end to end before real sources existed."*
 * Replacing the files in `public/ascii/` is the whole substitution; no code changes with them.
 *
 * Async because the decode is: a server component may await, and doing this at build time is what
 * keeps the browser from ever fetching the source.
 */
export async function AsciiImage({
  file,
  cols = 68,
  rows = 34,
  gain = 1,
  alt,
}: {
  file: string;
  cols?: number;
  rows?: number;
  gain?: number;
  /** Describes the subject, not the technique. */
  alt: string;
}) {
  const grid = await imagePanel({ file, cols, rows, gain });
  return (
    <div className="panel" role="img" aria-label={alt}>
      <pre className="panel-art" aria-hidden style={{ ["--cols" as string]: String(cols) }}>
        {grid.map((row, y) => (
          <span key={y} className="panel-row">
            {runs(row).map((r, i) => (
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
