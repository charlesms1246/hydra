/**
 * The nav — a fixed pill, the reference's own chrome.
 *
 * Plain anchors. The reference's version opens a dropdown panel, which needs script and buys
 * nothing across five destinations; the dots in the middle are the one piece of it worth keeping,
 * because they are what makes the bar read as an instrument rather than as a menu.
 *
 * **The route list lives here and nowhere else.** `test/site.test.ts` deliberately does not read
 * it — the tests enumerate the *built* pages instead. So a page that exists but is missing from
 * this bar is still checked, and a link here to a page that does not exist is a broken link
 * rather than an invisible one. Two independent views of the same set, which is the point: a
 * hand-kept list that the checker also trusts is a list nobody ever finds wrong.
 */

export type Page = "home" | "pitch" | "demo" | "install" | "about";

const LINKS: { id: Page; href: string; label: string }[] = [
  { id: "pitch", href: "/pitch/", label: "PITCH" },
  { id: "demo", href: "/demo/", label: "DEMO" },
  { id: "install", href: "/install/", label: "INSTALL" },
  { id: "about", href: "/about/", label: "ABOUT" },
];

export function Nav({ current }: { current: Page }) {
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
        {LINKS.map((l) => (
          <a key={l.id} href={l.href} aria-current={current === l.id ? "page" : undefined}>
            {l.label}
          </a>
        ))}
      </span>
    </nav>
  );
}
