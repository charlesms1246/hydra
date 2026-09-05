import type { ReactNode } from "react";

import { Reveal } from "./Reveal.tsx";

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
      {/* The head animates too. It is outside `.section-body`, which is exactly the kind of gap a
          "wrap the container" fix leaves behind — found by walking the rendered page for text not
          inside an animated wrapper, rather than by looking. */}
      <Reveal className="section-head">
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
      </Reveal>
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
      {/*
        ⛔ Every section's content animates, without each page having to remember.

        The instruction is that all text on the site is animated with no exceptions, and the way
        to have no exceptions is not to wrap things one at a time — it is for the container that
        every section's content already passes through to do it. A page that forgets is not
        possible, because there is nothing to forget.
      */}
      <Reveal className="section-body">{children}</Reveal>
    </section>
  );
}

/**
 * The page's container: the 86rem measure and the gutter, expressed once.
 *
 * ⛔ **Everything on a page sits in this or is a deliberate full-bleed exception.** Before it
 * existed the measure was re-typed as a `max-width` on eight different selectors, which is how a
 * site ends up with four left edges on one page — each value locally reasonable, none of them
 * agreeing. `Section` uses it, and anything outside a section should too.
 */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `container ${className}` : "container"}>{children}</div>;
}

/**
 * A tracked-out monospace label: eyebrows, ticks, column heads, margin notes.
 *
 * ⛔ **One label, one set of values.** There were fourteen independent expressions of this in the
 * stylesheet, at three sizes and eight letter-spacings, because there was nothing to consume and
 * so everybody typed one. The values live in `.label` in `globals.css`; this is the component
 * form for new markup.
 */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={className ? `label ${className}` : "label"}>{children}</span>;
}

/**
 * Prose that carries its own opaque ground.
 *
 * The reference's reason is worth keeping verbatim in spirit: rendered ASCII glyphs behind a
 * paragraph are the same size and weight as the paragraph's own letterforms, so without a ground
 * the two interleave and both become unreadable. **A blurred field is soft enough to read over; a
 * crisp one is not.**
 *
 * We need it in fewer places than they do, because `.field` now scrolls off the top of the page
 * and `.solids` fades within half a viewport — so most prose is already over black. It exists for
 * the cases that are not: anything set over a panel or inside the first screen.
 */
export function Plate({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `plate ${className}` : "plate"}>{children}</div>;
}

/**
 * The button.
 *
 * ⛔ **Written once because it was already written twice** — the deck's rail and the session
 * page's connect control were styled independently, which is the drift this whole extraction is
 * about, caught before it had a third instance.
 */
export function Button({
  children,
  href,
  type = "button",
  onClick,
}: {
  children: ReactNode;
  href?: string;
  type?: "button" | "submit";
  onClick?: () => void;
}) {
  if (href) return <a className="button" href={href}>{children}</a>;
  return <button className="button" type={type} onClick={onClick}>{children}</button>;
}
