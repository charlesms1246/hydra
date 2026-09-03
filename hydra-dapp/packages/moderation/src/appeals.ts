/**
 * Appealing a removal — `decisions/0035` §5.
 *
 * Whoever published can appeal, and they can prove it without any new identity system: the
 * on-chain commitment is theirs and the account that published the pointer signed that
 * transaction. So an appellant proves authorship by signing a challenge with the same account.
 *
 * That instrument only exists because publishing is on chain, and it works for the encrypted class
 * too, where the operator otherwise has no idea who to talk to.
 *
 * THE APPEAL IS A DETACHED ARTIFACT, AND THAT IS THE PRIVACY DECISION IN THIS FILE.
 *
 * An appeal is self-authenticating — a signature over a statement naming the decision — so it does
 * not have to arrive over a connection the operator can attribute. That matters because the appeal
 * is otherwise the strongest deanonymisation step in the whole pipeline: before one, the operator
 * knows account X published post P, which is public and already disclosed. After one delivered
 * directly, they also know that someone who can sign for X contacted them at time T over a network
 * path they terminate — and this server terminates TLS, so that is an IP, an SNI and a session
 * correlated to a Starknet account. **The appeal converts a chain identity into a network
 * observation, at the moment the user is under pressure and least likely to weigh it.**
 *
 * Being detached means it can be handed to anybody, posted anywhere, or relayed. The operator
 * verifies the artifact, not the connection. `appeal.filed` on the disclosure table says what is
 * learned either way, because a user who chooses to deliver it themselves should know what that
 * costs.
 */

import { createHash, randomBytes } from "node:crypto";

/** How long a challenge is good for. Short, because its only job is to prevent replay. */
export const CHALLENGE_TTL_MS = 15 * 60 * 1000;

export type Challenge = {
  /** Which decision is being contested. Binding to it is what stops one appeal moving to another. */
  readonly decisionId: string;
  readonly nonce: string;
  readonly expiresAt: number;
};

/**
 * What an appellant signs.
 *
 * BOUND TO THE DECISION AND TO A FRESH NONCE. A signature over a bare challenge is replayable —
 * to appeal a different decision with the same proof, or the same decision twice. This repo has
 * the pattern already: `b473c4b`, a replayed header changes nothing.
 *
 * The domain string is first and fixed, so this can never collide with `anchorStatement` or
 * `prekeyStatement`. Two signatures by one key over overlapping fields is how a signature for one
 * purpose becomes a signature for another.
 */
export function appealStatement(c: Challenge): Buffer {
  return Buffer.concat([
    Buffer.from("hydra/moderation/appeal/v1 "),
    Buffer.from(c.decisionId, "utf8"),
    Buffer.from(" "),
    Buffer.from(c.nonce, "hex"),
  ]);
}

/** The digest an account signs. Separate so a caller cannot accidentally sign the raw bytes twice. */
export const appealDigest = (c: Challenge): string =>
  createHash("sha256").update(appealStatement(c)).digest("hex");

/**
 * Challenges the operator has issued and not yet seen used.
 *
 * SINGLE USE AND EXPIRING, both. Expiry alone would let one signature be replayed for fifteen
 * minutes; single-use alone would let an unused challenge sit forever, which is a standing
 * capability to appeal at a moment of the holder's choosing.
 */
export class Challenges {
  readonly #open = new Map<string, Challenge>();

  /** A fresh challenge for one decision. The nonce is what makes two appeals distinguishable. */
  issue(decisionId: string, now: number, nonce = randomBytes(16).toString("hex")): Challenge {
    const c = { decisionId, nonce, expiresAt: now + CHALLENGE_TTL_MS };
    this.#open.set(nonce, c);
    return c;
  }

  /**
   * Accept an appeal, given something that can check the account's signature.
   *
   * `verify` is injected because checking a Starknet account signature is a `starknet_call` to
   * that account's own contract, and this server holds no chain connection — the same dependency
   * direction that keeps it free of keys.
   *
   * The challenge is consumed whether or not the signature verifies. A challenge that survived a
   * failed attempt would be an oracle: an attacker could grind signatures against it.
   */
  async accept(
    nonce: string,
    account: string,
    signature: readonly string[],
    now: number,
    verify: (account: string, digest: string, signature: readonly string[]) => Promise<boolean>,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const c = this.#open.get(nonce);
    this.#open.delete(nonce);
    if (!c) return { accepted: false, reason: "no such challenge, or it has been used" };
    if (now > c.expiresAt) return { accepted: false, reason: "the challenge has expired" };
    const ok = await verify(account, appealDigest(c), signature);
    return ok ? { accepted: true } : { accepted: false, reason: "the signature did not verify" };
  }

  /** Open challenges, for a test and for expiry sweeping. */
  outstanding(): Challenge[] {
    return [...this.#open.values()];
  }
}
