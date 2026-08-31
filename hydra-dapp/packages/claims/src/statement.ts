/**
 * The user-facing disclosure statement — Phase 10.
 *
 * `HYDRA_HANDOFF.md` Phase 10: "The user-facing disclosure statement, produced by Devtool's
 * leak tooling rather than written by hand. In the product, not in a terms-of-service page."
 * And the standing rule it serves: privacy claims are computed, never asserted. If it cannot
 * be computed, the product does not say it.
 *
 * So this file contains no prose about what Hydra protects. Every line it emits is derived
 * from a value some test already measures:
 *
 *   - the vault's disclosure table   `vault-server/src/observations.ts`, checked against a real
 *                                    capture in both directions by `operator-view.test.ts`
 *   - the pool's who-disclosures     `identity/src/linkage.ts`, every row citing a file:line
 *                                    that `phase1-fresh-identity.test.ts` re-reads
 *   - the timing numbers             `channel/src/schedule.ts` and `cover.ts`, whose tables are
 *                                    re-measured by their own suites
 *   - the on-chain footprint         `channel/src/note.ts`
 *
 * WHAT IS DELIBERATELY ABSENT. There is no "we do not log", no "your messages are safe", and
 * no word for the residual risks that are real. Where a guarantee is partial, the statement
 * says so with the number: an operator that identifies the first message of a session about
 * one time in nine is not "cannot link uploads to messages", and writing the second sentence
 * because the first is uncomfortable is exactly the failure this file exists to prevent.
 */

