import { SITE } from "../content.ts";
import { PageFrame } from "../components/PageFrame.tsx";
import { Nav } from "../components/Nav.tsx";
import { Section } from "../components/Section.tsx";
import { Footer } from "../components/Footer.tsx";

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
      <PageFrame word={SITE.name.toUpperCase()} />
      <Nav current="home" />

      <main className="page">
        <header className="hero">
          <h1 className="wordmark">{SITE.name.toUpperCase()}</h1>
          <p className="tagline">{SITE.tagline}</p>
        </header>

        <Section n="01" id="what" title="WHAT THIS IS">
          <div className="prose">
            <p>{SITE.what[0]}</p>
            <p className="labelled">
              <span className="prose-label">METHOD</span>
              {SITE.what[1]}
            </p>
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

        <Section n="03" id="before" title="BEFORE YOU USE IT">
          <ul className="warnings">
            {SITE.beforeYouUse.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="cta">
            <a href="/disclosures/">Read what every party can see &rarr;</a>
          </p>
        </Section>
      </main>

      <Footer />
    </>
  );
}
