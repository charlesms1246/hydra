import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { PageFrame } from "../../components/PageFrame.tsx";
import { Nav } from "../../components/Nav.tsx";
import { Section } from "../../components/Section.tsx";
import { Footer } from "../../components/Footer.tsx";

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
      <PageFrame word={SITE.name.toUpperCase()} />
      <Nav current="about" />

      <main className="page">
        <header className="doc-head">
          <h1>About</h1>
          <p className="tagline">{SITE.about.lede}</p>
        </header>

        <Section n="01" id="what" title="WHAT IT IS">
          <div className="prose">
            <p>{SITE.about.body[0]}</p>
            <p className="labelled">
              <span className="prose-label">METHOD</span>
              {SITE.about.body[1]}
            </p>
          </div>
          <p className="cta">
            <a href="/about/disclosure/">The disclosure statement &rarr;</a>
          </p>
        </Section>

        <Section n="02" id="not-claimed" title="WHAT THIS DOES NOT CLAIM">
          <ul className="warnings">
            {SITE.doesNotClaim.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Section>
      </main>

      <Footer />
    </>
  );
}
