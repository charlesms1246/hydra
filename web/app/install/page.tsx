import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { Nav } from "../../components/Nav.tsx";
import { Reveal } from "../../components/Reveal.tsx";
import { Section } from "../../components/Section.tsx";
import { Code } from "../../components/Code.tsx";
import { Footer } from "../../components/Footer.tsx";
import { Close } from "../../components/Close.tsx";

/**
 * How to actually run this, which now means `npm install -g hydra-strk`.
 *
 * ⛔ **THE RULE DID NOT CHANGE, THE FACT DID.** This said *"there is no published package and this
 * page does not pretend there is"* — because an install page describing a package nobody can fetch
 * is the most concrete false claim available to a site, and the one a reader tests first, at a
 * shell prompt, in about ten seconds. The client is published as `hydra-strk`, so the command here
 * is now one that works. `hydra-devtool` is still unpublished, so it is still a checkout, and the
 * step for it must not borrow the client's install line.
 *
 * The section headings come from the steps rather than naming a route: step 01 is npm and step 04
 * is a clone, so a heading that said FROM A CHECKOUT would be wrong about three quarters of the
 * list.
 *
 * The readiness warnings are ON this page rather than linked from it. Somebody here is closer to
 * running this than a reader anywhere else on the site, which makes it the right place for them.
 */
export const metadata: Metadata = {
  title: `Install — ${SITE.name}`,
  description: SITE.install.lede,
};

/*
 * The dependency manifest that used to be generated here now lives on `/legal/license/`, still
 * generated. It answers a licensing question — whose work is in this, under what terms — and an
 * install page that also carried it made the reader scroll past a package list to reach a
 * command. What stays here is what you type.
 */
export default function Install() {
  return (
    <>
      <Nav current="install" />

      <main className="page">
        <header className="doc-head">
          <Reveal>
          <h1>Run it</h1>
          <p className="tagline">{SITE.install.lede}</p>
          </Reveal>
        </header>

        <Section n="01" id="steps" title="RUN IT">
          <ol className="steps">
            {SITE.install.steps.map((s) => (
              <li key={s.label}>
                <span className="step-label" aria-hidden>{s.label}</span>
                <h3>{s.title}</h3>
                <pre className="terminal">
                  <code>{s.commands.map((c) => `$ ${c}`).join("\n")}</code>
                </pre>
                <p><Code>{s.note}</Code></p>
              </li>
            ))}
          </ol>
        </Section>

        <Section n="02" id="warnings" title="BEFORE YOU RUN IT">
          <ul className="warnings">
            {SITE.install.warnings.map((w) => (
              <li key={w}><Code>{w}</Code></li>
            ))}
          </ul>
        </Section>
      </main>

      <Close
        line="What you get is a working client and a local privacy stack."
        primary={{ href: "/demo/", label: "See it run" }}
        secondary={{ href: "/session/", label: "Drive your session" }}
      />

      <Footer />
    </>
  );
}