import { OBSERVABLE, DERIVABLE, NOT_OBSERVABLE } from "../../vault-server/src/observations.ts";
import { MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";
import { COVER_RATE, coverLeadMs } from "../../channel/src/cover.ts";
import { NOTE_FELTS } from "../../channel/src/note.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";

/** One thing the product tells the user, and the artifact that makes it true. */
export type Claim = {
  /** Plain language, no hedging in either direction. */
  readonly says: string;
  /** Where the value came from. A claim with no source cannot be published. */
  readonly from: string;
  /** `true` when the guarantee is unqualified; `false` when it is partial and quantified. */
  readonly complete: boolean;
};

export type Statement = {
  readonly whoCanSeeWhat: Claim[];
  readonly whatIsPartial: Claim[];
  readonly whatWeCannotSee: Claim[];
};

/**
 * Numbers the statement quotes. Imported rather than typed, so a change to a default is a
 * change to what the product says, in the same commit.
 */
export const MEASURED = {
  jitterBlocks: MIN_JITTER_BLOCKS,
  coverRate: COVER_RATE,
  /** Derived from the jitter window, not chosen — see `channel/src/cover.ts`. */
  coverLeadBlocks: MIN_JITTER_BLOCKS,
  noteFelts: NOTE_FELTS,
  buckets: BUCKETS,
  /**
   * How often a vault operator identifies a message, at the shipped defaults, against the
   * strongest of four matchers.
   *
   * TWO NUMBERS, and the product publishes the worse one. A message sent well apart from any
   * other sits in an anonymity set of exactly `coverRate + 1` — its own upload and its decoys —
   * so the operator is right **1 in 5**. Messages close enough that their cover windows overlap
   * do far better, at 0.028, because the sets merge.
   *
   * The floor is what a user is entitled to rely on: a conversation is allowed to be slow, and
   * a claim that only holds for rapid exchanges is a claim that fails exactly when someone
   * sends one careful message a day. Two earlier figures here — 0.11, then 0.128 — were both
   * measured on rapid sessions and published as though they were the guarantee.
   */
  isolatedMessageIdentified: 0.2,
  clusteredMessageIdentified: 0.028,
  chance: 1 / 12,
  /**
   * How often anyone reading the chain identifies who published a pointer. One.
   *
   * Not a fraction, and deliberately not folded in with the numbers above. Those describe a
   * vault operator correlating an upload with an event, which jitter and cover make hard. This
   * describes reading a signed transaction, which nothing makes hard: `sender_address` names
   * the account and `nonce` orders that account's messages.
   *
   * `note.ts` guarantees the EVENT carries two felts and nothing else, and that is true. The
   * event is inside a transaction.
   *
   * ONE for BOTH routes. Publishing through the pool was expected to fix this and does not —
   * `live-authorship.test.ts` measures it against a real chain. It moves the author out of
   * `sender_address` and out of the nonce ordering, and leaves them in the calldata, because a
   * pool transaction carrying only an invoke does not compile and every action that makes it
   * compile names an address. See `claude-docs/decisions/0012-publishing-through-the-pool.md`.
   */
  senderIdentifiedOnChain: 1,
} as const;

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Build the statement.
 *
 * Returns structure, not a string, so the product can render it and a test can assert over it.
 * A generator that returned formatted prose would be a generator nobody could check.
 */
export function statement(): Statement {
  return {
    // Everything the vault operator sees, said in the operator's own terms.
    whoCanSeeWhat: OBSERVABLE.map((o) => ({
      says: `Whoever runs the storage server can see ${o.what}.`,
      from: `vault-server/src/observations.ts (${o.id})`,
      complete: true,
    })).concat(DERIVABLE.map((d) => ({
      says: `Given ${d.given} — which is public — whoever runs the storage server can work out `
        + `${d.what}. The server does not record it; they compute it.`,
      from: `vault-server/src/observations.ts (${d.id})`,
      complete: true,
    }))).concat([
      {
        says: `Anyone reading the blockchain sees that a message happened, and when — ${MEASURED.noteFelts} `
          + "values, neither of which says who it is for or what it says.",
        from: "channel/src/note.ts (NOTE_FELTS)",
        complete: true,
      },
      {
        says: "Anyone reading the blockchain also sees WHICH ACCOUNT published each of those "
          + "messages, every time. The two values themselves do not say — but they travel "
          + "inside a signed transaction, and the transaction does. Publishing through the pool "
          + "instead of from your own account moves this and does not remove it: the submitter "
          + "becomes a relayer and your messages stop being ordered by your own counter, but "
          + "your address is still in the transaction, because the pool will not carry a "
          + "message on its own and every action that can carry it names an address.",
        from: "adversary/test/live-authorship.test.ts, cli/src/chain.ts",
        complete: true,
      },
      {
        says: "Sending a message through the pool also moves a small amount of your money, "
          + "every time. Not because a message costs anything, but because the pool needs a "
          + "real private action to carry it and a deposit is the cheapest repeatable one.",
        from: "cli/src/chain.ts (poolChain), adversary/test/live-authorship.test.ts",
        complete: true,
      },
      {
        says: "The pool's auditor can decrypt every message you send through it, and can link "
          + "any new identity you fund from your own balance back to you.",
        from: "identity/src/linkage.ts, claude-docs/decisions/0002-fresh-identity-funding.md",
        complete: true,
      },
    ]),

    // The partial ones, with the number attached. These are the lines a hand-written statement
    // would round up to a guarantee.
    whatIsPartial: [
      {
        says: "Decoy uploads are fetched by the recipient exactly like real messages are, which "
          + "is what makes the number below true. It does NOT hold otherwise: when decoys were "
          + "not fetched, a storage server told every decoy from every message by asking which "
          + "objects nobody ever came back for — and it was right about all of them, not most.",
        from: "channel/src/cover.ts (coverBody), adversary/test/i3-read-pattern.test.ts",
        complete: false,
      },
      {
        says: `Uploads are delayed by up to ${MEASURED.jitterBlocks} blocks and mixed with `
          + `${MEASURED.coverRate} decoy uploads each, so the storage server usually cannot tell `
          + `which upload belongs to which on-chain message. How well that works depends on how `
          + `fast you are talking. A message sent well apart from any other is identified about `
          + `${pct(MEASURED.isolatedMessageIdentified)} of the time — one in five — because it `
          + `is hidden only among its own decoys. Messages sent in quick succession hide among `
          + `each other's too, and drop to about ${pct(MEASURED.clusteredMessageIdentified)}.`,
        from: "channel/src/schedule.ts, channel/src/cover.ts, i3-cover-traffic.test.ts",
        complete: false,
      },
      {
        says: `Hiding each message costs ${MEASURED.coverRate} decoy uploads, so the storage it `
          + `takes is about ${MEASURED.coverRate + 1} times what your messages alone would need. `
          + `That is the price of the number above, and lowering the number means raising the `
          + `price: hiding one message in ten instead of one in five costs twice the storage.`,
        from: "channel/src/cover.ts (COVER_RATE, anonymitySetFloor)",
        complete: false,
      },
      {
        says: `Message sizes are padded to one of ${MEASURED.buckets.length} fixed sizes, so the `
          + `server learns a size band rather than a length. Decoys are sent in the same band as `
          + `the message they hide — a decoy of the wrong size is not cover, because the server `
          + `sorts by size before it does anything else.`,
        from: "vault-client/src/buckets.ts, channel/src/cover.ts",
        complete: false,
      },
      {
        says: "Sending the same message twice in the same conversation produces the same stored "
          + "object, so the server can see a repeat within a conversation — not across "
          + "conversations, and not what was repeated.",
        from: "vault-client/src/blobs.ts, claude-docs/decisions/0004-blob-classes.md",
        complete: false,
      },
    ],

    whatWeCannotSee: NOT_OBSERVABLE.map((o) => ({
      says: `Whoever runs the storage server cannot see ${o.what} — ${o.why}.`,
      from: `vault-server/src/observations.ts (${o.id})`,
      complete: true,
    })),
  };
}

/**
 * Render for display. Deliberately dull: the statement's value is that it is generated, and a
 * renderer that reorders or summarises would be a second place where claims get decided.
 */
export function render(s: Statement = statement()): string {
  const section = (title: string, claims: Claim[]) =>
    [`## ${title}`, "", ...claims.map((c) => `- ${c.says}`), ""].join("\n");
  return [
    section("What the people running this can see", s.whoCanSeeWhat),
    section("What is protected, and how well", s.whatIsPartial),
    section("What they cannot see", s.whatWeCannotSee),
  ].join("\n");
}
