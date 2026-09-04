/**
 * Appealing a decision — `decisions/0035` §5, rebuilt to the shape `decisions/0037` argues for.
 *
 * Whoever published can appeal, and they can prove it without any new identity system: the
 * on-chain commitment is theirs and the account that published the pointer signed that
 * transaction. So an appellant proves authorship by signing a statement naming the decision.
 *
 * THE APPEAL IS A DETACHED ARTIFACT, AND THAT IS THE PRIVACY DECISION IN THIS FILE.
 *
 * An appeal is self-authenticating, so it does not have to arrive over a connection the operator
 * can attribute. That matters because the appeal is otherwise the strongest deanonymisation step
 * in the pipeline: before one, the operator knows account X published post P, which is public and
 * already disclosed. After one delivered directly, they also know that someone who can sign for X
 * contacted them at time T over a network path they terminate — an IP, an SNI and a session
 * correlated to a Starknet account. **The appeal converts a chain identity into a network
 * observation, at the moment the user is under pressure and least likely to weigh it.**
 *
 * THERE IS NO CHALLENGE AND NO NONCE, AND REMOVING THEM IS WHY THIS FILE WAS REWRITTEN.
 *
 * The previous version had the operator mint a fresh nonce and hand it to the appellant. That
 * defeats the paragraph above one step earlier than anyone was looking: **fetching a challenge is
 * a connection the appellant makes to the operator, correlated to the decision being contested.**
 * You cannot relay the paper if you had to appear in person to collect it.
 *
 * A nonce here only ever did two jobs, and neither needs it:
 *
 *   - Replay onto a DIFFERENT decision, carried by binding the signature to the decision id.
 *   - Replay onto the SAME decision twice, carried by recording one appeal per (decision,
 *     account) — which the operator must do anyway, because appeal outcomes go in the report.
 *
 * And the freshness a nonce usually buys is already there: **the decision id did not exist before
 * the decision**, so a signature over it cannot predate what it contests. That is the only
 * time-ordering an appeal needs. Removing the nonce therefore deletes a whole tail: no published
 * set, no rotation window, no coarse timing disclosure, and no TTL that means one thing for an
 * interactive exchange and another for a person carrying a document under pressure. It removes a
 * disclosure rather than adding one.
 *
 * WHAT IT COSTS, stated rather than found later: the artifact does not expire. A signature proving
 * that account X contested decision D is valid forever and transferable, so anyone who obtains one
 * can file it, or sit on it. Filing it is the design working, because relaying is the point.
 * Sitting on it withholds an appeal the appellant believes they sent — a real harm, and inherent
 * to any relayed artifact rather than something the nonce fixed: a nonce-bearing artifact could be
 * withheld exactly as easily and merely expired afterwards.
 */

import { createHash } from "node:crypto";

/** One appeal, once accepted. The record the transparency report is generated from. */
export type Appeal = {
  readonly decisionId: string;
  /** The Starknet account that signed. Public already — it published the object being appealed. */
  readonly account: string;
  readonly at: number;
  readonly outcome?: "upheld" | "denied";
};

/**
 * What an appellant signs.
 *
 * BOUND TO THE DECISION AND TO NOTHING ELSE. The domain string is first and fixed, so this cannot
 * collide with `anchorStatement` or `prekeyStatement` — two signatures by one key over overlapping
 * fields is how a signature for one purpose becomes a signature for another.
 *
 * The ACCOUNT is deliberately absent from the statement. The signature is verified against that
 * account, so naming it inside would restate a value the verifier already holds, and a field that
 * can disagree with its own check is a bug waiting for somebody to trust the wrong copy.
 */
export function appealStatement(decisionId: string): Buffer {
  return Buffer.concat([
    Buffer.from("hydra/moderation/appeal/v1 "),
    Buffer.from(decisionId, "utf8"),
  ]);
}

/** The digest an account signs. Separate so a caller cannot accidentally sign the raw bytes twice. */
export const appealDigest = (decisionId: string): string =>
  createHash("sha256").update(appealStatement(decisionId)).digest("hex");

/** Appeals the operator has accepted, and what became of them. */
export class Appeals {
  readonly #filed = new Map<string, Appeal>();

  /** One appeal per decision per account. The key that makes a second submission a no-op. */
  static key = (decisionId: string, account: string): string => `${decisionId} ${account}`;

  /**
   * Verify an artifact and record the appeal.
   *
   * CONSUMED ON SUCCESS, NEVER ON FAILURE. The previous version deleted the challenge before
   * verifying, to stop an attacker grinding signatures against a live one. That defence had the
   * SECRET CHALLENGE as its premise, and there is no longer a challenge to grind — so consuming on
   * failure now buys nothing and costs a **denial of service on the appeal path**: anyone who knows
   * a decision id could submit junk against it and burn the appellant's one attempt at contesting
   * it, at exactly the moment the appellant has no other recourse.
   *
   * A duplicate is `accepted: false` with a reason rather than an error, because the honest reading
   * of a second valid artifact is that somebody relayed it twice, which the detached design invites.
   */
  async accept(
    decisionId: string,
    account: string,
    signature: readonly string[],
    now: number,
    verify: (account: string, digest: string, signature: readonly string[]) => Promise<boolean>,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const key = Appeals.key(decisionId, account);
    if (this.#filed.has(key)) {
      return { accepted: false, reason: "this account has already appealed this decision" };
    }
    // Verified BEFORE anything is recorded, so a failed attempt leaves no trace of having been
    // made. An unverified submission is not evidence that anybody appealed anything, and a store
    // of attempted-but-unproven appeals would name accounts that never signed for one.
    if (!await verify(account, appealDigest(decisionId), signature)) {
      return { accepted: false, reason: "the signature did not verify" };
    }
    this.#filed.set(key, { decisionId, account, at: now });
    return { accepted: true };
  }

  /** Record what the operator decided about an appeal. */
  resolve(decisionId: string, account: string, outcome: "upheld" | "denied"): Appeal {
    const key = Appeals.key(decisionId, account);
    const existing = this.#filed.get(key);
    if (!existing) throw new Error(`no appeal from ${account} against ${decisionId}`);
    const resolved = { ...existing, outcome };
    this.#filed.set(key, resolved);
    return resolved;
  }

  /** Every appeal accepted, decided or not. */
  filed(): Appeal[] {
    return [...this.#filed.values()];
  }

  /** Appeals still waiting on the operator. */
  outstanding(): Appeal[] {
    return this.filed().filter((a) => a.outcome === undefined);
  }

  /** Plain data, for the same reason the queue has it: a tool that forgets is not a surface. */
  restore(appeals: readonly Appeal[]): void {
    for (const a of appeals) this.#filed.set(Appeals.key(a.decisionId, a.account), a);
  }
}
