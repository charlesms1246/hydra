/**
 * What the screen is allowed to know.
 *
 * `view.ts` draws a `View`. It does not draw a `State`, and the difference is the point: `State`
 * holds `seedHex` — the vault root itself — along with prekey privates and the body of every
 * queued upload. A renderer needs a fingerprint, a queue length and a handful of URLs. It was
 * taking the whole file and computing the rest itself.
 *
 * ## WHY THIS FILE EXISTS RATHER THAN `view.ts` IMPORTING `app.ts`
 *
 * I6: no pool viewing key and no vault content key may enter a browser context. `web/` renders
 * this interface live at the reader's width, which means `view.ts` and `screen.ts` are bundled
 * and served, and `web/scripts/module-graph.ts` fails the build if anything a page reaches lands
 * in `packages/identity/` or `packages/vault-client/`.
 *
 * Measured before the split: `view.ts` reached four forbidden modules across a graph of
 * forty-three — `identity/src/domains.ts` directly, and `vault-client/{blobs,buckets,errors}.ts`
 * through two one-use imports of `cli/src/commands.ts`. The remainder arrived through
 * `State`: `view.ts` → `app.ts` → `cli/src/state.ts` → `handshake/` → `identity`.
 *
 * ## THE WALKER FOLLOWS `import type`, AND THAT IS CHOSEN, NOT A BUG
 *
 * Every edge on that last chain is type-only and every one is erased by the bundler, so nothing
 * on it would have been served. `module-graph.ts` counts it anyway.
 *
 * **Do not "fix" that by teaching the walker to skip `import type`.** The walker
 * over-approximates: it follows edges the bundler erases, so its errors are false alarms and
 * never false passes. For an invariant like I6 that is the correct direction to be wrong in — the
 * cost of the over-approximation is this file, and the cost of the under-approximation is a key
 * in a bundle. `import { type X, foo }` also makes the distinction harder to draw correctly than
 * it looks.
 *
 * The precedent is `channel/src/constants.ts`, which exists for the same reason one layer down:
 * quoting a cover rate had dragged `vault-client` into the site, so the two values moved to a
 * module that imports nothing. This is that move, applied to a type.
 *
 * ## THE ONE PLACE `State` AND `View` MEET IS `viewOf` IN `app.ts`
 *
 * A narrow second description of part of `State` is a description that agrees until somebody
 * edits one of them. So nothing here is hand-maintained against `State`: `clientOf` takes a
 * `State` and returns a `Client`, and a field renamed or retyped over there is a type error at
 * that one function rather than a screen that quietly renders a stale shape.
 *
 * Field names deliberately match `State`'s. The projection is meant to read as a projection.
 */

import type { Nav } from "./nav.ts";

export type Page = "chats" | "connect" | "identity" | "record" | "disclosure" | "status";

export const PAGES: readonly { readonly id: Page; readonly label: string }[] = [
  { id: "chats", label: "Chats" },
  { id: "connect", label: "Connect" },
  { id: "identity", label: "Identity" },
  /**
   * Publishing is its own page because it is its own act, with a cost none of the others have.
   *
   * It went on Identity first and pushed the seed-in-the-clear disclosure off the bottom of the
   * frame — `tui-conversation.test.ts` caught it. A page too full to show what it costs is the
   * failure this interface is built around, so the answer is another page rather than shorter
   * warnings.
   */
  { id: "record", label: "Record" },
  { id: "disclosure", label: "Disclosure" },
  { id: "status", label: "Status" },
];

/**
 * The fields each page owns.
 *
 * `setup` is not in `PAGES` because it is not a destination: it is what the interface is when
 * there is no identity yet, and it goes away for good once there is one.
 */
