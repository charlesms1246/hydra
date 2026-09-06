import { SITE } from "../content.ts";
import { Nav } from "../components/Nav.tsx";
import { Section } from "../components/Section.tsx";
import { Footer } from "../components/Footer.tsx";
import { Close } from "../components/Close.tsx";
import { WriteOn } from "../components/WriteOn.tsx";
import { Develop } from "../components/Develop.tsx";
import { Reveal } from "../components/Reveal.tsx";
import { AsciiImage } from "../components/viz/AsciiImage.tsx";
import { DisclosureMap } from "../components/viz/DisclosureMap.tsx";

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
          <Reveal>
            <h1 className="wordmark">{SITE.name.toUpperCase()}</h1>
          </Reveal>
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
            <Reveal className="col-9">
              <p className="prose-body">{SITE.what[1]}</p>
            </Reveal>
          </div>
        </Section>

        {/*
          The page's hinge: one statement, alone on a screen, between sections 01 and 02.

          ⛔ **The position is the device.** The reference puts this immediately after its first
          section and before its second — the turn happens once the reader knows what the thing is
          and before the argument for it begins. It was between 02 and 03 here, which is a beat
          too late: by then the reader has already been given the reasons, and a statement after
          the reasons is a summary rather than a turn.

          `WriteOn` drives it, and the line breaks are AUTHORED in the string rather than left to
          wrapping — a statement broken where the sense breaks reads as three lines; one broken by
          the viewport reads as a paragraph that happens to be big.
        */}
        <section className="statement">
          <WriteOn as="div" text={SITE.statement} />
        </section>

        <Section n="02" id="why" title="WHY IT IS DIFFERENT">
          <div className="why">
            {SITE.why.map((w) => (
              <article key={w.label}>
                {/* The render sits above the label so the eye meets the figure first, and it
                    resolves as the card rises — see `Develop`. `aspect-[5/4]` in the reference;
                    the panel's own grid gives us the same proportion. */}
                <Develop>
                  <AsciiImage file={w.art} alt={w.alt} cols={70} rows={34} gain={1.5} />
                </Develop>
                <span className="why-label">{w.label}</span>
                <h3>{w.title}</h3>
                <p>{w.body}</p>
              </article>
            ))}
          </div>
        </Section>


        {/*
          ⛔ The warnings that stood here are on `/about/disclosure/` and nowhere else.

          Every negative, caveat and disclosure is on one page now, by instruction. **This is a
          real trade and it is worth naming rather than quietly making**: the previous arrangement
          put two warnings in front of a reader before any link to a download, and its comment
          argued that a page which makes somebody find that out later is a page that misled them.
          What replaces it is a link that says plainly what is behind it and is the only call to
          action on this page — so the warning is one click away rather than absent, and the click
          is the loudest thing here.
        */}
        <Section n="03" id="before" title="WHAT EVERY PARTY CAN SEE">
          <Reveal>
            <p className="statement-lead">
              Forty things a party to this system can see, seven it protects with a measurement
              attached, and eleven it does not expose. All of it is generated from the code, and
              all of it is on one page.
            </p>
          </Reveal>

          <div className="fig-map fig-centre">
            <Reveal>
              <DisclosureMap />
            </Reveal>
          </div>

        </Section>
      </main>

      <Close
        line="It is a terminal client you run yourself, on your own machine."
        primary={{ href: "/install/", label: "Run it" }}
        secondary={{ href: "/demo/", label: "See it run" }}
      />

      <Footer />
    </>
  );
}
