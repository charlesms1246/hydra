import { SITE } from "../content.ts";
import { Nav } from "../components/Nav.tsx";
import { Code } from "../components/Code.tsx";
import { Section } from "../components/Section.tsx";
import { Footer } from "../components/Footer.tsx";
import { WriteOn } from "../components/WriteOn.tsx";
import { DisclosureMap } from "../components/viz/DisclosureMap.tsx";
import { AsciiPanel } from "../components/viz/AsciiPanel.tsx";

/**
 * The landing page. Marketing, and only marketing.
 *
 * **The disclosure tables are not here — they are at `/disclosures`.** That is a deliberate
 * split and not a demotion: the tables are 58 generated claims with a file path hanging off each
 * one, which is a document rather than a pitch, and a visitor deciding whether this is for them
 * should not have to read forty things a storage operator can see in order to find out what the
 * thing is. The reference design does the same, and its disclosure link is a legal footnote in
 * the footer; here it is in the nav bar, because it is the product.
 *
 * What this page may not do is *soften* on the way. Every sentence here still passes the
 * forbidden-word check, so nothing on the landing page can claim a privacy property that the
 * generated statement does not — which is the whole risk of having a marketing page at all.
 */

export default function Home() {
  return (
    <>
      <Nav current="home" />

      <main className="page">
        {/*
          ⛔ The wordmark, and nothing else. Do not add a sentence, a button or an eyebrow.

          `SITE.tagline` used to sit under it. The reference's hero is one word over the field,
          and its own note says why: a value proposition and two calls to action underneath make
          this an ordinary SaaS landing page and throw away the thing worth copying. The page
          opens on a held breath; the first content arrives when you scroll.

          The tagline is not deleted — it still serves `<title>` and the meta description in
          `layout.tsx`, which is where a one-sentence summary of a site actually does work. It is
          removed from the page, not from the site.
        */}
        <header className="hero">
          <h1 className="wordmark">{SITE.name.toUpperCase()}</h1>
        </header>

        {/*
          The staircase, which is the reference's content flow and not a two-column grid.

          The opening statement runs flush left at seven columns. The next block drops down AND
          inward: a right-aligned label in columns 1–3 sitting immediately off the paragraph's
          left edge, the paragraph itself running 4–12 out to the right margin. The two blocks
          overlap horizontally without sharing a column edge, so the eye steps diagonally down
          the page — the same movement the write-on performs.

          This used to be one 62rem column with both paragraphs stacked in it, which is a
          document's layout and is why the page read as developer docs.

          The write-on text crosses the server/client boundary as a STRING, not a module: this is
          a server component, so `content.ts` and `MEASURED` behind it stay on the build machine.
        */}
        <Section n="01" id="what" title="WHAT THIS IS">
          <WriteOn text={SITE.what[0]} className="statement-lead col-7" />

          <div className="grid-12 step">
            <span className="col-note prose-label">METHOD</span>
            <p className="col-9 prose-body">{SITE.what[1]}</p>
          </div>
        </Section>

        <Section n="02" id="why" title="WHY IT IS DIFFERENT">
          <div className="why">
            {SITE.why.map((w) => (
              <article key={w.label}>
                <span className="why-label">{w.label}</span>
                <h3>{w.title}</h3>
                <p>{w.body}</p>
              </article>
            ))}
          </div>
        </Section>

        {/*
          The page's hinge: one oversized line, alone on a screen, where the argument turns.

          The reference gives this a full viewport and nothing else, and it is what makes the
          sections either side read as separate movements rather than as continuous scroll. The
          line is `SITE.tagline` — which is exactly the sentence that did not belong under the
          wordmark. It is not a summary here; it is the turn, arriving after the reader knows
          what the product is and before they are told what to be careful about.
        */}
        <section className="statement" aria-hidden={false}>
          <p>{SITE.tagline}</p>
        </section>

        {/* One wide field, full-bleed, between the argument and the warning — the reference
            breaks its pages with an image at exactly this point, and a page of rules and prose
            needs the same beat. */}
        <div className="panels panels-wide">
          <AsciiPanel cols={190} rows={40} blur={1.7} gain={1.45} tag="HYDRA" />
        </div>

        <Section n="03" id="before" title="BEFORE YOU USE IT">
          <ul className="warnings">
            {SITE.beforeYouUse.map((line) => (
              <li key={line}><Code>{line}</Code></li>
            ))}
          </ul>
          {/*
            The shape of the disclosure, without any of its text.

            The landing page may not quote a generated claim — that is the rule that makes the
            split between this page and `/about/disclosure/` honest rather than a demotion. A count
            is not a claim, so this shows the *shape*: forty things a party can see against eleven
            they cannot. It is the strongest argument on the page and it makes none of the
            sentences the page is forbidden from making.
          */}
          <div className="fig-map">
            <DisclosureMap />
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
