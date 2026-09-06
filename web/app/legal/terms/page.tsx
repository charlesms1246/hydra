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

/**
 * The warranty and liability headings, read from `LICENSE` and found BY WHAT THEY SAY.
 *
 * ⛔ **This used to look for sections 15 and 16, and the day the licence changed it stopped the
 * build.** That was the guard working — GPL-3.0 carries that pair and Apache-2.0 does not — but
 * looking for a number was the weaker half of the idea. A number is a fact about one licence; the
 * page's claim is that the licence disclaims warranty and limits liability, and *that* is what
 * should be checked. So this matches the headings' own words and prints whatever numbers the file
 * gives them.
 *
 * ⛔ **THE NUMBERS WERE NOT TRANSLATED.** The repair available when the build went red was to map
 * GPL's 15 and 16 onto whichever Apache sections looked equivalent. That is the exact error this
 * page exists to prevent, committed by the page — so the file is read and the sections are found
 * by their titles, and if the licence changes again the same thing happens: it works if the terms
 * are there under any number, and it fails loudly if they are not.
 *
 * `Accepting Warranty or Additional Liability` deliberately does not match. It contains both
 * words and is a different thing — what a redistributor may offer on their own behalf — and a page
 * about what a reader is *not* promised has no business printing it.
 */
function warrantySections(): string[] {
  const path = join(process.cwd(), "..", "LICENSE");
  const headings = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\. \S/.test(l));

  const wanted = [/^\d+\.\s+disclaimer of warranty/i, /^\d+\.\s+limitation of liability/i];
  const found = wanted.map((re) => headings.filter((h) => re.test(h)));

  if (found.some((hits) => hits.length !== 1)) {
    throw new Error(
      `${path} must carry exactly one "Disclaimer of Warranty" section and one "Limitation of `
      + `Liability" section; found ${found[0].length} and ${found[1].length}. This page prints `
      + "those two headings and tells a reader the licence disclaims both. It is read rather than "
      + "typed so that a licence change cannot leave the claim standing over a file that stopped "
      + `supporting it. Numbered headings in the file: ${headings.length}.`,
    );
  }
  /*
   * The title only. GPL-3.0 put its section titles on their own line; Apache-2.0 runs the body on
   * from the same line, so printing the matched line whole would put half a paragraph in a list of
   * two headings. Split after the number, then take up to the first sentence end of what remains.
   */
  return found.map(([h]) => {
    const [, number, rest] = /^(\d+\.\s+)(.*)$/.exec(h) as RegExpExecArray;
    return number + rest.split(/(?<=\.)\s+(?=[A-Z])/)[0];
  });
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
