/**
 * The timing adversary, as a set of strategies rather than one.
 *
 * Every I3 harness here measured a single matcher: for each chain event, the upload nearest it
 * in time. That is one thing an operator might try, and it is not the best one. Measured over
 * the same sessions, an order-preserving matcher — sort the uploads, call the k-th one the k-th
 * message — scores **0.227** against greedy's 0.138 on an undefended session. Every number
 * this project published for the undefended case was therefore too kind to the defence.
 *
 * The mistake is the same shape as the jitter one: I measured what I thought of first and wrote
 * the result down as *the* result. An adversary is not a strategy. It is whoever is attacking
 * you, using whichever strategy works, so a harness has to take the **maximum** over the ones
 * it knows and stay honest that the real maximum is over strategies nobody here thought of.
 *
 * Taking the max also stops a defence looking good by accident. Cover traffic drives the
 * order-preserving matcher to 0.001 — far *below* chance — and a harness reporting only that
 * would be claiming a defence far stronger than the 0.128 the greedy matcher still achieves.
 * Below chance is not safety; it is a different signal, and it is not the number to publish.
 */

/** An upload as the operator sees it: when it arrived, and (for scoring) what it really was. */
export type Arrival = { readonly t: number; readonly real: boolean; readonly seq: number };

/** Per-message hits, 1 where the operator correctly identified message i. */
export type Hits = number[];

export type Matcher = {
  readonly name: string;
  readonly why: string;
  readonly run: (events: readonly number[], uploads: readonly Arrival[]) => Hits;
};

/** For each event independently, the nearest upload. Collisions allowed. */
const greedy: Matcher = {
  name: "greedy",
  why: "for each event, the upload nearest it in time — the obvious attack, and the one every harness used to measure alone",
  run: (events, uploads) => {
    const hits = new Array(events.length).fill(0);
    for (let i = 0; i < events.length; i++) {
      let best = -1;
      let gap = Infinity;
      for (let j = 0; j < uploads.length; j++) {
        const d = Math.abs(uploads[j].t - events[i]);
        if (d < gap) { gap = d; best = j; }
      }
      if (uploads[best]?.real && uploads[best].seq === i) hits[i] = 1;
    }
    return hits;
  },
};

/**
 * A one-to-one assignment: all pairs sorted by distance, taken without reuse.
 *
 * Strictly more disciplined than greedy and, counter-intuitively, usually worse at this — two
 * events genuinely can be nearest the same upload, and forbidding that costs more than the
 * discipline gains. Kept because it is the version a thoughtful operator would reach for, and
 * because "we tried the smarter one and it did worse" is a fact worth having measured.
 */
const unique: Matcher = {
  name: "unique",
  why: "a one-to-one assignment by nearest distance, which is more disciplined and usually does worse",
  run: (events, uploads) => {
    const pairs: [number, number, number][] = [];
    events.forEach((e, i) => uploads.forEach((u, j) => pairs.push([Math.abs(u.t - e), i, j])));
    pairs.sort((a, b) => a[0] - b[0]);
    const takenEvent = new Set<number>();
    const takenUpload = new Set<number>();
    const hits = new Array(events.length).fill(0);
    for (const [, i, j] of pairs) {
      if (takenEvent.has(i) || takenUpload.has(j)) continue;
      takenEvent.add(i);
      takenUpload.add(j);
      if (uploads[j].real && uploads[j].seq === i) hits[i] = 1;
    }
    return hits;
  },
};

/**
 * Ignore distance entirely: sort the uploads and call the k-th one the k-th message.
 *
 * The strongest of these on an undefended session, by a wide margin, because jitter narrower
 * than the gap between messages preserves order even when it obscures distance. It is also the
 * one cover traffic destroys most completely, since decoys shift every position.
 */
const ordered: Matcher = {
  name: "ordered",
  why: "sort the uploads and call the k-th the k-th message — jitter obscures distance long before it disturbs order",
  run: (events, uploads) => {
    const sorted = [...uploads].sort((a, b) => a.t - b.t);
    const hits = new Array(events.length).fill(0);
    for (let i = 0; i < events.length; i++) {
      if (sorted[i]?.real && sorted[i].seq === i) hits[i] = 1;
    }
    return hits;
  },
};

/**
 * The cheapest attack there is: the session's earliest upload is its first message.
 *
 * It answers one question and no others, which is why its mean is near zero and its
 * first-message score is the same as everything else's. It exists to keep the structural leak
 * visible on its own terms — no jitter width defeats it, only cover does.
 */
