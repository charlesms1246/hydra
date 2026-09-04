import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { PageFrame } from "../../components/PageFrame.tsx";
import { Nav } from "../../components/Nav.tsx";
import { Section } from "../../components/Section.tsx";
import { Auditor } from "../../components/Auditor.tsx";
import { Footer } from "../../components/Footer.tsx";

/**
 * The pitch, and the highest-risk page on this site.
 *
 * Four of its five sections are hand-written persuasive copy about a privacy product, which is
 * the exact shape the forbidden-word check exists to police. That guard is load-bearing here in
 * a way it is nowhere else: `content.ts` holds the rule these sections are written to — say what
 * the project DOES, never what the reader GETS.
 *
 * **Section 03 is generated, and that is the point of the page.** The auditor can see the
 * communication graph. That is a fact about Hydra rather than a comparison, so hand-writing it
 * would be an asserted privacy claim and the check would refuse it — correctly. It is therefore
 * generated-on-the-page or absent-from-the-page, and absent is not an option: burying it here
 * while the page sells around it is precisely the move the whole mechanism exists to prevent.
 *
 * It renders the same `Auditor` component as `/about/disclosure`, so there is one implementation
 * and the two pages cannot drift.
 *
 * **The order is the argument.** 03 is the worst fact, at the largest type on the page. 04 is the
 * honest comparison, immediately after it. 05 makes the case only once both have been read. A
 * pitch that put 05 first would be selling around the other two.
 */
export const metadata: Metadata = {
  title: `Pitch — ${SITE.name}`,
  description: SITE.pitch.lede,
};

export default function Pitch() {
  const p = SITE.pitch;
  return (
    <>
      <PageFrame word={SITE.name.toUpperCase()} />
      <Nav current="pitch" />

      <main className="page">
        <header className="doc-head">
          <h1>Why this exists</h1>
          <p className="tagline">{p.lede}</p>
        </header>

        <Section n="01" id="problem" title="CONTENT IS THE EASY HALF">
          <div className="prose">
            <p>{p.problem.body[0]}</p>
            <p className="labelled">
              <span className="prose-label">{p.problem.label}</span>
              {p.problem.body[1]}
            </p>
          </div>
        </Section>

        <Section n="02" id="mechanism" title="WHAT IT ACTUALLY DOES">
          <div className="prose">
            <p>{p.mechanism.body[0]}</p>
            <p className="labelled">
              <span className="prose-label">{p.mechanism.label}</span>
              {p.mechanism.body[1]}
            </p>
          </div>
        </Section>

        {/*
          Generated. See the header — this is the one fact on the page that cannot be written by
          hand, and the one the page would be dishonest without.
        */}
        <Section n="03" id="auditor" title="WHO CAN SEE YOU TALKING">
          <Auditor />
        </Section>

        <Section n="04" id="worse" title="WHAT THIS IS WORSE AT">
          <div className="prose">
            <p>{p.worseAt.body[0]}</p>
            <p className="labelled">
              <span className="prose-label">{p.worseAt.label}</span>
              {p.worseAt.body[1]}
            </p>
          </div>
        </Section>

        <Section n="05" id="argument" title="WHY IT MIGHT STILL BE WORTH IT">
          <div className="prose">
            <p>{p.why.body[0]}</p>
            <p className="labelled">
              <span className="prose-label">{p.why.label}</span>
              {p.why.body[1]}
            </p>
          </div>
          <p className="cta">
            <a href="/about/disclosure/">Read what every party can see &rarr;</a>
          </p>
        </Section>
      </main>

      <Footer />
    </>
  );
}
