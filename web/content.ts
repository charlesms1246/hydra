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

/**
 * The measured values, imported rather than typed.
 *
 * **Four numbers were hand-written into the pitch copy below and every one of them was right.**
 * That is the problem: right today, and asserted — if a default moves, the copy says something
 * false and nothing here would notice, because the forbidden-word check reads words and these
 * are numbers. An asserted measurement is the exact defect this project exists to prevent, and a
 * marketing page is where it gets written by somebody who was not in the room when it was taken.
 *
 * So the sentences interpolate. The prose around them is hand-written; the figures are the same
 * constants the disclosure statement quotes, and they cannot disagree.
 */
import { MEASURED } from "../hydra-dapp/packages/claims/src/statement.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;

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

  /**
   * PITCH. The persuasive page, and therefore the most dangerous one on the site.
   *
   * Everything here is hand-written except section 03, which renders the auditor claims from
   * `statement()`. So the forbidden-word check is the only thing standing between this copy and
   * an unmeasured claim, and it is load-bearing in a way it is not anywhere else.
   *
   * THE RULE THAT MAKES THIS WRITABLE: say what the project DOES, never what the reader GETS.
   * "The numbers come from tests" is checkable. "Your messages are safe" is a promise nobody
   * measured. Every sentence below is of the first kind, and if you cannot phrase an addition
   * that way it is because the thing you want to say has not been measured yet.
   */
  pitch: {
    lede: "Most privacy products ask you to believe a sentence somebody wrote. This one publishes "
      + "the measurements, including the ones that are not flattering.",
    problem: {
      label: "THE PROBLEM",
      title: "Content is the easy half",
      body: [
        "Encrypting a message is a solved problem. What survives encryption is the pattern: who "
        + "contacted whom, when, how often, from where. That pattern is what an adversary "
        + "actually works from, and it is the part most systems describe in the fewest words.",
        "Putting any of it on a public chain changes the timescale of the problem. A pattern held "
        + "by a company can be subpoenaed, leaked or discontinued. A pattern written to a chain "
        + "is readable by anyone, permanently, including by people who have not thought of a "
        + "reason to look yet.",
      ],
    },
    /** Verbs, no adjectives. Every line here describes a mechanism, not an outcome. */
    mechanism: {
      label: "THE MECHANISM",
      title: "What the system actually does",
      body: [
        "A message's pointer goes on Starknet's STRK20 privacy pool. Its contents go to a storage "
        + `server as a sealed blob, padded to one of ${MEASURED.buckets.length} fixed sizes. The `
        + `upload is delayed by up to ${MEASURED.jitterBlocks} blocks and mixed with `
        + `${MEASURED.coverRate} decoy uploads, and the decoys are fetched by the recipient `
        + "exactly the way real messages are.",
        "You choose, per message, whether it carries a signature. A signed message can be proved "
        + "to be yours and you cannot take that back. A deniable one carries no signature at all, "
        + "so either party could have written it and neither can prove which.",
      ],
    },
    /** A comparative dis-claim. It asserts nothing about Hydra, which is why it can be written. */
    worseAt: {
      label: "THE COMPARISON",
      title: "What this is worse at",
      body: [
        "For ordinary encrypted chat between people who already know each other, Signal is better "
        + "and it is not close. Sealed sender and private contact discovery beat anything that "
        + "puts a pointer on a public chain, and no amount of cover traffic changes that. This "
        + "project does not claim better metadata privacy than Signal and will not.",
        "If what you want is a messenger, use that one. What is here is a different shape: a "
        + "system whose disclosures are computed and published rather than described, built on a "
        + "chain because the thing being built needs one.",
      ],
    },
    /** The argument, made after the worst fact and the honest comparison rather than before. */
    why: {
      label: "THE ARGUMENT",
      title: "Why it might still be worth it",
      body: [
        "Every guarantee this project makes is derived from a value some test already measures, "
        + "and where a protection is partial the measurement is printed instead of a reassurance. "
        + "A message sent well apart from any other is identified about "
        + `${pct(MEASURED.isolatedMessageIdentified)} of the time. That is on the disclosure page `
        + "because it is true, not because it is good.",
        "The client renders the same statement this site does, from the same function, so the "
        + "product and the marketing cannot drift apart. Every line names the file that makes it "
        + "true, and a test fails if that path stops resolving. Nothing here asks for trust; it "
        + "asks you to go and check.",
      ],
    },
  },

  /**
   * INSTALL. Accurate today, which is awkward today.
   *
   * There is no published package: `@hydra-platform/cli` is `private: true` at version 0.0.0.
   * **Do not write an install line that will work later.** An install page describing a package
   * nobody can fetch is the most concrete false claim available to this site, and it is the one a
   * reader tests first — within about ten seconds, at a shell prompt, and the answer is a 404.
   *
   * If that reads badly, that is information about readiness rather than a copy problem.
   */
  install: {
    lede: "There is nothing to install yet. Both tools run from a checkout, and every command "
      + "on this page was run in a fresh clone rather than on the machine that wrote it.",
    /** Verified by running them. If you change these, run them. */
    steps: [
      {
        label: "01",
        title: "Clone it",
        commands: ["git clone https://github.com/charlesms1246/hydra", "cd hydra"],
        note: "Node 24 or later. Nothing else is needed on the machine.",
      },
      {
        label: "02",
        title: "The platform client",
        commands: [
          "npm install --prefix hydra-dapp/packages/channel",
          "cd hydra-dapp/packages/cli",
          "node src/cli.ts",
        ],
        note: "Run with no arguments and it prints every command. The install is in `channel` "
          + "rather than here because that is the package that declares dependencies — the "
          + "client itself has none, and skipping it fails on a missing `@scure/starknet` "
          + "rather than on anything informative. It is `private: true` at version 0.0.0: there "
          + "is no npm package, and `npm install hydra` fetches something that is not this. Its "
          + "manifest reserves the name `hydra` for whenever there is something to publish, "
          + "which is a note about the future rather than a command you can run.",
      },
      {
        label: "03",
        title: "The devtool",
        commands: ["cd devtool", "node packages/cli/src/cli.mjs help"],
        note: "No install needed for this one. A different tool for a different audience: it "
          + "stands up a local STRK20 stack and computes what a transaction discloses. Its "
          + "terminal interface needs `npm install --prefix packages/tui` as well. Publishable "
          + "as `hydra-devtool`, and not yet published.",
      },
    ],

    /**
     * The warnings live HERE rather than behind a link.
     *
     * Somebody on this page is closer to running this than a reader anywhere else on the site,
     * which makes it the right place for the readiness material and not the wrong one.
     */
    warnings: [
      "This runs against a devnet and a testnet. It is not ready for anyone whose safety depends "
      + "on it, and nothing about the install changes that.",
      "Your root key is written as a plaintext file with mode 0600 — no passphrase, no keychain, "
      + "no hardware token. Anyone who reads that file reads every past and future conversation, "
      + "and the same file holds every message you have sent or read, as text.",
      "Run one client per identity. Two copies of the same key file mint identical cover traffic, "
      + "which is how a storage server tells cover from messages.",
    ],
    /**
     * What stands behind this page, because it is the page that hands you a command to paste.
     *
     * Generated from `package.json` rather than typed, so it cannot describe a tree that is no
     * longer the tree.
     */
    supplyChain: "This site is built from four runtime dependencies and four type packages. It "
      + "ships no analytics and makes no third-party request. An install page is a supply-chain "
      + "surface — it is where somebody gets a command they will paste into a terminal — so what "
      + "stands behind it is listed rather than assumed.",
  },

  /** DEMO. Two tools, two pages, and a landing page that sends you to the right one. */
  demo: {
    lede: "Two tools, and they are for different people. Both run in a terminal; neither has a "
      + "graphical interface, and nothing here is hosted.",
    tools: [
      {
        id: "hydra",
        href: "/demo/hydra/",
        name: "hydra",
        who: "For someone who wants to send a message",
        body: "The platform client. A scriptable command line and a terminal interface over the "
          + "same code, so the two cannot disagree about anything that matters.",
      },
      {
        id: "hydra-dev",
        href: "/demo/hydra-dev/",
        name: "hydra-dev",
        who: "For someone building on STRK20",
        body: "The devtool. Stands up a local privacy stack — devnet, pool, discovery — and "
          + "computes what a given transaction actually discloses.",
      },
    ],
  },

  /** ABOUT. Short, and the place the disclosure page hangs off. */
  about: {
    lede: "A messaging client built on Starknet's STRK20 privacy pool, and the tooling that "
      + "measures what it leaks.",
    body: [
      "This project exists because of a habit rather than an idea. Privacy claims are generated "
      + "from the code that makes them true and never written by hand — in the product, on this "
      + "site, and in the same words in both places. Where a guarantee is partial it is published "
      + "with the measurement attached.",
      "It is not a company, and the section below says exactly what that means rather than "
      + "repeating it here. One statement of a thing is a statement; two is a slogan, and this "
      + "project has one place where each fact lives.",
    ],
  },

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
