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

import { OBSERVABLE, NOT_OBSERVABLE } from "../../vault-server/src/observations.ts";
import { MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";
import { COVER_RATE, COVER_LEAD_BLOCKS } from "../../channel/src/cover.ts";
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
  coverLeadBlocks: COVER_LEAD_BLOCKS,
  noteFelts: NOTE_FELTS,
  buckets: BUCKETS,
  /**
   * How often a vault operator identifies the first message of a session, at the shipped
   * defaults, against a chance of 1/12. Measured in `i3-cover-traffic.test.ts`, which fails if
   * it moves — so this constant cannot drift away from the thing it describes.
   */
  firstMessageIdentified: 0.11,
  chance: 1 / 12,
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
    })).concat([
      {
        says: "Anyone reading the blockchain sees that a message happened, and when — "
          + `${MEASURED.noteFelts} values, neither of which says who sent it, who it is for, or what it says.`,
        from: "channel/src/note.ts (NOTE_FELTS)",
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
        says: `Uploads are delayed by up to ${MEASURED.jitterBlocks} blocks and mixed with decoy `
          + `traffic, so the storage server usually cannot tell which upload belongs to which `
          + `on-chain message. Usually is not always: for the first message of a session it `
          + `still guesses right about ${pct(MEASURED.firstMessageIdentified)} of the time, `
          + `against ${pct(MEASURED.chance)} for a coin flip.`,
        from: "channel/src/schedule.ts, channel/src/cover.ts, i3-cover-traffic.test.ts",
        complete: false,
      },
      {
        says: `Message sizes are padded to one of ${MEASURED.buckets.length} fixed sizes, so the `
          + `server learns a size band rather than a length. Decoys are per band, so a message `
          + `in an unusual size band has less cover than one in a common band.`,
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
