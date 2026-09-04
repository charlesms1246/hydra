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
  /**
   * Which packages must render it.
   *
   * NOT EVERY CLAIM BELONGS TO EVERY SURFACE. The compose claims are shown by both clients and
   * drifting between them is the defect this module exists for; the vault's TLS claim is shown by
   * the vault alone. A guard that demanded all of them everywhere would be satisfied only by
   * putting a server's banner in a chat client, which is how a rule stops being followed.
   */
  readonly surfaces: readonly string[];
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
  surfaces: ["cli", "tui"],
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
  surfaces: ["cli", "tui"],
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
  surfaces: ["cli", "tui"],
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
  surfaces: ["cli", "tui"],
  because: "decisions/0033 — two devices salt decoys with the commitment, so cover is not identical",
  short: "another client is running on this identity — both are spending your invites",
  full: [
    "Messages in your own direction were not sent by this client. Another client is running on",
    "this identity. Its words cannot be read here — the key was used once and destroyed — and",
    "both clients are spending the same invites. Use one client per identity.",
  ],
};

/**
 * What terminating TLS here does and does not buy.
 *
 * WAS ASSERTED IN THE VAULT'S STARTUP BANNER, in hand-written prose: *"session tickets are
 * disabled, so every connection is a full handshake and two connections cannot be linked to one
 * client"*. It is very likely true — `decisions/0021` disabled resumption deliberately and
 * `tls.resumption` sits on the not-observable table — and standing rule 3 does not have an
 * exception for claims that happen to hold. A privacy claim is generated or it is not made.
 *
 * The qualification is the part hand-written prose kept dropping: **resumption is one linking
 * mechanism among several.** An address links connections whatever TLS does, and this server sees
 * one on every request.
 */
export const TLS_TERMINATION: Warning = {
  id: "vault.tlsTermination",
  surfaces: ["vault-server"],
  because: "decisions/0021 disabled session tickets; tls.resumption on the not-observable table",
  short: "TLS terminates here; session tickets are off, so resumption does not link connections",
  full: [
    "TLS terminates HERE rather than behind a proxy. Both choices disclose SNI, cipher suite and",
    "ALPN to somebody; this one discloses them to the party already describing what they can see.",
    "",
    "Session tickets are disabled, so every connection is a full handshake and resumption gives",
    "no way to join two of them. That is one linking mechanism closed, not linkage in general —",
    "the address is on every request, and this server sees it.",
  ],
};

/**
 * The root key on disk, in the two states it can be in — `decisions/0040`.
 *
 * TWO CLAIMS RATHER THAN ONE WITH A CONDITION, because the surfaces render whichever is true and a
 * claim that changes its own meaning is one nobody can check. The old text was hand-written in
 * three places and said the key is "in the clear" unconditionally; the moment encryption shipped
 * that would have been false in all three, and a test was already defending it.
 */
export const KEY_IN_CLEAR: Warning = {
  id: "identity.keyInClear",
  surfaces: ["cli", "tui"],
  because: "decisions/0040 — the state file is plaintext until `hydra lock` is run",
  short: "your root key is on disk in the clear — `hydra lock` encrypts it",
  full: [
    "Your root key is in the state file, in the clear, mode 0600 and nothing else. No passphrase,",
    "no keychain. Anyone who reads that file reads every past and future conversation, because the",
    "seed regenerates every channel key ever agreed.",
    "",
    "`hydra lock` encrypts it with a passphrase. Read what that does and does not buy before you",
    "rely on it — it protects a disk, not a running machine.",
  ],
};

/**
 * What locking actually buys, stated as the three cases rather than as a feeling.
 *
 * The middle row is the one people get wrong, and it is the reason this is generated: a claim that
 * says "encrypted" without saying "in memory while it runs" is read as covering the case it does
 * not cover.
 */
export const KEY_LOCKED: Warning = {
  id: "identity.keyLocked",
  surfaces: ["cli", "tui"],
  because: "decisions/0040 §1 — scrypt + AES-256-GCM over the whole state file",
  short: "your root key is encrypted at rest — this protects a seized disk, not a running machine",
  full: [
    "Your state file is encrypted with your passphrase: the root key and every message in it.",
    "",
    "WHAT THAT BUYS, EXACTLY:",
    "  device seized powered off, or imaged   — yes, this is the case it is for",
    "  device seized while running            — NO, the key is in memory once you have unlocked",
    "  device seized unlocked                 — no, and neither does anything else here",
    "",
    "There is no recovery. The passphrase is the only way in — a path that did not need it would",
    "be a second way in, and one held anywhere else would be escrow. A phrase you wrote down is a",
    "second copy of the secret, not a backup.",
  ],
};

/** Every warning both front ends must render identically. The guard iterates this. */
export const WARNINGS: readonly Warning[] =
  [SIGNED, DENIABLE, RECORD_NOT_WRITTEN, SECOND_CLIENT, TLS_TERMINATION,
    KEY_IN_CLEAR, KEY_LOCKED];
