import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { Nav } from "../../components/Nav.tsx";
import { Reveal } from "../../components/Reveal.tsx";
import { Section } from "../../components/Section.tsx";
import { Code } from "../../components/Code.tsx";
import { Footer } from "../../components/Footer.tsx";
import { Close } from "../../components/Close.tsx";

/**
 * How to actually run this, which today means from a checkout.
 *
 * **There is no published package and this page does not pretend there is.**
 * `@hydra-platform/cli` is `private: true` at version `0.0.0`; `hydra-devtool` is publishable and
 * unpublished. An install page describing a package nobody can fetch is the most concrete false
 * claim available to a site, and the one a reader tests first — within about ten seconds, at a
 * shell prompt, and the answer is a 404. So the commands here are the ones that work, and the
 * `bin: hydra` name appears as a note about the future rather than as an instruction.
 *
 * If that reads badly, that is information about readiness rather than a copy problem.
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

        <Section n="01" id="steps" title="FROM A CHECKOUT">
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