const firstIsFirst: Matcher = {
  name: "first-is-first",
  why: "the earliest upload of a session is its first message, since an upload cannot precede its own event",
  run: (events, uploads) => {
    const sorted = [...uploads].sort((a, b) => a.t - b.t);
    const hits = new Array(events.length).fill(0);
    if (sorted[0]?.real && sorted[0].seq === 0) hits[0] = 1;
    return hits;
  },
};

/**
 * Throw away everything that arrived in a crowd, then take the nearest of what is left.
 *
 * Written for the resident client and it belongs here rather than in that test, because a
 * strategy an operator can use against one client is a strategy they can use against all of
 * them, and `best` is a maximum over strategies.
 *
 * What it exploits: a client only learns a message exists when the user sends it, so every decoy
 * the schedule wanted to put BEFORE the chain event is already past due, and a client that
 * honours the schedule promptly uploads all of them back to back. The message itself still waits
 * for its own slot. So the crowd is cover and whatever went up alone is the message — measured
 * at **0.347** against a one-second-tick client, versus **0.240** for the schedule as written.
 * The client that tried hardest to obey was half again as easy to read.
 *
 * A CROWD IS PROXIMITY, NOT EQUALITY, and the first version of this got that wrong. Uploads are
 * sequential HTTP requests, so a burst is a run of arrivals milliseconds apart rather than a set
 * sharing one timestamp; grouping on exact equality found no crowd at all and reported the
 * defence intact. The threshold is taken from the session itself — a tenth of the median gap —
 * so nothing here needs to know the block interval or the jitter window.
 */
const afterTheBurst: Matcher = {
  name: "after-the-burst",
  why: "discard runs of uploads that arrive far closer together than the session's own rhythm, then take the nearest — a burst is a client catching up, not a message",
  run: (events, uploads) => {
    const sorted = [...uploads].map((u, i) => ({ u, i })).sort((a, b) => a.u.t - b.u.t);
    const gaps = sorted.slice(1).map((x, i) => x.u.t - sorted[i].u.t).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
    const close = median / 10;

    const solo: Arrival[] = [];
    let run: typeof sorted = [];
    const flush = () => {
      if (run.length === 1) solo.push(run[0].u);
      run = [];
    };
    for (const entry of sorted) {
      if (run.length && entry.u.t - run[run.length - 1].u.t > close) flush();
      run.push(entry);
    }
    flush();

    const hits = new Array(events.length).fill(0);
    for (let i = 0; i < events.length; i++) {
      let best = -1;
      let gap = Infinity;
      for (let j = 0; j < solo.length; j++) {
        const d = Math.abs(solo[j].t - events[i]);
        if (d < gap) { gap = d; best = j; }
      }
      if (solo[best]?.real && solo[best].seq === i) hits[i] = 1;
    }
    return hits;
  },
};

export const MATCHERS: readonly Matcher[] = [greedy, unique, ordered, firstIsFirst, afterTheBurst];

export type Score = {
  /** How often message 0 was identified — the structural leak. */
  readonly first: number;
  /** Mean per-message accuracy across the session. */
  readonly mean: number;
  /** Which matcher achieved it. Different metrics can have different winners. */
  readonly by: string;
};

/**
 * The best an operator does, taken per metric.
 *
 * Per metric rather than picking one overall winner, because they genuinely differ: on a
 * defended session `greedy` is best at the first message while `unique` is best on the mean.
 * An adversary chooses its strategy after deciding what it wants to know.
 */
export function best(
  sessions: Iterable<{ events: readonly number[]; uploads: readonly Arrival[] }>,
): { first: Score; mean: Score } {
  const runs = [...sessions];
  const totals = MATCHERS.map((m) => {
    let first = 0;
    let mean = 0;
    for (const s of runs) {
      const hits = m.run(s.events, s.uploads);
      first += hits[0];
      mean += hits.reduce((a, b) => a + b, 0) / hits.length;
    }
    return { name: m.name, first: first / runs.length, mean: mean / runs.length };
  });
  const bestBy = (key: "first" | "mean") =>
    totals.reduce((a, b) => (b[key] > a[key] ? b : a));
  const f = bestBy("first");
  const m = bestBy("mean");
  return {
    first: { first: f.first, mean: f.mean, by: f.name },
    mean: { first: m.first, mean: m.mean, by: m.name },
  };
}
