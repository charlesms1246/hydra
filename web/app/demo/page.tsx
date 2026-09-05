import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { Nav } from "../../components/Nav.tsx";
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
      <Nav current="demo" />

      <main className="page">
        {/*
          ⛔ The lander is a routing question, not a page of prose: two tools, and a reader wants
          one of them. Title on the left, the two choices stacked on the right, and nothing
          between them to read first — the fastest arrangement for a decision that has two answers.
        */}
        <section className="lander">
          <div className="lander-head">
            <h1>See it run</h1>
            <p className="tagline">{SITE.demo.lede}</p>
          </div>

          <div className="lander-choices">
            {SITE.demo.tools.map((t) => (
              <a className="choice" key={t.id} href={t.href}>
                <span className="label">{t.who}</span>
                <span className="choice-name">{t.name}</span>
                <span className="choice-body">{t.body}</span>
                <span className="choice-go" aria-hidden>&rarr;</span>
              </a>
            ))}
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
