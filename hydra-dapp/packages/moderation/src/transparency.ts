/**
 * The transparency report — `decisions/0035` §6.
 *
 * GENERATED FROM THE DECISION RECORD, never written by hand, which is the rule the disclosure
 * statement is already held to and for the same reason: a number somebody typed is a number
 * somebody chose.
 *
 * AT LAUNCH VOLUMES A TRANSPARENCY REPORT IS A DISCLOSURE MECHANISM, NOT A TRANSPARENCY ONE, and
 * that is the problem this file exists to solve rather than a caveat on it.
 *
 * "This quarter: 3 reports, 1 removal, category X" against a public timeline anybody can read lets
 * a reader work out WHICH post — and on the submission surface, plausibly who was behind it. That
 * is not a tail risk, it is the launch condition: a new service with a small corpus publishes cells
 * of size one and two by default. **The report is at its most dangerous exactly when it is least
 * informative.**
 *
 * So every cell below {@link FLOOR} is banded, the floor itself is published, and a banded cell
 * says what it means.
 */

import type { Decision } from "./reports.ts";
import type { Appeal } from "./appeals.ts";

/**
 * Cells below this are banded rather than counted.
 *
 * Five, and published rather than hidden: a suppression threshold nobody can see is a number the
 * reader has to trust rather than check.
 */
export const FLOOR = 5;

/**
 * ZERO IS BANDED TOO, AND THAT IS THE WHOLE SUBTLETY.
 *
 * The obvious version reports true zeros as "0" and small counts as "fewer than 5" — and then
 * "fewer than 5" means *at least one*, so banding a cell announces that the cell is non-empty.
 * The suppression leaks precisely what it was meant to hide.
 *
 * So the band is `0..FLOOR-1` inclusive and a reader cannot tell an empty category from a rare
 * one. It also means a banded cell must never be read as "none" — that is `decisions/0029`'s
 * unknown-is-not-zero in its third costume, and like the others the fix is that the number and its
 * limit arrive together.
 */
export const band = (n: number): string => (n < FLOOR ? `fewer than ${FLOOR}` : String(n));

export type Period = { readonly from: number; readonly to: number };

/**
 * A report for one period.
 *
 * `removedIds` is public-class only, and deliberately.
 *
 * For a public post, naming the removed id is defensible: the object was public, the on-chain
 * commitment still stands, and a removal that anyone can verify against it is the mechanism this
 * design chose. The cost is real — it builds a permanent index of removed content, which is a
 * roadmap for anyone collecting it — so it is a choice made once, here, rather than a side effect.
 *
 * **Encrypted deletions do not appear at all.** A capability deletion is not a moderation decision;
 * it is somebody deleting their own object, and reporting it would turn a transparency mechanism
 * into a log of private deletions. Compelled removals of encrypted blobs are a different question
 * and ride with D6.
 */
/**
 * A report for one period.
 *
 * **ONLY THE FINEST PARTITION IS PUBLISHED — no totals, no marginals, no "of which".** A floor
 * protects a cell in isolation and does nothing against arithmetic between published figures: this
 * function's first version printed `Decisions: 9 — removed 7, kept fewer than 5`, and 9 − 7 = 2
 * pins the banded cell exactly. A parent alongside its children is a subtraction waiting to happen,
 * and two partitions of the same events (by outcome AND by category) give a derivable total either
 * way.
 *
 * So each cell is one `(category, outcome)` pair, banded, and nothing published sums to anything
 * else published. A reader who adds the cells gets a total made of bands, which is the correct
 * amount of precision rather than a shortfall.
 *
 * If a total is ever wanted it must be banded too, and it will then be arithmetically inconsistent
 * with the sum of the bands. **That inconsistency is the correct appearance, not a bug to fix.**
 *
 * `removedIds` is public-class only, and deliberately.
 *
 * For a public post, naming the removed id is defensible: the object was public, the on-chain
 * commitment still stands, and a removal that anyone can verify against it is the mechanism this
 * design chose. The cost is real — it builds a permanent index of removed content, which is a
 * roadmap for anyone collecting it — so it is a choice made once, here, rather than a side effect.
 *
 * **Encrypted deletions do not appear at all.** A capability deletion is not a moderation decision;
 * it is somebody deleting their own object, and reporting it would turn a transparency mechanism
 * into a log of private deletions. Compelled removals of encrypted blobs are a different question
 * and ride with D6.
 */
