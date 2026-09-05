import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { Nav } from "../../components/Nav.tsx";
import { Section } from "../../components/Section.tsx";
import { Footer } from "../../components/Footer.tsx";
import { Close } from "../../components/Close.tsx";
import { Session, AttributionLegend } from "../../components/Session.tsx";

/**
 * The session page: a surface for the client running on the reader's own machine.
 *
 * **This is the only page on this site that does anything, and it does all of it against
 * `127.0.0.1`.** Nothing here is fetched from the origin serving the page, nothing is stored, and
 * no request leaves the machine — the page is a renderer for an API the reader started themselves
 * and can stop.
 *
 * ⛔ **It is a static export like every other page.** There is no server behind it, and there must
 * not be: a page that talked to an origin would be a hosted service, which `SITE.doesNotClaim`
 * says this is not, and that sentence stays true because of what this file does not do.
 *
 * The shell is server-rendered so the nav, footer and copy are in the markup for a reader with no
 * script. What that reader does not get is the live view, which is correct — driving a local
 * process needs `fetch`, and a page that pretended otherwise would be worse than one that says so.
 */
export const metadata: Metadata = {
  title: `Session — ${SITE.name}`,
  description: SITE.session.lede,
};

export default function SessionPage() {
  return (
    <>
      <Nav current="session" />

      <main className="page">
        <header className="doc-head">
          <h1>Your session</h1>
          <p className="tagline">{SITE.session.lede}</p>
        </header>

        <Section n="01" id="connect" title="ON YOUR MACHINE">
          <p className="statement-lead col-7">{SITE.session.body[0]}</p>

          <div className="grid-12 step">
            <span className="col-note prose-label">SCOPE</span>
            <p className="col-9 prose-body">{SITE.session.body[1]}</p>
          </div>

          <Session />
        </Section>

        {/* The key to the marks, in the markup on every load — see `AttributionLegend`. It is
            here rather than beside the message list because a legend that arrives with the data
            is absent exactly when a reader most needs it. */}
        <Section n="02" id="marks" title="WHAT THE MARKS MEAN">
          <AttributionLegend />
        </Section>
      </main>

      <Close
        line="Everything this page shows comes from the client on your own machine."
        primary={{ href: "/install/", label: "Run it" }}
        secondary={{ href: "/demo/", label: "See it run" }}
      />

      <Footer />
    </>
  );
}
