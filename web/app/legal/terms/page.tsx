import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SITE } from "../../../content.ts";
import { Nav } from "../../../components/Nav.tsx";
import { Reveal } from "../../../components/Reveal.tsx";
import { Section } from "../../../components/Section.tsx";
import { Footer } from "../../../components/Footer.tsx";
import { Close } from "../../../components/Close.tsx";

/**
 * Terms of use, which are the licence's, because there is no second party to have any others.
 *
 * ⛔ **This page exists to be found, not to be agreed to.** A reader looking for terms of use is
 * asking a real question — what am I bound by, and by whom — and a footer with no answer to it
 * reads as an oversight. The answer here happens to be short, and the short true answer is worth
 * more than the long conventional one, which would have to invent an operator, a jurisdiction and
 * a dispute procedure in order to have anything to say.
 *
 * The warranty headings are read from `LICENSE` rather than typed, for the same reason the
 * licence page reads its title: a section number that has drifted is a citation that sends a
 * reader to the wrong paragraph, and nothing about typing it here would ever catch that.
 */
export const metadata: Metadata = {
  title: `Terms of use — ${SITE.name}`,
  description:
    "There is no operator to agree with. The licence governs the code, including its warranty "
    + "sections, read from the licence file.",
};

/** The warranty and liability headings, read from `LICENSE`. */
function warrantySections(): string[] {
  const path = join(process.cwd(), "..", "LICENSE");
  const found = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^1[56]\. \S/.test(l));
  if (found.length !== 2) {
    throw new Error(
      `expected sections 15 and 16 in ${path} and found ${found.length}. This page cites them by `
      + "number; a citation nobody re-derived is how a reader gets sent to the wrong paragraph.",
    );
  }
  return found;
}

export default function Terms() {
  const sections = warrantySections();
  return (
    <>
      <Nav current="legal" />

      <main className="page">
        <header className="doc-head">
          <Reveal>
            <h1>Terms of use</h1>
            <p className="tagline">
              What you are bound by, and who by. The second half is the shorter answer.
            </p>
          </Reveal>
        </header>

        <Section n="01" id="operator" title="NO OPERATOR">
          <Reveal>
            <p className="statement-lead col-7">
              Terms of use are an agreement between a reader and whoever runs a site. There is no
              legal person on the other side of this one.
            </p>
          </Reveal>
          <Reveal className="grid-12 step">
            <span className="col-note prose-label">CHECKED</span>
            <p className="col-9 prose-body">
              That is not a turn of phrase. No company, contact address or ownership line appears
              anywhere on this site, and a test in <code>web/test/site.test.ts</code> fails the
              build if one does — so nothing here can quietly start speaking for an entity that
              was never formed. There is no account to open, nothing to subscribe to, and no
              condition attached to reading a page.
            </p>
          </Reveal>
        </Section>

        <Section n="02" id="code" title="WHAT GOVERNS IT">
          <Reveal>
            <p className="statement-lead col-7">The licence in the repository, and only that.</p>
          </Reveal>
          <Reveal className="grid-12 step">
            <span className="col-note prose-label">LICENCE</span>
            <p className="col-9 prose-body">
              Using, copying and changing the software is covered by <code>LICENSE</code>, which
              is named on <a href="/legal/license/">the licence page</a> by reading it. This page
              adds nothing to it. A terms document that added a restriction the licence does not
              impose would be attempting to take back a grant somebody already has.
            </p>
          </Reveal>
        </Section>

        <Section n="03" id="warranty" title="NO WARRANTY">
          <Reveal>
            <p className="statement-lead col-7">
              The licence disclaims warranty and liability. It says so in its own words, in two
              numbered sections.
            </p>
          </Reveal>
          <Reveal className="step">
            <ul className="warnings" data-generated="license">
              {sections.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </Reveal>
          <Reveal className="grid-12 step">
            <span className="col-note prose-label">OPERATIVE</span>
            <p className="col-9 prose-body">
              Read them in <code>LICENSE</code>. They are the operative text; the headings above
              are read from that file at build time so that this page cannot cite a section number
              that has moved.
            </p>
          </Reveal>
        </Section>
      </main>

      <Close
        line="Short, because the honest version of this document is short."
        primary={{ href: "/legal/license/", label: "License" }}
        secondary={{ href: "/legal/privacy/", label: "Privacy" }}
      />

      <Footer />
    </>
  );
}
