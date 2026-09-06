import type { Metadata } from "next";

import { SITE } from "../../../content.ts";
import { Nav } from "../../../components/Nav.tsx";
import { Reveal } from "../../../components/Reveal.tsx";
import { Section } from "../../../components/Section.tsx";
import { Footer } from "../../../components/Footer.tsx";
import { Close } from "../../../components/Close.tsx";

/**
 * The privacy policy, which is short because there is little to describe.
 *
 * ⛔ **THE FAILURE MODE THIS PAGE IS WRITTEN AGAINST.** A privacy policy is the standard place to
 * describe data handling nobody implemented — retention periods for a store that does not exist,
 * a lawful basis for processing that never happens, a rights procedure with no address behind it.
 * That is the exact defect the rest of this site argues against, in the genre where it is most
 * normal. So every sentence here names the mechanism that makes it true, and a sentence that
 * could not name one was deleted rather than softened.
 *
 * **What it deliberately does not do is restate the disclosures.** What the pool, the vault and
 * the relay can see about a message is one page's subject, by instruction, and a privacy policy
 * that summarised it would be the second copy that goes stale. This page is about the website.
 */
export const metadata: Metadata = {
  title: `Privacy — ${SITE.name}`,
  description:
    "What this website collects, which is nothing, and the mechanism behind each sentence.",
};

export default function Privacy() {
  return (
    <>
      <Nav current="legal" />

      <main className="page">
        <header className="doc-head">
          <Reveal>
            <h1>Privacy</h1>
            <p className="tagline">
              This is about the website. Every line names what makes it true.
            </p>
          </Reveal>
        </header>

        <Section n="01" id="collected" title="WHAT THIS SITE COLLECTS">
          <Reveal>
            <p className="statement-lead col-7">Nothing, because there is nothing here to do it.</p>
          </Reveal>
          <Reveal>
            <p className="col-7">
              The site is a static export — <code>output: &quot;export&quot;</code> in{" "}
              <code>web/next.config.ts</code> — so what a host serves is a directory of files. No
              code of ours runs when you open a page, which means there is no form to submit, no
              account to hold and no request of yours for this site to record.
            </p>
          </Reveal>
        </Section>

        <Section n="02" id="loaded" title="WHAT YOUR BROWSER LOADS">
          <Reveal>
            <p className="statement-lead col-7">
              Only files from wherever you are reading this.
            </p>
          </Reveal>
          <Reveal>
            <ul className="warnings">
              <li>
                No analytics or telemetry package is installed. The check is a test of the same
                name in <code>web/test/site.test.ts</code>, which reads the manifest rather than
                trusting the intention.
              </li>
              <li>
                Nothing is fetched from anywhere else. The fonts are served from this site, there
                is no tag, no embed and no content network, and a test walks the built pages for
                any absolute address that is not one of the two source links in the footer.
              </li>
              <li>
                Nothing is written to your browser. No cookie is set and no storage is used; a
                test walks the JavaScript in the built site for the four APIs that could.
              </li>
            </ul>
          </Reveal>
        </Section>

        <Section n="03" id="session" title="THE ONE PAGE THAT MAKES A REQUEST">
          <Reveal>
            <p className="statement-lead col-7">
              The session page talks to your own machine, and to nothing else.
            </p>
          </Reveal>
          <Reveal>
            <p className="col-7">
              It drives a session over <code>hydra gui</code>&apos;s local API — by default{" "}
              <code>http://127.0.0.1:8787</code>, or an address you hand it. That address is the
              only one it ever calls. If you open it from a link carrying a token, the token is
              held in memory for the life of the tab and taken out of the address bar before
              anything can read it there, including a screenshot. It is not stored anywhere.
              See <code>web/components/Session.tsx</code>.
            </p>
          </Reveal>
        </Section>

        <Section n="04" id="host" title="WHAT THIS PAGE CANNOT SPEAK FOR">
          <Reveal>
            <p className="statement-lead col-7">
              Whoever serves you these files sees that they served them.
            </p>
          </Reveal>
          <Reveal>
            <p className="col-7">
              A web server logs the request: an address, a time, a path. That is the host&apos;s
              behaviour and not this site&apos;s, and no sentence written here would change it —
              which is why the honest thing is to say so rather than to write a paragraph that
              sounds like a guarantee. The files are static, so you can also serve them yourself
              from a checkout and remove the question.
            </p>
          </Reveal>
        </Section>
      </main>

      <Close
        line="Nothing here watches you read it."
        primary={{ href: "/legal/terms/", label: "Terms of use" }}
        secondary={{ href: "/legal/license/", label: "License" }}
      />

      <Footer />
    </>
  );
}
