import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { Nav } from "../../components/Nav.tsx";
import { Section } from "../../components/Section.tsx";
import { WriteOn } from "../../components/WriteOn.tsx";
import { Footer } from "../../components/Footer.tsx";
import { Close } from "../../components/Close.tsx";

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

        {/*
          ⛔ `SITE.doesNotClaim` used to be repeated here. It is on `/about/disclosure/` and
          nowhere else now — one page holds every negative, by instruction, and a caveat printed
          in two places is a caveat that can be edited in one.

          What stands here instead is the thing this page is for: there are two tools, they are
          for different people, and a reader who has arrived at "about" is asking which.
        */}
        <Section n="02" id="tools" title="TWO TOOLS">
          <div className="why two">
            {SITE.demo.tools.map((t) => (
              <article key={t.id}>
                <span className="why-label">{t.who}</span>
                <h3><a href={t.href}>{t.name}</a></h3>
                <WriteOn text={t.body} />
                <p className="cta cta-inline">
                  <a href={t.href}>See {t.name} &rarr;</a>
                </p>
              </article>
            ))}
          </div>
        </Section>

        <Section n="03" id="disclosure" title="AND ONE PAGE OF CAVEATS">
          <p className="statement-lead col-7">
            Everything this project does not claim, is not ready for, and cannot hide from you is
            on a single page, generated from the code that makes each line true.
          </p>
          <p className="cta">
            <a href="/about/disclosure/">Read what every party can see &rarr;</a>
          </p>
        </Section>

      </main>

      <Close
        line="Two tools, one argument: the disclosures are computed rather than described."
        primary={{ href: "/about/disclosure/", label: "Read what every party can see" }}
        secondary={{ href: "/demo/", label: "See it run" }}
      />

      <Footer />
    </>
  );
}
