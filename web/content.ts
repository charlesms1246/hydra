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
 * yet, what it declines to claim, where the code is — and refuses to hold anything of the form
 * "your X is safe". The build checks that: `test/site.test.ts` fails if a sentence here makes a
 * privacy claim that the statement does not.
 *
 * ONE RULE ABOUT THE HERO, because it is the sentence that will be under pressure from every
 * future edit: **the most expensive real estate on the page is the place an over-claim goes.**
 * The hero holds the name and one sentence that names a mechanism. It does not hold a
 * guarantee, a number, a comparison or an install command. If you are here to add something to
 * it, add it to `what` instead.
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
    + "ships a screen listing what each party involved can see, generated from the same source "
    + "as the disclosure page on this site — so the product and this site cannot disagree.",
  ],

  /**
   * The landing page's pitch: three things that are true about the METHOD, not about the result.
   *
   * This is the section a marketing site exists to have, and it is the one most likely to grow a
   * sentence nobody measured. Note what none of these say: not that your messages are safe, not
   * that nobody can read them, not that it is better than anything. Each describes something the
   * project DOES, which is checkable, rather than something the reader GETS, which would be a
   * promise. That is the difference the forbidden-word check enforces, and writing to it is
   * easier than arguing with it.
   */
  why: [
    {
      label: "MEASURED",
      title: "The numbers come from tests, not from the writer",
      body: "Every guarantee on the disclosure page is derived from a value some test already "
        + "measures. When a protection is partial, the measurement is printed instead of a "
        + "reassurance — including the measurements that are unflattering, because those are the "
        + "ones a reader needs.",
    },
    {
      label: "GENERATED",
      title: "The site and the software cannot disagree",
      body: "The disclosure page is produced by the same function the client renders on its own "
        + "Disclosure screen. Nobody writes those sentences by hand, here or there, so there is "
        + "no version of this page that can drift ahead of what the code does.",
    },
    {
      label: "CITED",
      title: "Every line names the file that makes it true",
      body: "Each claim carries the path it came from, and a test fails if that path stops "
        + "resolving to a file in the repository. You are not asked to take any of it on trust; "
        + "you are asked to go and look.",
    },
  ],

  /** Who should not use it yet, stated before anyone asks. */
  notYet: [
    "This is a client for a devnet and a testnet. It is not ready for anyone whose safety "
    + "depends on it.",
    "Your root key is a plaintext file with mode 0600 and no passphrase, no keychain and no "
    + "hardware token. Anyone who reads that file reads every past and future conversation.",
    "That same file holds every message you have sent or read, as text. Anyone with the key "
    + "could fetch and open them anyway, so this does not widen who can read them — but the "
    + "words are on the disk without any work, and deleting them there is the only way not to "
    + "have them.",
    "One client per identity. Two copies of the same key file mint identical cover traffic, "
    + "which is how a storage server tells cover from messages. The client detects the common "
    + "case and says so; it cannot prevent it.",
    "The chain shows that you published a message and in what order. The timing defence hides "
    + "which stored object holds the text; it does not hide that you sent one.",
    "The pool's auditor holds an escrowed viewing key you did not choose and cannot replace. "
    + "It opens the pool, not your messages — see the composition finding in the repository.",
  ],

  /**
   * What this project declines to claim, as its own numbered section rather than as footer text.
   *
   * Burying a disclaimer is the same move as burying the auditor line, and a site that made one
   * of those moves would have no standing to complain about the other.
   *
   * Note these are comparative DIS-claims and statements about what does not exist. None of
   * them asserts a privacy property of Hydra, which is why they can be written by hand at all —
   * the forbidden-word check below still applies to every one of them.
   */
  doesNotClaim: [
    "Better metadata privacy than Signal. For ordinary encrypted chat it is not close: sealed "
    + "sender and private contact discovery beat anything that puts a pointer on a public "
    + "chain. This is a different product with different properties, and if what you want is a "
    + "messenger, use that one.",
    "A graphical client, a web client or a mobile client. None exists. The interface is a "
    + "terminal application, and the page you are reading is the only web surface this project "
    + "has.",
    "A hosted service. The vault has never bound to anything but localhost. There is nothing to "
    + "sign up for, nothing running that you could send a message through, and no server here "
    + "holding anyone's bytes.",
    "A company. There is no legal entity behind this, which is why you will find no address, no "
    + "contact, no terms and no warrant canary — a canary published by nobody, on behalf of "
    + "nothing, would be theatre. The licence holder is a placeholder on purpose.",
    "That publishing is easy. Making a message readable by strangers is an act you carry out "
    + "deliberately, one message at a time, and it permanently joins your messaging identity to "
    + "a Starknet address. It is never a mode you switch on and forget.",
  ],

  /**
   * The landing page's version of the warning — two lines, not six.
   *
   * The full list lives on the disclosure page. These two are here because a visitor deciding
   * whether to try this needs them before they get to a download, and a marketing page that
   * makes somebody find that out later is a marketing page that misled them.
   */
  beforeYouUse: [
    "This is a client for a devnet and a testnet. It is not ready for anyone whose safety "
    + "depends on it.",
    "Your root key is a plaintext file with no passphrase, and the pool's auditor holds a "
    + "viewing key you did not choose. What that means in detail is on the disclosure page, "
    + "which is generated rather than written.",
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
