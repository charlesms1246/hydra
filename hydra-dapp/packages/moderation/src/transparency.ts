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
): {
  readonly floor: number;
  readonly period: Period;
  readonly figures: readonly { readonly label: string; readonly shown: string }[];
  readonly lines: readonly string[];
  readonly removedIds: readonly string[];
} {
  const inPeriod = decisions.filter((d) => d.at >= period.from && d.at < period.to);
  const publicOnly = inPeriod.filter((d) => d.blobId.startsWith("pub:"));
  const removed = publicOnly.filter((d) => d.outcome === "removed");

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
  // So the report publishes ONE event set. Volume could be published on its own, at its own
  // granularity, where nothing partitions alongside it — that is a decision with a stated cost
  // rather than something to slip back in beside the cells.
  void reportsReceivedThisPeriod;
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
      ...(cells.size === 0 ? ["No decisions were made in this period."] : []),
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
      "lets the difference between them stand in for a suppressed cell.",
      "",
      "Deletions of encrypted objects are not listed. Those are people deleting their own",
      "messages with a capability they hold, not decisions anyone made about them, and logging",
      "them here would make a transparency report into a record of private deletions.",
    ],
  };
}
