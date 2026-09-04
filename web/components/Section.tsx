import type { ReactNode } from "react";

/**
 * A numbered section: accent number over a large grotesk title, straddling a full-bleed hairline
 * rule, with the section's tick pinned to the rule at the far left.
 *
 * The number is not decoration. This page's argument is that its claims are traceable, and a
 * document that numbers its sections is one you can cite a part of — the same reason the tick
 * exists. It is the cheapest possible signal that the page expects to be checked rather than
 * read once.
 */
export function Section({
  n,
  title,
  children,
  id,
}: {
  n: string;
  title: string;
  children: ReactNode;
  id: string;
}) {
  return (
    <section className="section" id={id} aria-labelledby={`${id}-title`}>
      <div className="section-head">
        <span className="section-number" aria-hidden>
          {n}
        </span>
        <h2 className="section-title" id={`${id}-title`}>
          {title}
        </h2>
        <span className="section-tick" aria-hidden>
          SEC-{n}
        </span>
      </div>
      {children}
    </section>
  );
}
