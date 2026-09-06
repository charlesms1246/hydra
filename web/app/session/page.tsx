import type { Metadata } from "next";
import Link from "next/link";

import "./dashboard.css";

import { SITE } from "../../content.ts";
import { Session } from "../../components/Session.tsx";

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
      {/* Chrome, not navigation: one way back and nothing else competing with the instrument. */}
      <header className="dash-chrome">
        <Link href="/" className="dash-home">{SITE.name}</Link>
        <span className="dash-chrome-title">SESSION</span>
        <Link href="/install/" className="dash-chrome-link">Run the client</Link>
      </header>

      <Session />

      {/*
        The two claims, at the foot of the instrument rather than above it. A reader meets them
        without having to scroll past them to reach the tool, and they describe what is on the
        screen instead of introducing it.
      */}
      <footer className="dash-foot">
        <p>{SITE.session.body[1]}</p>
        <p>{SITE.session.lede}</p>
      </footer>
    </div>
  );
}
