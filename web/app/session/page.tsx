import type { Metadata } from "next";

import "./dashboard.css";

import { SITE } from "../../content.ts";
import { Session, AttributionLegend } from "../../components/Session.tsx";

/**
 * The session page: the client on the reader's own machine, as an instrument rather than a page.
 *
 * ⛔ **THIS IS NOT A SECTION STACK AND IT DELIBERATELY STOPPED BEING ONE.** It used to open with a
 * full-width heading, a lede, a numbered `ON YOUR MACHINE` section and a `SCOPE` paragraph, and
 * the thing the page is for — the connection box — sat below all of it. A reader who came here to
 * drive their client scrolled past an argument to reach the tool. **One screen, no page scroll:**
 * every pane is given its height by the grid and scrolls inside itself, so a number stays where
 * the reader last found it instead of moving as content arrives.
 *
 * ⛔ **IT IS A STATIC EXPORT LIKE EVERY OTHER PAGE, AND THERE IS NO SERVER BEHIND IT.** A page
 * that talked to an origin would be a hosted service, which `SITE.doesNotClaim` says this is not,
 * and that sentence stays true because of what this file does not do. Everything the instrument
 * shows comes from `127.0.0.1`.
 *
 * **The two sentences that survived the prose are not decoration.**
 *
 * `SITE.session.body[1]` describes what the page DOES, and it was false until today: it said
 * *"It reads. It does not send messages, it does not fetch new ones"* after send, read and flush
 * had shipped. A page that quietly gains a write surface while its own description still says it
 * only reads is worse than one that never described itself — the reader who checked once has been
 * given a reason not to check again. It was corrected rather than dropped.
 *
 * `SITE.session.lede` carries *"nothing here is fetched from this site"*, and
 * `test/site.test.ts` enforces the property it claims: no external URL on any page except the
 * links the footer declares. The claim stays on the page next to the thing it is about.
 */
export const metadata: Metadata = {
  title: `Session — ${SITE.name}`,
  description: SITE.session.lede,
};

export default function SessionPage() {
  return (
    <div className="dash">
      {/*
        ⛔ **THE DISCLOSURE MOVED BEHIND AN AFFORDANCE AND DID NOT LEAVE THE DOCUMENT.**

        It was a block at the foot of the page taking roughly a tenth of the viewport on every
        screen. It is now folded into the `?` in the header — a `<details>`, so every word is in
        the shipped HTML and merely closed. `test/site.test.ts:854` reads the built page and
        matches the legend's text; markup that appears only after a click would fail that build,
        and it should, because a disclosure nobody can find in the source is not shipped.
      */}
      <Session
        disclosure={
          <>
            <section>
              <h3>WHAT THIS PAGE IS</h3>
              {/*
                This sentence said "It reads. It does not send messages, it does not fetch new
                ones" after send, read and flush had shipped. A page that quietly gains a write
                surface while its own description still says it only reads is worse than one that
                never described itself.
              */}
              <p className="prose-body">{SITE.session.body[1]}</p>
              <p className="prose-body">{SITE.session.lede}</p>
            </section>
            <section>
              <h3>WHAT THE MARKS MEAN</h3>
              <AttributionLegend />
            </section>
          </>
        }
      />
    </div>
  );
}