export const FIELDS: Record<Page | "setup", readonly {
  readonly key: string;
  readonly label: string;
  /**
   * Not needed to create an identity — needed before the first message.
   *
   * **SEVEN FIELDS WERE PRESENTED AS PREREQUISITES OF EXISTING AND NONE OF THEM IS ONE.**
   * `commands.ts` `init` defaults every field, and `ensureFromBlock` returns early when there is
   * no contract, so first run makes no network request at all. The wall in front of a new user was
   * the prerequisites of SENDING, collected at the one moment not one of them is used.
   *
   * Marked rather than removed, and this is the deliberately cheap half of that finding. Deferring
   * a field moves its failure later — a blank `account` fails inside `sncast` at the first send —
   * and a defer is only honest if each field is then ASKED for at its moment with a named remedy.
   * That is real work and it is recorded, not built. Saying which half is which costs nothing and
   * is true today.
   *
   * On the entry rather than in a second list in `view.ts`, for the reason `initialFields` exists:
   * two lists that must agree are two lists, and nothing makes them.
   */
  readonly later?: true;
}[]> = {
  setup: [
    { key: "vault", label: "vault URL" },
    { key: "rpc", label: "chain RPC" },
    { key: "contract", label: "contract address" },
    { key: "accountsFile", label: "sncast accounts file", later: true },
    { key: "account", label: "account name", later: true },
    { key: "network", label: "network (blank for a devnet URL)", later: true },
    { key: "invites", label: "upload invites, comma separated", later: true },
  ],
  chats: [{ key: "compose", label: "message" }],
  connect: [
    { key: "peerName", label: "what to call them" },
    { key: "peerBundle", label: "path to their bundle file" },
    /**
     * Their Starknet address, as an alternative to having their file at all.
     *
     * `hydra lookup` reads a published record off chain and gets a bundle from it, which its own
     * comment in `cli.ts` calls "the step that had no path": a source could otherwise only reach
     * an organisation they already had a relationship with, which is a prerequisite sitting in
     * front of the surface and undoing its premise. The TUI did not have it.
     */
    { key: "peerAddress", label: "or their Starknet address, if they published one" },
    { key: "exportPath", label: "write my bundle to" },
  ],
  identity: [],
  record: [
    { key: "myAddress", label: "my Starknet address, for a published record" },
    { key: "recordPath", label: "record felts file" },
    { key: "anchorName", label: "whose record to check" },
    { key: "anchorAddress", label: "their Starknet address" },
  ],
  disclosure: [],
  status: [],
};

/**
 * The identity summary, derived once on the Node side.
 *
 * It used to be computed here, in the view, memoised in a module-level variable keyed on
 * `${state.seedHex}:…`. **That put the raw seed hex in a module-scope variable in the
 * presentation layer** — contained in a Node process, and in a browser bundle the one thing I6
 * exists to forbid, arriving through a cache key rather than through any field a reader would
 * think to check. A JavaScript string cannot be zeroed, so it lived until the process did.
 *
 * The memo now lives in `app.ts` and is a `WeakMap` on the state object. **Not `epoch` and
 * `oneTimeLeft`**, which was the first replacement and which is unique only by accident:
 * `effects.ts` `init()` can mint a fresh identity in-process, and every fresh state is epoch 0
 * with the same one-time count, so two identities collide on one key. That is unreachable today
 * only because `app.ts` sends you to `setup` solely when there was no state at startup — a
 * guarantee two files away that nobody editing a cache would think to check. Keying on the object
 * cannot collide however the reducer grows, and **showing the wrong fingerprint is worse than any
 * stale-cache bug**: it is the value users read aloud to each other to check who they are talking
 * to.
 */
export type Identity = {
  readonly fingerprint: string;
  readonly epoch: number;
  readonly oneTimeLeft: number;
};

/**
 * One message, with its attribution already decided.
 *
 * I7 says content the product cannot prove may never be displayed under an author's name, and
 * `attributionLabel` in `cli/src/commands.ts` is the one function that decides both the name and
 * the mark. That function stays where it is; the view receives its answer. The view could not
 * call it anyway — `commands.ts` is the choke point into `vault-client`.
 */
export type Shown = {
  readonly text: string;
  readonly mine: boolean;
  readonly attribution: "signed" | "unverifiable";
  readonly who: { readonly mark: string; readonly name: string };
};

/** One queued upload, as the status page needs it — no body, no delete capability. */
export type Queued = {
  readonly channel: string;
  readonly uploadAt: number;
  readonly real: boolean;
};

/** What the crowd figure says. `channel/src/crowd.ts` `describe` turns it into sentences. */
export type Linkability = { readonly known: boolean; readonly crowd: number };

export type LogLine = { readonly at: number; readonly text: string; readonly tone: "info" | "warn" | "bad" };

/**
 * The client's data, narrowed to what the screen draws.
 *
 * Built by `clientOf` in `app.ts`. Every field here is either shown to the user or decides
 * whether something is shown; nothing here is key material, and `seedHex` and `prekeys` are
 * absent because the only thing that read them was the fingerprint derivation that left.
 */
