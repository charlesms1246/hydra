import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { PageFrame } from "../../components/PageFrame.tsx";
import { Nav } from "../../components/Nav.tsx";
import { Section } from "../../components/Section.tsx";
import { Footer } from "../../components/Footer.tsx";

/**
 * The demo index: two tools, two pages, and a page that sends you to the right one.
 *
 * They are genuinely different products for different people — one sends messages, one stands up
 * a local privacy stack — and collapsing them into a single demo would misrepresent both. What
 * this page must not do is imply either is more finished than it is: both run in a terminal,
 * neither has a graphical interface, and nothing is hosted.
 */
export const metadata: Metadata = {
  title: `Demo — ${SITE.name}`,
  description: SITE.demo.lede,
};

export default function Demo() {
  return (
    <>
      <PageFrame word={SITE.name.toUpperCase()} />
      <Nav current="demo" />

      <main className="page">
        <header className="doc-head">
          <h1>See it run</h1>
          <p className="tagline">{SITE.demo.lede}</p>
        </header>

        <Section n="01" id="tools" title="TWO TOOLS">
          <div className="why two">
            {SITE.demo.tools.map((t) => (
              <article key={t.id}>
                <span className="why-label">{t.who}</span>
                <h3>
                  <a href={t.href}>{t.name}</a>
                </h3>
                <p>{t.body}</p>
                <p className="cta cta-inline">
                  <a href={t.href}>See {t.name} &rarr;</a>
                </p>
              </article>
            ))}
          </div>
        </Section>
      </main>

      <Footer />
    </>
  );
}
