/**
 * How linkable sending is right now — the number, and the rules for not lying with it.
 *
 * `decisions/0029` and its amendment. `channel.activeAccount` on the disclosure table says an
 * operator holding the vault's grouping and the public chain can ask whose chain events' upload
 * windows contain this channel's objects, and get **100%** for the account that sent them. What
 * decides whether that names anybody is how many OTHER accounts published often enough to cover
 * the same uploads — and that is a public, readable, live quantity.
 *
 * So this is the one lever a user actually holds: choosing when. It hides nothing and claims
 * nothing. It costs a chain read.
 *
 * THREE RULES, each of which a natural implementation gets wrong, and each measured:
 *
 *   1. **Never average.** `E[1/(1+X)]` is not `1/(1+E[X])`. A mean crowd of 3.9 reads as an
 *      operator accuracy of 0.204 while the measured accuracy is 0.365 — the error runs toward
 *      over-claiming safety. A conversation is only ever shown its OWN crowd.
 *   2. **Show the pruned crowd.** Pruning candidates an operator would discount as automated can
 *      only shrink the crowd, so the pruned figure is a lower bound and cannot tell a user they
 *      are safer than they are. There is no principled place to stop pruning, which is exactly
 *      why the conservative end is the one to publish.
 *   3. **Zero is the normal answer.** On quiet mainnet ranges every aggressive rule reaches a
 *      crowd of zero, meaning the operator is right every time. Anything built on this is a
 *      warning light, not a reassurance meter.
 *
 * And the crowd is not a constant: five mainnet ranges hours apart measured 12.6, 5.5, 3.6, 2.0
 * and 2.3 at the design window. No published figure could stand in for that, which is the whole
 * argument for reading it at the moment of sending.
 */

/** One account and the times it published, in the same units as the uploads. */
export type Publisher = { readonly account: string; readonly times: readonly number[] };

/**
 * How many of `others` have a window covering EVERY one of `uploads`.
 *
 * EVERY, not most, and that is what makes it a crowd rather than a score. The account that sent
 * the uploads covers all of them by construction — an upload cannot precede its own event and
 * lands within one window of it — so a candidate that misses even one is not a candidate. It is
 * also why the crowd is set by the worst-covered upload rather than by the average.
 */
export function crowdOf(
  uploads: readonly number[],
  others: readonly Publisher[],
  windowMs: number,
): number {
  return covering(uploads, others, windowMs).length;
}

/**
 * The publishers whose own activity covers every one of these uploads.
 *
 * THE PREDICATE, IN ONE PLACE. `crowdOf` is its length and the client wants its members, and
 * until this existed the client had its own copy of the same `every`/`some` test written inline.
 * That is the stub problem with the polarity reversed: not a test written from the code, but a
 * TESTED FUNCTION NOBODY RAN, while users got a second implementation with nothing forcing the
 * two to agree. This feature has already produced four bugs invisible to hermetic tests; a second
 * copy of its arithmetic is the last thing it needs.
 *
 * A publisher covers an upload when they published in the same jitter window — `u >= t` and
 * `u < t + windowMs`. Half-open, because a window that included both ends would count a publisher
 * whose only activity was the instant the window closed.
 */
export function covering(
  uploads: readonly number[],
  others: readonly Publisher[],
  windowMs: number,
): Publisher[] {
  if (uploads.length === 0) throw new Error("a crowd is measured against uploads, and there are none");
  return others.filter((p) =>
    uploads.every((u) => p.times.some((t) => u >= t && u < t + windowMs)));
}

/**
 * What the operator's accuracy is against a crowd of this size.
 *
 * `1/(1 + crowd)` — the candidate set is the crowd plus you, and a maximum over equals is a coin.
 * Verified per conversation against real mainnet: a crowd of 0 is identified 1.000 of the time,
 * 1 gives 0.511 against a predicted 0.500, and 2 gives 0.338 against 0.333.
 *
 * IT TAKES A CROWD, NOT A SET OF CROWDS, and the signature is the guard: there is no overload
 * that averages, because averaging is the mistake this function exists to make hard.
 */
export const accuracyAgainst = (crowd: number): number => 1 / (1 + crowd);

/**
 * How regular an account's publishing is: the coefficient of variation of its gaps.
 *
 * A metronome scores 0 and a Poisson process scores 1. It is the cheapest automation signal there
 * is and it needs nothing but the public chain, which is the point — an operator has it too.
 *
 * Accounts with too few events to say return `Infinity`, meaning "not evidently automated". The
 * conservative direction for a REGULARITY score is high, because low is what gets pruned.
 */
export function regularity(times: readonly number[]): number {
  if (times.length < 4) return Infinity;
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter((g) => g > 0);
  if (gaps.length < 3) return Infinity;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean === 0) return 0;
  const v = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(v) / mean;
}

/**
 * How aggressively to discount candidates an operator would call automated.
 *
 * The defaults are the harsh end on purpose. Measured on real mainnet, discounting the obvious
 * automation costs about one member of a busy-range crowd of twelve — most crowd members appear
 * in under 5% of blocks, because covering a twelve-minute conversation needs six windows touched
 * rather than constant presence. On a quiet range the same rules take the crowd to zero. Both are
 * true, the client cannot tell which range it is in, and only one of them is safe to be wrong
 * about.
 */
