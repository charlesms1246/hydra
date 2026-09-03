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
export function report(
  decisions: readonly Decision[],
  reportsReceived: number,
  period: Period,
): {
  readonly floor: number;
  readonly lines: readonly string[];
  readonly removedIds: readonly string[];
} {
  const inPeriod = decisions.filter((d) => d.at >= period.from && d.at < period.to);
  const publicOnly = inPeriod.filter((d) => d.blobId.startsWith("pub:"));
  const removed = publicOnly.filter((d) => d.outcome === "removed");
  const kept = publicOnly.filter((d) => d.outcome === "kept");

  const byCategory = new Map<string, number>();
  for (const d of publicOnly) byCategory.set(d.category, (byCategory.get(d.category) ?? 0) + 1);

  return {
    floor: FLOOR,
    removedIds: removed.map((d) => d.blobId).sort(),
    lines: [
      `Reports received: ${band(reportsReceived)}.`,
      `Decisions: ${band(publicOnly.length)} — removed ${band(removed.length)}, `
        + `kept ${band(kept.length)}.`,
      ...[...byCategory].sort(([a], [b]) => a.localeCompare(b))
        .map(([c, n]) => `Category ${c}: ${band(n)}.`),
      "",
      `Any figure shown as "fewer than ${FLOOR}" is banded, and the band INCLUDES ZERO. It does`,
      "not mean none. Small numbers would identify the item they refer to — this service has a",
      "public timeline, so a count of one against it names a post and, on the submission surface,",
      "plausibly the person behind it. The report says less when there is less to say.",
      "",
      "Deletions of encrypted objects are not listed. Those are people deleting their own",
      "messages with a capability they hold, not decisions anyone made about them, and logging",
      "them here would make a transparency report into a record of private deletions.",
    ],
  };
}
