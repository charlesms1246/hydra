/**
 * The privacy claims both front ends show a user, in one place.
 *
 * **STANDING RULE 3 SAYS PRIVACY CLAIMS ARE GENERATED, NEVER ASSERTED.** These were asserted —
 * twice, once in `cli` and once in `tui` — and they drifted, in both directions:
 *
 *   - The CLI was corrected to say that signing alone buys **no third-party proof**, and the TUI
 *     went on telling a signer *"anyone can prove it"*. A user acting on that is exactly the
 *     person this product exists for.
 *   - The CLI retracted *"the identity contract's data ABI is not verified anywhere in this repo"*
 *     after `0031` verified it and landed a record; the TUI still said it.
 *   - `0033` fixed the two-device cover collision and the TUI was updated; **the CLI still warned
 *     about identical cover.** Same defect, opposite direction — so this is not one careless file.
 *
 * It is the parallel-implementation disease applied to CLAIMS: the same defect as `crowdOf` versus
 * the shipped path, and as a duplicated `assertUsableId`, except the duplicated thing is a sentence
 * a person under pressure acts on. `statement.ts` already proves the right shape exists — one
 * generator, both readers render it, a test pins it.
 *
 * EACH ENTRY CARRIES THE DECISION THAT SETTLED ITS WORDING, because that is what makes a drifted
 * copy visible: a claim with a `because` can be checked against the thing it cites. A claim without
 * one is just a sentence, and a sentence is what drifted three times.
 */

/** One thing the product tells a user about what it does or does not guarantee. */
export type Warning = {
  /** Stable across renderings. The guard matches on this, never on prose. */
  readonly id: string;
  /** The decision or file that settled the wording. A claim with no source cannot be shown. */
  readonly because: string;
  /** Full text, for a surface with room. */
  readonly full: readonly string[];
  /** One line, for a status bar. Must not say more than `full` does. */
  readonly short: string;
};

/**
 * Signing, and the part that was false in one front end.
 *
 * The missing information at the point of decision is not "anchoring costs your anonymity" —
 * `hydra record` says that, afterwards. It is that **signing alone buys no third-party proof**, so
 * somebody who signs believing they have created evidence has created something only their
 * recipient can check. `attributionLabel` already draws exactly this line when READING.
 */
export const SIGNED: Warning = {
  id: "compose.signed",
  because: "decisions/0038 finding 3; attributionLabel draws the same line when reading",
  short: "SIGNED — only you could have written this; only THEY can check it until you anchor",
  full: [
    "SIGNED. Anyone holding your bundle can prove you wrote this, including people you never",
    "sent it to. That is what publishing means and it cannot be taken back.",
    "",
    "BUT NOT YET TO ANYONE ELSE. The key backing this signature came from your handshake with",
    "them and is not published, so today only THEY can check it — to a third party this proves",
    "nothing. Making it checkable by anyone means anchoring that key on chain under an account,",
    "which joins that account to this identity forever. If you are signing in order to prove",
    "authorship later, decide that now: the proof and the anonymity are the same choice, in",
    "opposite directions.",
  ],
};

/** Deniable, the other half of the same toggle. */
export const DENIABLE: Warning = {
  id: "compose.deniable",
  because: "handshake/src/authorship.ts — a key you both hold authenticates neither of you",
  short: "deniable — either of you could have written this",
  full: [
    "DENIABLE. The only thing authenticating this is a key you and they both hold, so either of",
    "you could have written it and neither can prove which.",
  ],
};

/**
 * Why the client does not write the record itself.
 *
 * WAS FALSE IN BOTH FRONT ENDS AT DIFFERENT TIMES. It told users the ABI was "not verified
 * anywhere in this repo" — `0031` verified it against the deployed class and landed a record on
 * Sepolia, so the client was reporting less confidence than it had, in a message whose whole job is
 * to help somebody decide.
 */
export const RECORD_NOT_WRITTEN: Warning = {
  id: "record.notWritten",
  because: "decisions/0031 verified the ABI and landed a record; 0027 for what the record binds",
  short: "this client does not write your record — which account pays is the link it creates",
  full: [
    "This client does not write it, and that is a choice rather than a limitation. The write",
    "costs gas from an account, and which account pays is exactly the link this record creates —",
    "so it is yours to make deliberately, with the wallet you meant, rather than something a",
    "client does while you read the warning. The ABI is verified against the deployed class and a",
    "record has been landed with it.",
  ],
};

/**
 * Two clients on one identity.
 *
 * `0033` FIXED THE COVER COLLISION and one front end was updated while the other went on warning
 * about identical cover. What is left is still worth saying, and it is different: both clients
 * spend the same invites and count the same sequences, and a message sent by the other one cannot
 * be read here because this client destroyed that key after using it.
 */
export const SECOND_CLIENT: Warning = {
  id: "identity.secondClient",
  because: "decisions/0033 — two devices salt decoys with the commitment, so cover is not identical",
  short: "another client is running on this identity — both are spending your invites",
  full: [
    "Messages in your own direction were not sent by this client. Another client is running on",
    "this identity. Its words cannot be read here — the key was used once and destroyed — and",
    "both clients are spending the same invites. Use one client per identity.",
  ],
};

/** Every warning both front ends must render identically. The guard iterates this. */
export const WARNINGS: readonly Warning[] =
  [SIGNED, DENIABLE, RECORD_NOT_WRITTEN, SECOND_CLIENT];
