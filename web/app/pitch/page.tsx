import type { Metadata } from "next";

import { SITE } from "../../content.ts";
import { Nav } from "../../components/Nav.tsx";
import { Deck, Slide } from "../../components/Deck.tsx";
import { Button } from "../../components/Section.tsx";
import { Reveal } from "../../components/Reveal.tsx";
import { Verbs } from "../../components/viz/Verbs.tsx";
import { Halves } from "../../components/viz/Halves.tsx";
import { DisclosureMap } from "../../components/viz/DisclosureMap.tsx";
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
  "THE PITCH",
  "THE PROBLEM",
  "WHAT IT IS",
  "IN PRACTICE",
  "THE DEFENCE",
  "THE METHOD",
  "WHAT NEXT",
] as const;

export default function Pitch() {
  const p = SITE.pitch;
  return (
    <>
      <Nav current="pitch" />

      <Deck labels={LABELS}>
        {/*
          ⛔ A TITLE SLIDE, and a corporate deck opens on one.

          The reference's first slide is an eyebrow and a single sentence, centred, with nothing
          else on it — no figure, no section number, no argument. It is the line a presenter says
          while the room settles. Ours used to open on section 01 with a diagram beside it, which
          is a document's first page rather than a deck's.
        */}
        <Slide label={LABELS[0]} centre>
          <span className="label">The pitch</span>
          <h2 className="slide-title">{p.whatItIs.title}</h2>
        </Slide>

        <Slide n="01" label={LABELS[1]} aside={<Reveal><Halves /></Reveal>}>
          <h2>{p.problem.title}</h2>
          <p>{p.problem.body[0]}</p>
        </Slide>

        <Slide n="02" label={LABELS[2]} aside={<Reveal><MessagePath /></Reveal>}>
          <h2>What it actually is</h2>
          <p>{p.whatItIs.body[0]}</p>
        </Slide>

        {/* The verb table, and the only place on the site it is explained. See `content.ts`. */}
        <Slide n="03" label={LABELS[3]} aside={<Reveal><Verbs /></Reveal>}>
          <h2>{p.whatYouDo.title}</h2>
          <p>{p.whatYouDo.body[0]}</p>
          <p>{p.whatYouDo.body[1]}</p>
        </Slide>

        <Slide n="04" label={LABELS[4]} aside={<Reveal><AnonymitySet /></Reveal>}>
          <h2>What the system does about it</h2>
          <p>{p.mechanism.body[0]}</p>
        </Slide>

        <Slide n="05" label={LABELS[5]} aside={<Reveal><DisclosureMap /></Reveal>}>
          <h2>Every line of it is generated</h2>
          <p>{SITE.why[1].body}</p>
        </Slide>

        {/*
          ⛔ THE DECK CLOSES ON AN ASK, NOT ON AN ARGUMENT.

          It used to end on `pitch.lede` — a sentence about epistemology — which is a thesis and
          leaves a room with nothing to do. The reference closes on one line and two buttons, and
          both buttons go to the product. That is the shape of a pitch: the argument is slides 01
          to 05, and the last screen is what happens next.
        */}
        <Slide label={LABELS[6]} centre>
          <h2 className="slide-title">{p.close}</h2>
          <div className="close-actions">
            <Button href="/install/">Run it</Button>
            <Button href="/demo/">See it run</Button>
          </div>
        </Slide>
      </Deck>
    </>
  );
}
