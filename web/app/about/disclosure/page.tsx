import type { Metadata } from "next";

import { statement } from "../../../../hydra-dapp/packages/claims/src/statement.ts";
import { SITE } from "../../../content.ts";
import { PageFrame } from "../../../components/PageFrame.tsx";
import { Nav } from "../../../components/Nav.tsx";
import { Section } from "../../../components/Section.tsx";
import { ClaimList } from "../../../components/ClaimList.tsx";
import { Auditor } from "../../../components/Auditor.tsx";
import { Footer } from "../../../components/Footer.tsx";

/**
 * Everything the landing page does not say.
 *
 * **The order is a claim in itself.** The auditor first, then the two hand-written warnings,
 * then what every party CAN see, then the partial guarantees with their measurements, and only
 * then the eleven things they cannot. A page that opened with what nobody can see and buried the
 * forty things they can would be accurate line by line and dishonest as a document — which is
 * the specific failure this whole mechanism exists to prevent.
 *
 * Sections 01, 04, 05 and 06 come from `statement()`, the same function the client renders on
 * its own Disclosure screen, so this page and the product cannot disagree.
 *
 * No animated background here. The tentacles belong to the landing page; a document you are
 * asked to check should not have something moving behind it.
 */
export const metadata: Metadata = {
  title: `Disclosures — ${SITE.name}`,
  description:
    "What each party involved can see, generated from the code that makes it true, with the "
    + "file that makes each line checkable.",
};

export default function Disclosures() {
  const s = statement();

  return (
    <>
      <PageFrame word={SITE.name.toUpperCase()} />
      <Nav current="about" />

      <main className="page">
        <header className="doc-head">
          <h1>Disclosures</h1>
          <p className="tagline">
            Generated from the disclosure tables and the measured schedules. Every line cites the
            file that makes it true.
          </p>
        </header>

        <Section n="01" id="auditor" title="THE AUDITOR">
          <Auditor />
        </Section>

        {/*
          The warnings sit ABOVE the tables, and above the eleven things nobody can see in
          particular. Ordering is a claim: a "not ready" section below three screens of measured
          protections is a disclaimer, and above them it is a description. `test/site.test.ts`
          pins this, because it is the first thing a redesign moves.
        */}
        <Section n="02" id="not-ready" title="WHAT IT IS NOT READY FOR">
          <ul className="warnings">
            {SITE.notYet.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Section>

        <Section n="03" id="not-claimed" title="WHAT THIS DOES NOT CLAIM">
          <ul className="warnings">
            {SITE.doesNotClaim.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Section>

        <Section n="04" id="can-see" title="WHAT THEY CAN SEE">
          <ClaimList claims={s.whoCanSeeWhat} />
        </Section>

        <Section n="05" id="partial" title="PROTECTED, AND HOW WELL">
          <ClaimList claims={s.whatIsPartial} />
        </Section>

        <Section n="06" id="cannot-see" title="WHAT THEY CANNOT SEE">
          <ClaimList claims={s.whatWeCannotSee} />
        </Section>

      </main>

      <Footer />
    </>
  );
}
