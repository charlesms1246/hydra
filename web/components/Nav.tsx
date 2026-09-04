/**
 * The nav — Gestalt's `PillNav`, ported.
 *
 * **An earlier version of this file put the page links inline in the bar**, on the reasoning that
 * a dropdown "buys nothing across five destinations". That was a judgement substituted for the
 * instruction, and it threw away the two things that make the reference's bar work:
 *
 * 1. **The bar is a fixed width and never resizes.** Page names live in the panel, so the chrome
 *    is the same shape on every route. Inline links made the bar's width a function of how many
 *    pages exist, which is how a nav starts crowding at five and breaks at seven.
 * 2. **The dots are a position indicator, not decoration.** One per page, the current one
 *    accented. That is how the bar says where you are without a label — which is precisely what
 *    lets it stay a fixed width.
 *
 * **Ported without the script.** The reference is a client component: `useState` for open/closed,
 * an effect for Escape and outside-click, and a `grid-rows-[0fr]→[1fr]` transition. `<details>`
 * gives the disclosure, the keyboard behaviour and the semantics for free, so this stays a server
 * component and the menu works with no JavaScript at all. What is lost is outside-click-to-close;
 * `Escape` still works because `<details>` is native.
 */

import { asciiBlock } from "../scripts/ascii-block.ts";
import { isPublicBuild } from "../scripts/build-mode.ts";

export type Page = "home" | "pitch" | "demo" | "install" | "about";

const LINKS: { id: Page; href: string; label: string }[] = [
  { id: "home", href: "/", label: "HOME" },
  { id: "pitch", href: "/pitch/", label: "PITCH" },
  { id: "demo", href: "/demo/", label: "DEMO" },
  { id: "install", href: "/install/", label: "INSTALL" },
  { id: "about", href: "/about/", label: "ABOUT" },
];

export function Nav({ current }: { current: Page }) {
  return (
    <div className="nav-shell">
      <details className="nav">
        <summary className="nav-bar">
          {/* The mark is a link on the reference. Inside a <summary> it cannot be — a nested
              interactive element is not reachable by keyboard — so home is the first row of the
              panel instead, which is also where the reference lists it. */}
          {/* The mark is a third party's trademark and cannot be served from a public host, so
              a published build falls back to the reference's own glyph — which is what Gestalt
              uses in this exact position anyway. See `scripts/build-mode.ts`. */}
          <span className="nav-mark" aria-hidden>
            {isPublicBuild()
              ? <span className="nav-glyph">&gt;|&lt;</span>
              : <img src="/hydra.svg" alt="" width="16" height="16" />}
          </span>

          {/* One dot per page, the current one accented. A position indicator rather than a
              label, so the bar never has to resize to fit a page name. */}
          <span className="nav-dots" aria-hidden>
            {LINKS.map((l) => (
              <i key={l.id} className={l.id === current ? "on" : undefined} />
            ))}
          </span>

          <span className="nav-toggle">
            <span className="nav-closed">MENU</span>
            <span className="nav-open">CLOSE</span>
          </span>
        </summary>

        <div className="nav-panel">
          <nav aria-label="Main">
            {LINKS.map((l, i) => (
              <a
                key={l.id}
                href={l.href}
                className={l.id === current ? "on" : undefined}
                aria-current={l.id === current ? "page" : undefined}
              >
                <span className="nav-index" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="nav-label">{l.label}</span>
              </a>
            ))}
          </nav>

          {/* The reference's falling glyph field. Generated at build time and scrolled with a
              CSS transform rather than re-rolled per frame in JavaScript — the effect is the
              reading window walking down a fixed pattern either way. */}
          <pre className="nav-ascii" aria-hidden>
            <span>{asciiBlock()}</span>
          </pre>
        </div>
      </details>
    </div>
  );
}
