import { Button } from "./Section.tsx";

/**
 * The closing beat every page ends on, which the reference has and we did not.
 *
 * Gestalt gives each page a final `Container` at `py-32 md:py-48`: one large centred statement and
 * the two things a reader can do next. Ours ended on whatever the last section happened to be and
 * then the footer, so every page trailed off rather than closing.
 *
 * **One component rather than a block per page**, for the reason the primitives exist at all: a
 * closing beat re-typed on six pages is six slightly different closing beats.
 */
export function Close({
  line,
  primary,
  secondary,
}: {
  line: string;
  primary: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    <section className="close">
      <div className="container">
        <p className="close-line">{line}</p>
        <div className="close-actions">
          <Button href={primary.href}>{primary.label}</Button>
          {secondary && <Button href={secondary.href}>{secondary.label}</Button>}
        </div>
      </div>
    </section>
  );
}
