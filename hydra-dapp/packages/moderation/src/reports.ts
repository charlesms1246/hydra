/**
 * Report intake for the public class — `decisions/0035` §2.
 *
 * Public blobs only. There is no report path for the encrypted class, because the operator cannot
 * read it and so has nothing to judge; that class has a capability instead (`§1`). A report filed
 * against an encrypted blob is refused rather than silently dropped: a reporter who believes they
 * have been heard and has not is worse served than one told the truth.
 *
 * REPORT-FLOODING IS CENSORSHIP, NOT SPAM. An adversary files reports against a target's posts to
 * force removal, or to drown the queue so nothing real is seen. The usual defence is a rate limit
 * per reporter, and **there is no reporter to limit**: `uploader.identity` says this service has no
 * accounts, and anything identifying a reporter well enough to limit them would be the first
 * identity in the system.
 *
 * So the bound is structural instead. **One review per object, many reports attached to it.** Ten
 * thousand reports against one post produce one review; reports against every post produce at most
 * one review each. Review labour is bounded by the size of the public corpus rather than by the
 * adversary's effort, and no identity is needed to achieve it.
 */

/** One report as filed. No reporter identity is stored — see `Decision` and `decisions/0035` §7. */
export type Report = { readonly body: string; readonly at: number };

/**
 * A decision, and the whole record kept about one.
 *
 * Blob id, outcome, category, date. **No reporter identity, ever** — a store that names reporters
 * is discoverable and is the most dangerous file this service would keep.
 */
export type Decision = {
  readonly blobId: string;
  readonly outcome: "removed" | "kept";
  readonly category: string;
  readonly at: number;
};

/**
 * How many DISTINCT report bodies one review keeps.
 *
 * NOT ONE, and that is the difference between deduplicating the REVIEW and deduplicating the
 * REPORTS. Collapsing every report into the first one lets an adversary own the framing: file
 * something frivolous with an innocuous description, and every genuine report arriving while it is
 * pending is absorbed into it. The object gets reviewed — so the defence looks like it worked —
 * and the reviewer reads "I don't like this" instead of what the genuine reporter wrote. Review
 * happened; the information that would have changed its outcome did not survive.
 *
 * DISTINCT IS THE LOAD-BEARING WORD, and the first version of this dropped it. Keeping the first
 * N bodies whatever they say means an adversary who floods FIRST owns every slot: measured on ten
 * thousand identical reports with one genuine one at position 500, the genuine body did not
 * survive. Keeping the last N is the same attack mirrored. Sampling loses it with probability
 * N/total.
 *
 * Deduplicating by body makes a cheap flood occupy ONE slot, because a flood is repetitive and a
 * genuine report is not. An adversary willing to vary their text can still fill the slots — that
 * is a real residual and it is stated in `decisions/0035` rather than papered over — but it is a
 * far higher bar than a loop, and every variation is itself something a reviewer can see.
 */
export const BODIES_KEPT = 32;

/** A review in progress: one object, the reports attached to it, and what did not fit. */
export type Review = {
  readonly blobId: string;
  readonly reports: readonly Report[];
  /** Reports beyond {@link BODIES_KEPT}. Counted, because the count is not nothing. */
  readonly overflow: number;
  readonly openedAt: number;
};

/**
 * The queue. Pending reviews and the decisions already made.
 *
 * Dedup is on PENDING reviews only. Deduplicating decided ones would immunise: report a post
 * frivolously, have it reviewed and kept, and every later genuine report of the same object is
 * deduped away — the defence becomes the attack.
 */
export class Reports {
  readonly #open = new Map<string, Review>();
  readonly #decided: Decision[] = [];
  /**
   * AGGREGATE COUNTERS, NOT RECORDS, and the distinction is what keeps `decisions/0035` D8 intact.
   *
   * A transparency report has to say how many reports arrived, and the decision record — fixed at
   * `at, blobId, category, outcome` — cannot say: a review's report count is discarded when it is
   * decided. Checking that BEFORE writing the generator was the point of the check; discovering it
   * afterwards is how a retention decision quietly reopens in favour of keeping more.
   *
   * The resolution is a number rather than a row. A monotonic count of reports received carries
   * nothing about who filed them, which item they concerned, or when beyond the period — so the
   * record stays at its minimum and the report can still be honest about volume.
   */
  #reportsReceived = 0;