export function report(
  decisions: readonly Decision[],
  reportsReceivedThisPeriod: number,
  period: Period,
  appeals: readonly Appeal[] = [],
  compelled: readonly { readonly at: number }[] = [],
): {
  readonly floor: number;
  readonly period: Period;
  readonly figures: readonly { readonly label: string; readonly shown: string }[];
  readonly lines: readonly string[];
  readonly removedIds: readonly string[];
} {
  const inPeriod = decisions.filter((d) => d.at >= period.from && d.at < period.to);
  // **ONE CELL PER OBJECT, NOT ONE PER DECISION — the effective decision is the latest one.**
  // Two decisions about `pub:one` published `csam / removed` AND `other / kept`, and named the
  // object in the permanent removals index although the final decision was to keep it. `decide`
  // refuses a second one now, so this cannot arise going forward; it is here because a queue
  // written before that fix can hold the pair, and a report that publishes both is a report
  // contradicting itself about an object it names.
  //
  // Appeals are unaffected: a reversal is recorded on the appeal, not as a second decision, and
  // `appeals / decision reversed` counts those separately. Checked rather than assumed.
  const latest = new Map<string, Decision>();
  for (const d of inPeriod.filter((x) => x.blobId.startsWith("pub:"))) {
    const seen = latest.get(d.blobId);
    if (!seen || d.at >= seen.at) latest.set(d.blobId, d);
  }
  const publicOnly = [...latest.values()];
  const removed = publicOnly.filter((d) => d.outcome === "removed");
  // **EVERY DECIDED ENTRY IS ACCOUNTED FOR OR THE REPORT SAYS IT CANNOT BE.** Anything that is not
  // `pub:` used to fall out of the counts, the named list and the text alike — no cell, no
  // counter, no acknowledgement — so two recorded removals produced "No decisions were made in
  // this period." `decide` refuses these at the door now, but a queue written before that fix can
  // still hold them, and a report that silently drops them is the same lie with a smaller cause.
  const unaccounted = inPeriod.filter((d) => !d.blobId.startsWith("pub:"));

  // One cell per (category, outcome). The finest partition, and the only one published.
  const cells = new Map<string, number>();
  for (const d of publicOnly) {
    const key = `${d.category} / ${d.outcome}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }

  // REPORT VOLUME IS NOT PUBLISHED, and dropping it was the differencing test's doing.
  //
  // Reports and decisions are different event sets — a report may lead to no decision, and a
  // decision may follow many reports — so publishing both looks safe. It is not: with the cells
  // summing to 13 and volume at 15, the residual is 2, which is exactly the value of the one
  // banded cell. An attacker cannot be sure whether they are reading the residual or the cell,
  // and a defence that rests on the attacker's uncertainty is not a defence.
  //
  // BANDING VOLUME DOES NOT RESCUE IT, which is the part worth writing down because the proposal
  // is a reasonable one and it was made. `band` only suppresses values BELOW the floor; a volume
  // large enough to be worth publishing is published EXACTLY, so banding it is the identity
  // function and the residual stays a value rather than becoming a range. Measured, not reasoned:
  // 15 reports against cells of 7, 2 and 6 still hands over the 2. See the guard in
  // `transparency.test.ts`.
  //
  // NOR DOES ROUNDING, which is the obvious next proposal and is also wrong. A residual interval
  // does not protect a cell whose own range is already bounded: suppression itself says the cell
  // is below the floor, so the attacker intersects the two. At FLOOR 5 and a width of 5, cells of
  // 7 and 9 with a true suppressed cell of 4 give a bucket of [20,25), a residual of [4,9), and
  // [4,9) n [0,5) = {4} — pinned exactly. It happens whenever the bucket floor sits FLOOR-1 above
  // the published sum, and a wider bucket NARROWS the intersection rather than removing it.
  //
  // So the general statement, which is what survives the next proposal: ANY figure published over
  // the same events, at ANY granularity, can intersect a suppressed cell's range down to a point.
  // The report publishes one event set. Volume is not published in any form.
  void reportsReceivedThisPeriod;
  // APPEAL OUTCOMES, ON THE SAME FLOOR AND IN THE SAME PARTITION STYLE.
  //
  // They belong here because an appeal is a decision about a decision, and a service that publishes
  // what it removed while staying silent on how often it was told it got it wrong is publishing the
  // flattering half. The floor applies identically: a single upheld appeal against a public
  // timeline names the object and plausibly the person.
  //
  // ONLY RESOLVED ONES ARE COUNTED, and the reason is a differencing shape this report had not
  // met before: it works ACROSS PERIODS rather than within one.
  //
  // A pending appeal is not an outcome, so publishing it as a third value would be inaccurate
  // anyway. What makes it unsafe is that **a pending appeal must eventually resolve**, which ties
  // one period's figure to the next one's by construction. Publish `pending: 12` in September and
  // `reversed: 8` in October with `stood` banded, and 12 − 8 = 4 pins the banded cell — across two
  // reports, neither of which is unsafe on its own.
  //
  // Measured, not assumed: within a SINGLE period publishing pending does not bridge, which is why
  // the first version of this comment claimed the wrong reason and the exhaustive test did not
  // agree with it. The guard for the real shape is in `transparency.test.ts`.
  //
  // An unresolved appeal therefore appears in a later period, when it is an outcome.
  //
  // "upheld" means THE APPELLANT WON. Written out in the label because "upheld" alone is read both
  // ways, and a transparency report whose central word is ambiguous discloses nothing reliably.
  const appealsInPeriod = appeals.filter((a) =>
    a.outcome !== undefined && a.at >= period.from && a.at < period.to);
  for (const a of appealsInPeriod) {
    const key = a.outcome === "upheld"
      ? "appeals / decision reversed" : "appeals / decision stood";
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }

  // COMPELLED REMOVALS OF ENCRYPTED OBJECTS — `D6`. One cell, banded like everything else.
  //
  // It belongs here because the whole point of building this path in the open is that its use is
  // COUNTABLE: an operator who complies off the record is the failure mode, and a number nobody
  // publishes is a number nobody can hold them to. A period in which none happened publishes
  // "fewer than 5", which includes zero — the band cannot be read as an admission.
  //
  // ONE FIGURE, NO PARTITION. There is no category and no outcome to break it down by, because
  // there is nothing the operator knows about these objects to break it down WITH — they cannot
  // read them. A partition would be an invitation to record a guess.
  const compelledInPeriod =
    compelled.filter((c) => c.at >= period.from && c.at < period.to).length;
  if (compelledInPeriod > 0) cells.set("encrypted objects removed under legal process", compelledInPeriod);
  // Banded like every other figure, and it is a defect indicator rather than a category: these
  // are decisions on record that name no object class this report knows how to account for.
  if (unaccounted.length > 0) cells.set("decisions this report cannot account for", unaccounted.length);

  const figures = [...cells].sort(([a], [b]) => a.localeCompare(b))
    .map(([label, n]) => ({ label, shown: band(n) }));

  const stamp = (t: number) => new Date(t).toISOString().slice(0, 10);
  return {
    floor: FLOOR,
    period,
    figures,
    removedIds: removed.map((d) => d.blobId).sort(),
    lines: [
      `Period ${stamp(period.from)} to ${stamp(period.to)}.`,
      ...figures.map((f) => `${f.label}: ${f.shown}.`),
      // **THE ONE SENTENCE HERE THAT MEANS "NONE", AND IT USED TO BE ABLE TO BE FALSE.** It was
      // conditioned on `cells.size === 0` — no itemised cells — rather than on there being no
      // decisions, so a period with decisions that no cell counted printed a flat denial. Every
      // other cell in this document degrades to "we are not telling you"; the preamble below is
      // scrupulous that a band "INCLUDES ZERO. It does not mean none." This one degraded to a lie,
      // and it is the sentence an operator publishes in a month they believe was quiet.
      //
      // **THE ROW ABOVE IS WHAT ACTUALLY FIXES IT; THIS CONDITION IS DEFENCE IN DEPTH, and that is
      // worth saying rather than implying both are load-bearing.** Mutating this back to
      // `cells.size === 0` changes nothing today, because an unaccounted decision now always
      // produces a cell — the two conditions are equivalent in every reachable state, which is why
      // no test distinguishes them. It is written this way so the sentence means what it says
      // independently of whether some future cell happens to exist.
      ...(inPeriod.length === 0 && compelledInPeriod === 0
        ? ["No decisions were made in this period."] : []),
      ...(unaccounted.length > 0
        ? ["", "Some decisions on record name no object class this report can account for. They",
           "are counted above and are itemised nowhere, because there is no category to put them",
           "in. That is a fault in the record rather than a kind of decision."]
        : []),
      "",
      `Any figure shown as "fewer than ${FLOOR}" is banded, and the band INCLUDES ZERO. It does`,
      "not mean none. Small numbers would identify the item they refer to — this service has a",
      "public timeline, so a count of one against it names a post and, on the submission surface,",
      "plausibly the person behind it. The report says less when there is less to say.",
      "",
      "No totals are published, and no figure here is the sum of any others. A floor protects a",
      "cell on its own; it does not survive subtraction, and a parent printed beside its children",
      "is a subtraction waiting to happen. For the same reason the number of reports received is",
      "not published here: reports and decisions are different sets of events, and printing both",
      "lets the difference between them stand in for a suppressed cell. Neither banding nor",
      "rounding that number helps. Suppressing a cell already tells you it is below the floor, so",
      "any other figure over the same events — however coarse — can be intersected with that",
      "range, and the intersection is sometimes a single value.",
      "",
      // NAMED IN THE REPORT ITSELF, not merely returned beside it. `report.published` says this
      // report discloses "the ids of removed public objects", and `removedIds` was computed and
      // handed back while nothing printed it — so the disclosure table described a report nobody
      // generated. Produced and not consumed, inside the surface built last.
      ...(removed.length
        ? ["", "Public objects removed in this period, by id:",
          ...removed.map((d) => `  ${d.blobId}`),
          "",
          "These are named rather than counted. The object was public, so its id was already",
          "public — it is how anyone fetched it — and naming it costs a permanent index of",
          "removed content.",
          "",
          "WHETHER THIS LIST CAN BE CHECKED DEPENDS ON THE CORPUS COMMITMENT BELOW, and that",
          "paragraph is the one that knows. With a commitment, an id in the previous period's",
          "root and absent from this one was removed, and you can establish that without our",
          "cooperation. Without one, this list is SELF-REPORTED: you can ask for an id and find",
          "it absent, but nothing attests the object was ever here, so an operator who quietly",
          "dropped a post and never listed it would look exactly like one who never received",
          "it. A public post makes no on-chain commitment of its own — the commitment is over",
          "this vault's corpus, and it is published by us."]
        : []),
      "",
      "Encrypted objects removed UNDER LEGAL PROCESS are counted above when there were any, and",
      "the count is banded like every other figure, so a band there includes zero. This service",
      "cannot read those objects and records no claim about what they were — only the id, the",
      "date, and its own reference for the process served. The people in the affected",
      "conversation are told by their own client, because a removal that looks like expiry is",
      "invisible to them. See DECISIONS-NEEDED.md D6.",
      "",
      "Deletions of encrypted objects are not listed. Those are people deleting their own",
      "messages with a capability they hold, not decisions anyone made about them, and logging",
      "them here would make a transparency report into a record of private deletions.",
    ],
  };
}

/**
 * The paragraph about the corpus commitment, and the three states it can be in.
 *
 * **THERE WERE TWO STATES AND THREE CASES.** The report printed either the root, or *"NO CORPUS
 * COMMITMENT WAS PUBLISHED with this report — run with `--vault URL`"*. That second sentence is
 * right for an operator who did not ask and wrong for one who did: the flag was given, the vault
 * did not answer, and the report told them to do the thing they had just done. An operator reading
 * it goes and checks their command line rather than their vault.
 *
 * **THE DISTINCTION IS NOT COSMETIC.** *"I did not ask for a commitment"* and *"I asked and could
 * not get one"* are different facts about the same report, and only the second is a reason to
 * stop and republish. Collapsing them means a vault that was down during the monthly report
 * produces a self-reported list that looks exactly like a deliberate choice not to commit — which
 * is the shape `decisions/0039` exists to prevent, one level up.
 *
 * **AND THE LIST ABOVE MUST NOT DECIDE THIS QUESTION FOR ITSELF.** The removed-ids block used to
 * assert flatly that it *"DOES NOT PROVE ANYTHING"* and was *"SELF-REPORTED"*, unconditionally,
 * while this function — printed a few lines later in the same report — said a published root is
 * *"what makes the list above auditable rather than self-reported."* **One document, two answers,
 * and a reader believed whichever they reached.** The block defers to this paragraph now, because
 * this is the only part of the report that knows which of the three states it is in.
 *
 * A FUNCTION HERE RATHER THAN A BRANCH IN `main.ts`, because `main.ts` runs on import and cannot
 * be driven from a test. The wording of the thing that says a report is unverifiable should not be
 * the part of this pipeline with no coverage.
 */
export function commitmentNote(root: string, asked: boolean, failure = ""): string {
  if (root) {
    return `Public corpus commitment for this period:\n  ${root}\n\n`
      + "Every public object this vault held is in the tree behind that root, padded to a fixed\n"
      + "size so it discloses no count. Ask the vault for a proof of any id you hold: an id in\n"
      + "last period's root and absent from this one was removed, and you can check that without\n"
      + "our cooperation. That is what makes the list above auditable rather than self-reported.";
  }
  if (asked) {
    return "A CORPUS COMMITMENT WAS REQUESTED AND NOT OBTAINED — the vault did not answer"
      + (failure ? ` (${failure})` : "") + ".\n"
      + "This is NOT the same as publishing without one on purpose. The removals listed above are\n"
      + "self-reported for this period: you can check that an id is absent, not that it was ever\n"
      + "here. Fix the vault and generate this report again before publishing it — the period is\n"
      + "already recorded as published, so regenerating is the remedy and re-deciding is not.";
  }
  return "NO CORPUS COMMITMENT WAS PUBLISHED with this report — run with `--vault URL`. Without it\n"
    + "the removals listed above are self-reported: you can check that an id is absent, not\n"
    + "that it was ever here, and a silent drop looks like nothing at all.";
}