export type Pruning = {
  /** Drop accounts whose gaps are more regular than this. 1 is a Poisson process. */
  readonly maxRegularity?: number;
  /**
   * Drop the N busiest accounts outright. **Zero by default, and that is not timidity.**
   *
   * It was measured — dropping the fifty busiest of a few hundred took a busy range's crowd from
   * 12.6 to 3.5 and a quiet range's to zero — but it is not SCALE-FREE, and a default that is not
   * scale-free is a default that is wrong somewhere. Against a candidate set of twenty it removes
   * everyone and reports a crowd of zero for a chain nobody looked at: a number that is
   * conservative by accident rather than by measurement, which is the same disease as an
   * over-claim pointed the other way. A caller measuring a specific chain can still ask for it.
   */
  readonly dropBusiest?: number;
};

/**
 * The measured, scale-free rule: discount anything more regular than a Poisson process.
 *
 * Chosen as the default because it is the harsh end of what was actually measured AND it means
 * the same thing against twenty candidates as against four hundred.
 */
export const DEFAULT_PRUNING: Required<Pruning> = { maxRegularity: 1, dropBusiest: 0 };

/** The candidates left after discounting what an operator would discount. */
export function prune(others: readonly Publisher[], opts: Pruning = {}): Publisher[] {
  const { maxRegularity, dropBusiest } = { ...DEFAULT_PRUNING, ...opts };
  const busiest = new Set([...others]
    .sort((a, b) => b.times.length - a.times.length)
    .slice(0, dropBusiest)
    .map((p) => p.account));
  // A rule that removes every candidate has not measured a quiet chain; it has measured its own
  // threshold. Refused rather than reported as a crowd of zero, because the two are
  // indistinguishable downstream and only one of them is about the chain.
  if (dropBusiest > 0 && dropBusiest >= others.length && others.length > 0) {
    throw new Error(
      `dropBusiest=${dropBusiest} removes all ${others.length} candidates — that reports a crowd `
      + "of zero for a chain nobody looked at. Lower it, or use the regularity rule, which is "
      + "scale-free.");
  }
  return others.filter((p) => !busiest.has(p.account) && !(regularity(p.times) < maxRegularity));
}

/**
 * What a user would be told, and the only shape this module offers.
 *
 * There is deliberately no way to ask for the raw crowd from here. A caller that wants one can
 * call `crowdOf` with unpruned candidates and will have written the word `crowdOf` in their own
 * code, which is the difference between a considered choice and a default.
 */
export type Linkability = {
  /** The pruned crowd. A LOWER BOUND on how many others could have produced these uploads. */
  readonly crowd: number;
  /** `1/(1 + crowd)` — how often an operator naming the sender would be right. */
  readonly identified: number;
  /** How many candidates the pruning removed, so a caller can say what was assumed. */
  readonly pruned: number;
};

export function linkability(
  uploads: readonly number[],
  others: readonly Publisher[],
  windowMs: number,
  opts: Pruning = {},
): Linkability {
  const kept = prune(others, opts);
  const crowd = crowdOf(uploads, kept, windowMs);
  return { crowd, identified: accuracyAgainst(crowd), pruned: others.length - kept.length };
}

/**
 * The crowd as a sentence, and the zero case is written first because it is the usual one.
 *
 * Measured on real mainnet: on quiet ranges every aggressive pruning rule reaches a crowd of
 * zero, and zero means an observer naming the sender is right **every time**. A rendering that
 * treated that as the error case, with the healthy number as the default, would be a reassurance
 * meter — which is the thing `decisions/0029` decided this must not be.
 *
 * THREE RULES THE WORDING IS HELD TO, each asserted in `crowd.test.ts`:
 *
 *   1. **Past tense.** The number is computed from chain history. Uploads land in the next four
 *      minutes and no query returns those, so "you will be one of N" is a claim nobody can make.
 *   2. **A cost, not a score.** The same shape as `hydra send` printing what the chain will show.
 *      No grade, no colour word, nothing that reads as a badge — this is computed from public
 *      data and verified by nobody, which is what I7 is about.
 *   3. **It only goes down, and the copy says so.** A crowd is set by its worst-covered message.
 *      A user who sees a number recover after a quiet-chain send has been told something false
 *      about a message already on the chain.
 */
export function describe(l: { known: boolean; crowd: number }): string[] {
  if (!l.known) {
    return [
      "How linkable this conversation is: not measured.",
      "Nothing has asked a node who else was publishing, so there is no number here — which is",
      "not the same as a good one.",
    ];
  }
  if (l.crowd === 0) {
    return [
      "Everything you have sent in this conversation could only have come from you.",
      "Whoever runs the storage server, reading the public chain alongside it, can name your",
      "account as the sender of every message here. Not sometimes — every time.",
      "This is the usual answer on a quiet chain.",
    ];
  }
  const one = l.crowd === 1;
  return [
    `${l.crowd} other account${one ? "" : "s"} published often enough to have produced everything`,
    `you have sent in this conversation. Someone matching your uploads against the chain picks`,
    `you out of ${l.crowd + 1} — right about ${Math.round(accuracyAgainst(l.crowd) * 100)}% of the time.`,
    "It only goes down. Sending while the chain is quiet takes it toward zero, and nothing you",
    "do later puts it back.",
  ];
}
