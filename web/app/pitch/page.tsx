import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { PageFrame } from "../../components/PageFrame.tsx";
import { Nav } from "../../components/Nav.tsx";
import { Deck, Slide } from "../../components/Deck.tsx";
import { Auditor } from "../../components/Auditor.tsx";
import { MessagePath } from "../../components/viz/MessagePath.tsx";
import { AnonymitySet } from "../../components/viz/AnonymitySet.tsx";

/**
 * The pitch: six slides, and the highest-risk page on this site.
 *
 * Most of it is hand-written persuasive copy about a privacy product, which is the exact shape
 * the forbidden-word check exists to police. That guard is load-bearing here in a way it is
 * nowhere else: `content.ts` holds the rule these slides are written to — say what the project
 * DOES, never what the reader GETS.
 *
 * **Slides, because of who reads this.** A judge, watching a presenter, once. They cannot scroll
 * back and they will not read a paragraph. One screen, one claim, and every slide has to survive
 * being read out loud.
 *
 * **Slide 04 is generated, and that is the point of the page.** The auditor can see the
 * communication graph. That is a fact about Hydra rather than a comparison, so hand-writing it
 * would be an asserted privacy claim and the check would refuse it — correctly. It is therefore
 * generated-on-the-slide or absent-from-the-page, and absent is not an option: burying it while
 * the deck sells around it is precisely the move the whole mechanism exists to prevent. It
 * renders the same `Auditor` component as `/about/disclosure`, so the two cannot drift.
 *
 * ## ⛔ The order is the argument, and it was wrong
 *
 * The deck used to open on `pitch.lede` — *"this one publishes the measurements"* — and then
 * spend two slides on mechanism before ever saying what the product was. **That sells a method to
 * somebody who came for a messenger.** Slides 01 and 03 are new and they are the fix: what it is,
 * then what you do with it, before any argument about why the claims are believable.
 *
 * `pitch.lede` now closes. 04 is the worst fact, 05 is the honest comparison immediately after
 * it, and 06 makes the case only once both have been read. A deck that put 06 first would be
 * selling around the other two.
 */
export const metadata: Metadata = {
  title: `Pitch — ${SITE.name}`,
  description: SITE.pitch.lede,
};


/** One per slide, in order. The rail reads these, and so does each slide's accessible name. */
const LABELS = [
  "WHAT IT IS",
  "THE PROBLEM",
  "IN PRACTICE",
  "WHO CAN SEE YOU",
  "THE COMPARISON",
  "THE ARGUMENT",
] as const;

export default function Pitch() {
  const p = SITE.pitch;
  return (
    <>
      <PageFrame word={SITE.name.toUpperCase()} />
      <Nav current="pitch" />

      <Deck labels={LABELS}>
        <Slide n="01" label={LABELS[0]} aside={<MessagePath />}>
          <h2>{p.whatItIs.title}</h2>
          <p>{p.whatItIs.body[0]}</p>
        </Slide>

        <Slide n="02" label={LABELS[1]}>
          <h2>{p.problem.title}</h2>
          <p>{p.problem.body[0]}</p>
          <p>{p.problem.body[1]}</p>
        </Slide>

        {/* The verb table, and the only place on the site it is explained. See `content.ts`. */}
        <Slide n="03" label={LABELS[2]}>
          <h2>{p.whatYouDo.title}</h2>
          <p>{p.whatYouDo.body[0]}</p>
          <p>{p.whatYouDo.body[1]}</p>
        </Slide>

        {/*
          Generated. The mechanism paragraph is folded in as the setup rather than getting a slide
          of its own before anyone knows what the product is.
        */}
        <Slide n="04" label={LABELS[3]} aside={<Auditor />}>
          <h2>Who can see you talking</h2>
          <p>{p.mechanism.body[0]}</p>
        </Slide>

        {/*
          The measured identification rates sit beside the concession, not beside the close.

          They were on slide 06 and made it five blocks deep — the only slide with more than
          four — which is what pushed `pitch.lede` and the link out below the fold. They belong
          here on their own merits: this is the slide that concedes, and a drawing of how often a
          message IS identified is the same argument the paragraph is making.
        */}
        <Slide n="05" label={LABELS[4]} aside={<AnonymitySet />}>
          <h2>{p.worseAt.title}</h2>
          <p>{p.worseAt.body[0]}</p>
          <p>{p.worseAt.body[1]}</p>
        </Slide>

        {/* The close, and deliberately the thinnest slide in the deck: the argument, the line
            that ends it, and the way out. Nothing competes with the last thing a judge reads. */}
        <Slide n="06" label={LABELS[5]}>
          <h2>{p.why.title}</h2>
          <p>{p.why.body[0]}</p>
          {/* The closing line, and the link out. Both were below the fold at 1440x800 before the
              figure moved beside the copy — see `Slide`. They are the last thing a judge reads
              and they were the two things the layout was eating. */}
          <p className="accent">{p.lede}</p>
          <p className="cta">
            <a href="/about/disclosure/">Read what every party can see &rarr;</a>
          </p>
        </Slide>
      </Deck>
    </>
  );
}
