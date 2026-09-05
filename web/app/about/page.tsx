import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { Nav } from "../../components/Nav.tsx";
import { Code } from "../../components/Code.tsx";
import { Section } from "../../components/Section.tsx";
import { Footer } from "../../components/Footer.tsx";
import { AsciiPanel } from "../../components/viz/AsciiPanel.tsx";
import { Develop } from "../../components/Develop.tsx";

/**
 * About, and the page the disclosure statement hangs off.
 *
 * Short on purpose. Everything a reader would want from an "about" page on a product like this
 * is either on `/pitch/` or is generated at `/about/disclosure/`; what is left is what the
 * project is and what it is not, and the second half is the longer one.
 */
export const metadata: Metadata = {
  title: `About — ${SITE.name}`,
  description: SITE.about.lede,
};

export default function About() {
  return (
    <>
      <Nav current="about" />

      <main className="page">
        <header className="doc-head">
          <h1>About</h1>
          <p className="tagline">{SITE.about.lede}</p>
        </header>

        <div className="panels panels-wide">
          <Develop>
            <AsciiPanel
            cols={190}
            rows={34}
            blur={2.4}
            gain={1.25}
            crop={{ x: 0.06, y: 0.18, w: 0.88, h: 0.6 }}
            tag="THE DRAWING THE CLIENT SHIPS"
          />
          </Develop>
        </div>

        {/* The staircase — see `app/page.tsx` and `.grid-12` in `globals.css`. The opening
            statement flush left at seven columns, then down and inward: the label right-aligned
            in 1–3, the paragraph running 4–12 to the right margin. */}
        <Section n="01" id="what" title="WHAT IT IS">
          <p className="statement-lead col-7">{SITE.about.body[0]}</p>

          <div className="grid-12 step">
            <span className="col-note prose-label">METHOD</span>
            <p className="col-9 prose-body">{SITE.about.body[1]}</p>
          </div>

          <p className="cta">
            <a href="/about/disclosure/">The disclosure statement &rarr;</a>
          </p>
        </Section>

        <Section n="02" id="not-claimed" title="WHAT THIS DOES NOT CLAIM">
          <ul className="warnings">
            {SITE.doesNotClaim.map((line) => (
              <li key={line}><Code>{line}</Code></li>
            ))}
          </ul>
        </Section>
      </main>

      <Footer />
    </>
  );
}