  /**
   * File a report against a public blob.
   *
   * Attaches to the object's open review, or opens one. An adversary can hold a review open
   * forever by filing again the moment each decision lands — and that is now harmless rather than
   * merely bounded, because holding the container open does not let them control what is in it.
   */
  file(blobId: string, body: string, at: number): Review {
    this.#reportsReceived++;
    const open = this.#open.get(blobId);
    if (!open) {
      const review = { blobId, reports: [{ body, at }], overflow: 0, openedAt: at };
      this.#open.set(blobId, review);
      return review;
    }
    // A body already attached adds a repetition, not a report. It is counted and not stored,
    // which is what makes a loop cost one slot instead of all of them.
    const known = open.reports.some((r) => r.body === body);
    const room = !known && open.reports.length < BODIES_KEPT;
    const next: Review = {
      ...open,
      reports: room ? [...open.reports, { body, at }] : open.reports,
      overflow: room ? open.overflow : open.overflow + 1,
    };
    this.#open.set(blobId, next);
    return next;
  }

  /** How many reports have arrived. An aggregate — see `#reportsReceived`. */
  received(): number {
    return this.#reportsReceived;
  }

  /** Every decision made, for the transparency report to be generated from. */
  decisions(): readonly Decision[] {
    return this.#decided;
  }

  /** Reviews waiting for a human. One per object, whatever the report volume. */
  pending(): Review[] {
    return [...this.#open.values()];
  }

  /** Decisions already made about an object, oldest first. Real evidence — see `summarise`. */
  history(blobId: string): Decision[] {
    return this.#decided.filter((d) => d.blobId === blobId);
  }

  /** Close a review. The object becomes reportable again, which is what stops immunisation. */
  decide(blobId: string, outcome: Decision["outcome"], category: string, at: number): Decision {
    const d = { blobId, outcome, category, at };
    this.#decided.push(d);
    this.#open.delete(blobId);
    return d;
  }
}

/**
 * What a reviewer is shown, and the sentence that has to travel with the number.
 *
 * A REPORT COUNT IS NOT A PERSON COUNT, and `no-accounts` is precisely why it cannot be. Fifty
 * reports may be fifty people or one adversary with a loop, and there is no identity anywhere in
 * this system that could distinguish them — that is the design working, not a gap in it.
 *
 * So a bare count reads as weight of numbers while carrying none, and a reviewer under time
 * pressure treats "reported 50 times" as corroboration. That is `decisions/0029`'s averaging
 * failure in a different place: a number that reads as more than it means, in front of somebody
 * who will act on the reading. The fix is the same one the crowd uses — the count and its limit
 * arrive in the same breath, as a cost rather than a score.
 *
 * PRIOR DECISIONS ARE EVIDENCE AND ARE SHOWN. Prior VOLUME is not, and is not.
 */
export function summarise(review: Review, history: readonly Decision[]): string[] {
  const total = review.reports.length + review.overflow;
  return [
    `${total} report${total === 1 ? "" : "s"} about this object.`,
    "That is a count of reports, not of people. This service has no accounts, so nothing here can",
    "tell fifty reporters from one sender in a loop — repetition is not corroboration.",
    ...(review.overflow
      ? [`Showing ${review.reports.length}; ${review.overflow} more were not kept.`] : []),
    ...(history.length
      ? [`Previously decided ${history.length} time${history.length === 1 ? "" : "s"}: `
        + `${history.map((d) => `${d.outcome} (${d.category})`).join(", ")}.`]
      : ["No previous decision about this object."]),
  ];
}
