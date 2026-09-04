import type { ReactNode } from "react";

/**
 * The wrapper every figure on this site uses.
 *
 * **Figures are drawn from the same values the claims are, and that is the whole point of having
 * them.** A hand-authored diagram drifts the moment the thing it describes changes, and it drifts
 * SILENTLY — *a diagram that is wrong looks exactly like a diagram that is right.* There is no
 * forbidden-word check for a picture and no citation test for a bar chart, so the only defence is
 * that the drawing has no independent source: every number in these figures comes from `MEASURED`
 * or from `statement()`, the same functions the prose and the disclosure page render.
 *
 * Inline SVG, no library, no script, no request. It is the only kind of illustration that can
 * exist on a page with this site's constraints — and it happens to be the kind that can be
 * generated.
 *
 * `role="img"` with a real label rather than `aria-hidden`: these carry argument, not decoration,
 * so a reader who cannot see them gets the sentence instead.
 */
export function Figure({
  label,
  caption,
  viewBox,
  children,
}: {
  /** What the figure says, for anybody not looking at it. Not a title — a replacement. */
  label: string;
  caption?: ReactNode;
  viewBox: string;
  children: ReactNode;
}) {
  return (
    <figure className="fig">
      <svg viewBox={viewBox} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
        {children}
      </svg>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/**
 * The ink. Bound to the same custom properties as everything else, so a figure cannot introduce a
 * fourth colour — the palette rule applies to drawings exactly as it applies to type.
 */
export const INK = {
  accent: "var(--accent)",
  fg: "var(--white)",
  g80: "var(--g-80)",
  g64: "var(--g-64)",
  g48: "var(--g-48)",
  g32: "var(--g-32)",
  g20: "var(--g-20)",
  g12: "var(--g-12)",
} as const;

/** A monospace label, matching the site's metadata column. */
export function Tick({ x, y, children, fill = INK.g48, anchor = "start" }: {
  x: number; y: number; children: ReactNode; fill?: string; anchor?: "start" | "middle" | "end";
}) {
  return (
    <text x={x} y={y} fill={fill} textAnchor={anchor} className="fig-tick">
      {children}
    </text>
  );
}
