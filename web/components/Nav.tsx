/**
 * The nav — a fixed pill, the reference's own chrome.
 *
 * Plain anchors. The reference's version opens a dropdown panel, which needs script and buys
 * nothing across three destinations; the dots in the middle are the one piece of it worth
 * keeping, because they are what makes the bar read as an instrument rather than as a menu.
 *
 * `DISCLOSURES` is a real page and sits in the bar rather than in the footer. On the reference
 * it is a legal link buried at the bottom; here it is the thing the product is actually for, and
 * the distance between those two facts is most of what this site is trying to say.
 */
export function Nav({ current }: { current: "home" | "disclosures" }) {
  return (
    <nav className="nav" aria-label="Primary">
      <a className="nav-mark" href="/" aria-label="Hydra, home">
        {/* Plain <img>, not next/image: the export has no optimiser, and an SVG has nothing to
            optimise. Decorative — the accessible name is on the link. */}
        <img src="/hydra.svg" alt="" width="18" height="18" />
      </a>
      <span className="nav-dots" aria-hidden>
        <i /><i /><i /><i /><i />
      </span>
      <span className="nav-links">
        <a href="/disclosures/" aria-current={current === "disclosures" ? "page" : undefined}>
          DISCLOSURES
        </a>
      </span>
    </nav>
  );
}
