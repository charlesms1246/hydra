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
        {/*
          The title is BRACKETED BY TWO RULES rather than straddling one, and the tick lives
          inside that band.

          The earlier arrangement ran a single rule under the title and knocked a black box out
          of it so the tick would not sit on the line. That works on paper and fails here: the
          box is a hole punched through the ASCII field behind it, and against a moving
          background a hole reads as a rendering fault rather than as type. Two rules give the
          same ruled-band structure with nothing to knock out — which is why the reference's
          rules run unbroken from margin to margin.
        */}
        <div className="section-band">
          <span className="section-tick" aria-hidden>
            SEC-{n}
          </span>
          <h2 className="section-title" id={`${id}-title`}>
            {title}
          </h2>
        </div>
      </div>
      {/*
        ⛔ The section's content sits in ONE column, and the head is the only thing that leaves it.

        Measured across six pages before this existed: content blocks landed on four different
        left edges — 0 (full bleed), 58 (the gutter), 176 (`.auditor`, centred at its own width)
        and 224 (the measure). `.deps` was the tell: 992px wide, the same width as the prose above
        it, and starting 166px to its left. **Two container models on one page is what a reader
        registers as sloppiness without being able to name it.**

        So blocks inside a section share `--measure` and align to its left edge, while the ruled
        band and the full-bleed panels break out deliberately. One column, and exceptions that
        look like exceptions.
      */}
      <div className="section-body">{children}</div>
    </section>
  );
}