export type Client = {
  readonly identity: Identity | null;
  readonly lockedAtRest?: boolean;
  readonly channels: Readonly<Record<string, { readonly anchor: string | null }>>;
  readonly pending: readonly Queued[];
  readonly vaultUrl: string;
  readonly rpcUrl: string;
  readonly contract: string;
  readonly fromBlock: number;
  readonly controlUrl?: string;
  readonly poolAccount?: string;
  /** The count, not the invites. The screen only ever said how many were left. */
  readonly invites: number;
};

/** Everything `render` takes. `app.ts` `viewOf` is the only thing that builds one. */
export type View = {
  readonly page: Page | "setup";
  readonly client: Client | null;
  /**
   * Where the state file is, as text.
   *
   * On the `View` and not on the `Client`, because the setup page names it precisely when there
   * is no client yet — "Enter writes …, that file holds your root key in the clear" is the last
   * thing shown before an identity exists, and hanging it off the client would blank it exactly
   * there.
   *
   * Read from `cli/src/state.ts` `STATE_FILE` by `viewOf`, so `HYDRA_HOME` at module load still
   * governs it. That is deliberate: `web/scripts/capture-tui.ts` sets it before importing, and its
   * leak assertions caught the build machine's home directory going onto a public page the first
   * time this interface was captured.
   */
  readonly statePath: string;
  readonly typing: boolean;
  readonly field: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly channel: number;
  readonly scroll: number;
  readonly transcript: Readonly<Record<string, readonly Shown[]>>;
  /** Channels where something else is sending as you. `commands.ts` `foreignSends`. */
  readonly foreign: Readonly<Record<string, number>>;
  /** The crowd the selected channel sits in, or the zero case when nothing is selected. */
  readonly linked: Linkability;
  readonly log: readonly LogLine[];
  readonly busy: string | null;
  /** No `effect`: which button was pressed is the reducer's business, not the screen's. */
  readonly confirm: { readonly question: string; readonly label: string } | null;
  readonly cite: boolean;
  /**
   * Whether the help overlay is up.
   *
   * A flag and not a seventh `Page`, for two reasons that are both about this interface rather
   * than about taste. The nav bar already spends 79 columns on six tabs, so a seventh does not
   * fit at the width most terminals open at — the label would be truncated on the page whose job
   * is telling you what exists. And help is the one screen you want to leave by returning to
   * exactly where you were, which a page cannot do without remembering where you came from.
   *
   * `confirm` is the same shape for the same reason and this follows it: the body is taken over,
   * the page underneath is untouched, and one keystroke gives it back.
   */
  readonly help: boolean;
  /** How far help is scrolled. Its own offset so reading it does not move the page underneath. */
  readonly helpScroll: number;
  readonly signing: boolean;
  readonly now: number;
};

export const channelNames = (v: View): string[] => Object.keys(v.client?.channels ?? {}).sort();

export const selected = (v: View): string | null => channelNames(v)[v.channel] ?? null;

export const due = (v: View): number =>
  (v.client?.pending ?? []).filter((p) => p.uploadAt <= v.now).length;

/**
 * `View` and `Model` both satisfy `Nav`, asserted here rather than discovered at a call site.
 *
 * `nav.ts` holds the cursor moves as `<T extends Nav>` so that `app.ts` can call them on a
 * `Model` and the website can call them on a `View` — one implementation, two callers. A
 * `T extends Nav` constraint fails at whichever call site the compiler reaches first, which is a
 * confusing place to learn that somebody renamed a field. This fails here, with this comment.
 *
 * If it goes red: a field `nav.ts` moves has been renamed or retyped on one of the two, and the
 * question to answer is whether the other should follow — not whether to widen `Nav`.
 *
 * ⚠ ONLY `View` IS ASSERTED HERE. The matching one for `Model` is at the bottom of `app.ts`, and
 * that split is not tidiness — it is I6. Importing `Model` into this file to assert it here costs
 * nothing at runtime and `tsc` accepts it, but `module-graph.ts` FOLLOWS TYPE-ONLY EDGES, so it
 * put `app.ts` back in `view.ts`'s closure: **10 files and 0 forbidden became 46 and 4.** Measured,
 * because I wrote it that way first. The assertion belongs where the type already lives.
 */
export type Satisfies<T extends Nav> = T;
type ViewIsNav = Satisfies<View>;
export type { ViewIsNav };
