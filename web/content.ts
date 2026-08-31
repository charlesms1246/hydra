/**
 * The words on the marketing site that are NOT generated, and the rule about which those are.
 *
 * Every privacy claim on this site comes from `hydra-dapp/packages/claims/src/statement.ts` —
 * the same function the client renders on its Disclosure page — and none of it is written here.
 * That is the project's standing rule applied to the place it is most often broken: a marketing
 * page is where an over-claim goes to be written by somebody who was not in the room when the
 * number was measured, and "we cannot see your messages" is one sentence away from every
 * honest description of this system.
 *
 * So this file holds what a generator cannot know — what the thing is for, who it is not for
 * yet, where the code is — and refuses to hold anything of the form "your X is safe". The build
 * checks that: `test/site.test.ts` fails if a sentence here makes a privacy claim that the
 * statement does not.
 */

export const SITE = {
  name: "Hydra",
  tagline: "Private messaging on Starknet, where what leaks is computed rather than promised.",

  /**
   * What it is. No adjectives that are really claims — "secure", "anonymous" and "private" as a
   * property of the product rather than of a named mechanism are exactly the words the check
   * below refuses.
   */
  what: [
    "Hydra is a messaging client built on Starknet's STRK20 privacy pool. A message's pointer "
    + "goes on chain; its contents go to a storage server that holds bytes it cannot read.",
    "Every guarantee it makes is derived from code that a test already measures. The client "
    + "ships a page listing what each party involved can see, generated from the same source as "
    + "the section below — so the product and this page cannot disagree.",
  ],

  /** Who should not use it yet, stated before anyone asks. */
  notYet: [
    "This is a client for a devnet and a testnet. It is not ready for anyone whose safety "
    + "depends on it.",
    "Your root key is a plaintext file with mode 0600 and no passphrase, no keychain and no "
    + "hardware token. Anyone who reads that file reads every past and future conversation.",
    "The chain shows that you published a message and in what order. The timing defence hides "
    + "which stored object holds the text; it does not hide that you sent one.",
    "The pool's auditor holds an escrowed viewing key you did not choose and cannot replace. "
    + "It opens the pool, not your messages — see the composition finding in the repository.",
  ],

  links: [
    { label: "Source", href: "https://github.com/charlesms1246/hydra" },
    { label: "The devtool", href: "https://github.com/charlesms1246/hydra/tree/main/devtool" },
  ],

  /**
   * Words this site may not use about itself.
   *
   * Not a style guide — a check. Each of these is a claim with no number behind it, and the
   * statement never produces one. `test/site.test.ts` fails the build if any appears in the
   * rendered page outside a generated block.
   */
  forbidden: [
    "anonymous", "untraceable", "unbreakable", "military-grade", "zero-knowledge proof of",
    "we cannot see", "nobody can see", "completely private", "fully private", "100%",
  ],
} as const;
