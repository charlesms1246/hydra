/**
 * The interface as a value: a model, a reducer, and a list of effects.
 *
 * Nothing in this file touches a terminal, a socket, a chain or a disk. `update` takes the model
 * and one event and returns the next model plus what should be DONE about it, described rather
 * than performed. `main.ts` performs it.
 *
 * That split is the same one `commands.ts` and `cli.ts` already make, and it is here for the
 * same reason: it is what lets the whole interface be driven in a test with no TTY, no vault and
 * no node — `adversary/test/tui-conversation.test.ts` types into it and reads frames back. An interface that can
 * only be checked by a human looking at it is an interface whose regressions ship.
 *
 * ONE EFFECT AT A TIME, and that is a correctness rule rather than a nicety. Every effect
 * mutates `State` and then persists it; two in flight would interleave two writes to one file
 * and the loser's channel, sequence number or spent invite would silently vanish. `busy` is
 * checked before any effect is emitted, and the flush ticker skips rather than queues.
 *
 * MODAL, deliberately. In command mode letters act; in typing mode they type. The alternative
 * — a chat box that always has focus, with pages on control chords — puts every navigation key
 * one modifier away in the interface people spend all their time in, and makes `q` unbindable.
 */

import { SIGNED, DENIABLE } from "../../claims/src/warnings.ts";
import type { Key } from "./keys.ts";
import type { State, ReceivedMessage as Received } from "../../cli/src/state.ts";
import { PAGES, FIELDS } from "./model.ts";
import type { Client, Identity, LogLine, Page, Shown, View } from "./model.ts";
import { attributionLabel, linkabilityOf } from "../../cli/src/commands.ts";
import { bundleFrom, oneTimeRemaining } from "../../handshake/src/prekeys.ts";
import { derive, rootSeed, entropyFrom, fromStoredSeed, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { STATE_FILE } from "../../cli/src/state.ts";

/**
 * `Page`, `PAGES` and `FIELDS` live in `model.ts` and are re-exported here.
 *
 * They are presentation data, so they belong on the side of the split `view.ts` is allowed to
 * import — see that file's header for why the line is where it is. Re-exported because the tests
 * and the reducer have always taken them from here and moving them is not what this change is
 * about.
 */
export { PAGES, FIELDS };
export type { Page, LogLine };

/** The fields that start with something in them. Everything else in {@link FIELDS} starts empty. */
const FIELD_DEFAULTS: Readonly<Record<string, string>> = {
  vault: "http://127.0.0.1:8080",
  rpc: "http://127.0.0.1:5050",
  exportPath: "bundle.json",
};

/**
 * Every field in {@link FIELDS}, empty unless it has a default.
 *
 * **IT WAS A HAND-WRITTEN OBJECT AND IT HAD DRIFTED.** `FIELDS.record` declares four keys and the
 * literal listed none of them, so `m.fields.myAddress` was `undefined` — and the typing handler
 * appends, `m.fields[key] + k.value`. Typing a Starknet address into the Record page produced
 * `undefined0x2993…`, on screen, in the field, for every user.
 *
 * **WHAT IT DID NOT DO, corrected from an earlier version of this comment that said it did:** it
 * did not risk anything on chain. `A` writes felts to a LOCAL FILE and nothing on that page ever
 * reaches a node — the `record` effect says so itself, and the confirm's warning is conditional
 * ("PUBLISHED, that link is permanent"), with the success text closing it: publishing is "a
 * separate act this client does not perform". Two of the four poisoned fields would have thrown in
 * `BigInt`; the other two wrote to a garbage filename or failed a channel lookup. All bounded, all
 * loud. **A page unusable from the first keystroke is worth reporting without the word "chain",
 * and reaching for it was the failure this project exists to avoid.**
 *
 * Found by driving the real interface through a pty, not by reading either list: **both lists were
 * individually correct and nothing compares them.** That is the same shape as the fix that reached
 * the CLI and not the TUI — two places that must agree, no third thing asserting they do.
 *
 * Derived rather than checked, because a test that compares two lists still leaves two lists. A
 * page that adds a field now gets it initialised by construction.
 */
const initialFields = (): Record<string, string> =>
  Object.fromEntries(Object.values(FIELDS).flat()
    .map((f) => [f.key, FIELD_DEFAULTS[f.key] ?? ""]));

/** What `main.ts` is being asked to do. Descriptions, not calls. */
export type Effect =
  | { readonly t: "init"; readonly fields: Readonly<Record<string, string>> }
  | {
    readonly t: "send";
    readonly channel: string;
    readonly text: string;
    /** Signed and recorded, or deniable. No default anywhere in the stack. */
    readonly signed: boolean;
  }
  | { readonly t: "read"; readonly channel: string }
  | { readonly t: "flush" }
  | { readonly t: "collect" }
  | { readonly t: "rotate" }
  | { readonly t: "invite"; readonly name: string; readonly path: string }
  | { readonly t: "export"; readonly path: string }
  /** Write the felts to publish. Writing them is not publishing them — see `identity` in `view.ts`. */
  | { readonly t: "record"; readonly address: string; readonly path: string }
  | {
    readonly t: "anchor";
    readonly channel: string;
    readonly address: string;
    readonly path: string;
  }
  | { readonly t: "forget"; readonly channel: string };

export type Event =
  | { readonly t: "key"; readonly key: Key }
  | { readonly t: "tick"; readonly now: number }
  | { readonly t: "resize" }
  | {
    readonly t: "ok";
    readonly text: string;
    readonly state?: State;
    /** A channel whose transcript is no longer true and must be dropped from the screen. */
    readonly clear?: string;
  }
  | {
    readonly t: "messages";
    readonly channel: string;
    readonly messages: readonly Received[];
    /** Messages in this client's own direction that this client did not send. See `commands.ts`. */
    readonly foreign: number;
  }
  | { readonly t: "error"; readonly text: string };

export type Model = {
  readonly page: Page | "setup";
  readonly state: State | null;
  readonly typing: boolean;
  readonly field: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly channel: number;
  readonly scroll: number;
  readonly transcript: Readonly<Record<string, readonly Received[]>>;
  /** Channels where something else is sending as you. `commands.ts` `foreignSends`. */
  readonly foreign: Readonly<Record<string, number>>;
  readonly log: readonly LogLine[];
  readonly busy: string | null;
  readonly confirm: { readonly question: string; readonly label: string; readonly effect: Effect } | null;
  readonly cite: boolean;
  /**
   * Whether the next message will be signed.
   *
   * On the model rather than decided at the keystroke, because it has to be VISIBLE before Enter
   * is pressed. A user who cannot see which of the two things they are about to do has neither
   * deniability nor attribution — they have whatever the default was.
   */
  readonly signing: boolean;
  readonly now: number;
  readonly quit: boolean;
};

export const channelNames = (m: Model): string[] => Object.keys(m.state?.channels ?? {}).sort();

export const selected = (m: Model): string | null => channelNames(m)[m.channel] ?? null;

export function start(state: State | null, now: number): Model {
  return {
    page: state ? "chats" : "setup",
    state,
    typing: !state,
    field: 0,
    fields: initialFields(),
    channel: 0,
    scroll: 0,
    transcript: {},
    foreign: {},
    log: [],
    busy: null,
    confirm: null,
    cite: false,
    signing: false,
    now,
    quit: false,
  };
}

const say = (m: Model, text: string, tone: LogLine["tone"] = "info"): Model =>
  ({ ...m, log: [...m.log, { at: m.now, text, tone }].slice(-200) });

type Step = { readonly model: Model; readonly effects: readonly Effect[] };

const just = (model: Model): Step => ({ model, effects: [] });

/** Emit an effect, or say why not. Single-flight — see the header. */
function run(m: Model, label: string, effect: Effect): Step {
  if (m.busy) return just(say(m, `${m.busy} is still running — one at a time`, "warn"));
  return { model: { ...m, busy: label }, effects: [effect] };
}

// ---------------------------------------------------------------------------
// Uploads that are due
// ---------------------------------------------------------------------------

/**
 * Whether there is anything to flush.
 *
 * This is why the client is a resident process rather than a command, and it closes a defect
 * the CLI could not: `commands.ts` `flush` uploads what is due, and a human running it by hand
 * uploads a message and all of its cover in one burst at whatever moment they remember to. A
 * burst is a message. Ticking here means each object goes up at the time the scheduler picked
 * for it, to the second.
 *
 * What it still does NOT fix is the lead. Cover for a message is scheduled to begin BEFORE that
 * message's own chain event, and the client only learns the message exists when the user sends
 * it, so a decoy whose slot is already past goes up now rather than then. Measured in
 * `adversary/test/resident-flush.test.ts`. Fixing that needs cover that does not wait for a message.
 */
export const due = (m: Model): number =>
  (m.state?.pending ?? []).filter((p) => p.uploadAt <= m.now).length;

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export function update(m: Model, event: Event): Step {
  switch (event.t) {
    case "tick": {
      const next = { ...m, now: event.now };
      if (next.busy || !next.state || due(next) === 0) return just(next);
      return run(next, "flush", { t: "flush" });
    }
    case "resize":
      return just(m);
    case "ok": {
      const next = { ...m, busy: null, state: event.state ?? m.state };
      // First run ends the moment there is an identity, and only then. Leaving the setup page
      // on the keypress rather than on the result would show an empty Chats page to someone
      // whose `init` had just failed.
      const landed = next.page === "setup" && next.state
        ? { ...next, page: "chats" as const, field: 0, typing: false }
        : next;
      // A transcript the state no longer holds must leave the screen in the same step. Showing
      // messages that have been deleted is the one thing a delete must not do.
      const cleared = event.clear
        ? { ...landed, transcript: { ...landed.transcript, [event.clear]: [] } }
        : landed;
      return just(say(cleared, event.text, "info"));
    }
    case "messages": {
      const next = {
        ...m,
        busy: null,
        transcript: { ...m.transcript, [event.channel]: event.messages },
        foreign: { ...m.foreign, [event.channel]: event.foreign },
      };
      // The warning goes in the log as well as on the page, because it is the kind of thing a
      // user needs told once loudly rather than shown quietly forever.
      return just(say(next, event.foreign
        ? `${event.channel}: ${event.messages.length} message(s) — ${event.foreign} sent as you `
          + "by another client"
        : `${event.channel}: ${event.messages.length} message(s)`,
      event.foreign ? "warn" : "info"));
    }
    case "error":
      return just(say({ ...m, busy: null }, event.text, "bad"));
    case "key":
      return key(m, event.key);
  }
}

function key(m: Model, k: Key): Step {
  if (m.confirm) {
    if (k.t === "char" && k.value.toLowerCase() === "y") {
      const { label, effect } = m.confirm;
      return run({ ...m, confirm: null }, label, effect);
    }
    if (k.t === "char" || k.t === "escape") return just(say({ ...m, confirm: null }, "cancelled"));
    return just(m);
  }
  if (k.t === "ctrl" && k.value === "c") return just({ ...m, quit: true });
  if (m.typing) return typed(m, k);
  return command(m, k);
}

const fieldsOf = (m: Model) => FIELDS[m.page];

function typed(m: Model, k: Key): Step {
  const fields = fieldsOf(m);
  const current = fields[m.field];
  if (!current) return just({ ...m, typing: false });
  switch (k.t) {
    case "escape":
      return just({ ...m, typing: false });
    case "tab":
    case "down":
      return just({ ...m, field: (m.field + 1) % fields.length });
    case "shift-tab":
    case "up":
      return just({ ...m, field: (m.field + fields.length - 1) % fields.length });
    case "backspace":
      return just({ ...m, fields: { ...m.fields, [current.key]: m.fields[current.key].slice(0, -1) } });
    case "enter":
      return submit(m);
    case "char":
      return just({ ...m, fields: { ...m.fields, [current.key]: m.fields[current.key] + k.value } });
    default:
      return just(m);
  }
}

function command(m: Model, k: Key): Step {
  const fields = fieldsOf(m);
  if (k.t === "tab") return just({ ...m, field: fields.length ? (m.field + 1) % fields.length : 0 });
  if (k.t === "shift-tab") {
    return just({ ...m, field: fields.length ? (m.field + fields.length - 1) % fields.length : 0 });
  }
  if (k.t === "enter") return submit(m);
  if (k.t === "up" || (k.t === "char" && k.value === "k")) return move(m, -1);
  if (k.t === "down" || (k.t === "char" && k.value === "j")) return move(m, 1);
  if (k.t === "page-up") return move(m, -10);
  if (k.t === "page-down") return move(m, 10);

  if (k.t === "char") {
    const digit = "123456".indexOf(k.value);
    if (digit >= 0 && m.page !== "setup") return just(go(m, PAGES[digit].id));
    if (k.value === "]" && m.page !== "setup") return just(cycle(m, 1));
    if (k.value === "[" && m.page !== "setup") return just(cycle(m, -1));
    if (k.value === "i" && fields.length) return just({ ...m, typing: true });
    if (k.value === "q") return just({ ...m, quit: true });
    return action(m, k.value);
  }
  return just(m);
}

const go = (m: Model, page: Page): Model => ({ ...m, page, field: 0, scroll: 0, typing: false });

function cycle(m: Model, by: number): Model {
  const i = PAGES.findIndex((p) => p.id === m.page);
  return go(m, PAGES[(i + by + PAGES.length) % PAGES.length].id);
}

/** j/k means "next channel" on the page with a channel list, and "scroll" everywhere else. */
function move(m: Model, by: number): Step {
  if (m.page === "chats") {
    const n = channelNames(m).length;
    if (n === 0) return just(m);
    return just({ ...m, channel: Math.min(n - 1, Math.max(0, m.channel + by)), scroll: 0 });
  }
  return just({ ...m, scroll: Math.max(0, m.scroll + by) });
}

/** Enter: the page's primary action. One per page, and only one. */
function submit(m: Model): Step {
  switch (m.page) {
    case "setup":
      if (!m.fields.contract) return just(say(m, "a contract address is required", "warn"));
      return run(m, "init", { t: "init", fields: m.fields });
    case "chats": {
      const channel = selected(m);
      if (!channel) return just(say(m, "no channels yet — open one on Connect", "warn"));
      if (!m.fields.compose.trim()) return just(say(m, "nothing to send", "warn"));
      return run({ ...m, fields: { ...m.fields, compose: "" }, typing: false },
        m.signing ? "publish" : "send",
        { t: "send", channel, text: m.fields.compose, signed: m.signing });
    }
    case "connect": {
      if (!m.fields.peerName || !m.fields.peerBundle) {
        return just(say(m, "a name and a bundle file, then Enter", "warn"));
      }
      return run({ ...m, typing: false },
        "invite", { t: "invite", name: m.fields.peerName, path: m.fields.peerBundle });
    }
    default:
      return just(m);
  }
}

/** Page-specific letters. Anything not listed falls through and does nothing. */
function action(m: Model, ch: string): Step {
  if (ch === "f") return run(m, "flush", { t: "flush" });
  switch (m.page) {
    case "chats": {
      const channel = selected(m);
      if (ch === "r" && channel) return run(m, "read", { t: "read", channel });
      if (ch === "s") {
        // FROM `claims/src/warnings.ts` — this said "anyone can prove it", which is false and
        // which the CLI had already been corrected out of. One source, both readers.
        return just(say({ ...m, signing: !m.signing },
          (m.signing ? DENIABLE : SIGNED).short, "warn"));
      }
      if (ch === "D" && channel) {
        return just({
          ...m,
          confirm: {
            // What it destroys, not what it tidies. This is the one delete in the product that
            // is real — the keys are already gone, so the transcript is the only copy here.
            question: `delete every message in ${channel} from this device? their keys were `
              + "destroyed when they were read, so nothing here can fetch them again. the "
              + "ciphertext stays in the vault until it expires and the other end keeps its own "
              + "copy.",
            label: "forget",
            effect: { t: "forget", channel },
          },
        });
      }
      return just(m);
    }
    case "connect":
      if (ch === "c") return run(m, "collect", { t: "collect" });
      if (ch === "e") return run(m, "export", { t: "export", path: m.fields.exportPath || "bundle.json" });
      return just(m);
    case "record":
      if (ch === "A") {
        if (!m.fields.myAddress) return just(say(m, "an address first — the record commits to it", "warn"));
        return just({
          ...m,
          confirm: {
            // The one confirm in the product about a DISCLOSURE rather than a destruction, and
            // it is asked here because this is the moment the user decides. `linkage.ts`
            // computes the join; this sentence is what it looks like to a person.
            question: `write the record that names your messaging identity and ${m.fields.myAddress} `
              + "together? published, that link is permanent and readable by everybody, and "
              + "everything else that address ever does is joined to your conversations. what it "
              + "buys is that a stranger can check a signature you made.",
            label: "record",
            effect: { t: "record", address: m.fields.myAddress, path: m.fields.recordPath || "record.felts" },
          },
        });
      }
      if (ch === "C") {
        if (!m.fields.anchorName || !m.fields.anchorAddress) {
          return just(say(m, "a channel name and their address, then C", "warn"));
        }
        return run(m, "anchor", {
          t: "anchor", channel: m.fields.anchorName, address: m.fields.anchorAddress,
          path: m.fields.recordPath || "record.felts",
        });
      }
      return just(m);
    case "identity":
      if (ch === "R") {
        return just({
          ...m,
          confirm: {
            // The question names what is DESTROYED rather than what is renewed. Anyone holding
            // the old bundle whose prekey message has not been collected can no longer reach
            // you — that is the feature, and it is not what "rotate" sounds like.
            question: "destroy the current prekey private? anyone who fetched your old bundle "
              + "and has not been collected can no longer reach you.",
            label: "rotate",
            effect: { t: "rotate" },
          },
        });
      }
      return just(m);
    case "disclosure":
      if (ch === "c") return just({ ...m, cite: !m.cite });
      return just(m);
    default:
      return just(m);
  }
}

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

/**
 * The identity summary. **Moved here out of `view.ts`, and not only for tidiness.**
 *
 * It was computed in the presentation layer and memoised in a module-level variable keyed on
 * `${state.seedHex}:…`, which kept the raw vault root in a module-scope string for the life of
 * the process. Contained in a Node process; in the browser bundle `web/` now serves, the one
 * thing I6 forbids — arriving through a cache key rather than through any field anyone would
 * think to check, and a JavaScript string cannot be zeroed.
 *
 * **The memo is a `WeakMap` on the state object, not a string key.** `epoch:oneTimeLeft` was
 * the obvious replacement and it is unique only by accident: `effects.ts` `init()` mints a fresh
 * identity in-process, and every fresh state is epoch 0 with the same one-time count, so two
 * identities collide on one key. That is unreachable today only because `start` sends you to
 * `setup` solely when there was no state at startup — a guarantee that lives in a different
 * function from the cache and that nobody editing the cache would think to check. Keying on the
 * object cannot collide however this reducer grows, and it dies with the state rather than at
 * process exit. **Showing the wrong fingerprint is worse than any stale-cache bug**: it is the
 * value users read aloud to each other to check who they are talking to.
 *
 * **AND THE OBJECT ALONE IS NOT ENOUGH, WHICH THE FIRST VERSION OF THIS GOT WRONG.** `State` is
 * mutated IN PLACE — `rotatePrekey` writes through `state.prekeys` and the effect returns the same
 * object, and accepting a handshake consumes a one-time key the same way. So identity is stable
 * while the content is not, and a memo keyed on the object alone served a stale epoch and a stale
 * one-time count forever: the Identity page went on reporting 20 keys left after a rotation.
 * `tui-identity-memo.test.ts` drives exactly that.
 *
 * The discarded string key `seedHex:epoch:oneTimeLeft` had this right — the two fields it carried
 * beyond the seed were doing real work, and dropping the seed took them with it. **A replacement
 * that keeps only the property you were thinking about loses the ones you were not.** So the
 * invalidating fields moved into the value: the object identity gives collision-freedom and
 * lifetime, the compared fields give freshness, and no secret is in either.
 */
type Memo = { readonly epoch: number; readonly oneTimeLeft: number; readonly value: Identity };
const identities = new WeakMap<State, Memo>();

function identityOf(state: State): Identity {
  const epoch = state.prekeys.epoch;
  const oneTimeLeft = oneTimeRemaining(state.prekeys);
  const hit = identities.get(state);
  if (hit && hit.epoch === epoch && hit.oneTimeLeft === oneTimeLeft) return hit.value;
  const root = derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromStoredSeed(
    new Uint8Array(Buffer.from(state.seedHex, "hex")), STATE_FILE))));
  const bundle = bundleFrom(root, state.prekeys);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  // The fingerprint covers BOTH long-term keys — see `commands.ts`, which explains why both.
  const value: Identity = {
    fingerprint: hex(bundle.identityKey).slice(0, 16) + hex(bundle.signingKey).slice(0, 16),
    epoch,
    oneTimeLeft,
  };
  identities.set(state, { epoch, oneTimeLeft, value });
  return value;
}

/**
 * `State` narrowed to what the screen draws.
 *
 * **This is the only place the two descriptions meet, and that is the point.** A hand-kept
 * `Client` would agree with `State` until somebody edited one of them; because this takes a
 * `State` and returns a `Client`, a field renamed or retyped over there is a type error here
 * rather than a screen that quietly renders a stale shape. If this ever stops typechecking
 * cleanly, the boundary is in the wrong place — do not paper over it with a cast.
 *
 * What does NOT come across: `seedHex`, `prekeys`, and the body and delete capability of every
 * queued upload. The view asked for a fingerprint and a queue length and was being handed the
 * vault root to compute them itself.
 *
 * **NOT EXPORTED.** `viewOf` is the surface; this is how `viewOf` is built. It was exported at
 * first and `reachability-sweep.test.ts` refused it — *"a module's exports should be its actual
 * surface, and there is no reason to widen it for a function nobody outside can want"* — which is
 * right, and the compiler check this function exists for happens at its signature whether anyone
 * outside can call it or not. Exporting it to make the boundary feel official would have been the
 * boundary being less checked, not more.
 */
function clientOf(state: State): Client {
  return {
    identity: identityOf(state),
    lockedAtRest: state.lockedAtRest,
    channels: Object.fromEntries(
      Object.entries(state.channels).map(([n, c]) => [n, { anchor: c.anchor ?? null }])),
    pending: state.pending.map((p) => ({ channel: p.channel, uploadAt: p.uploadAt, real: p.real })),
    vaultUrl: state.vaultUrl,
    rpcUrl: state.rpcUrl,
    contract: state.contract,
    fromBlock: state.fromBlock,
    controlUrl: state.controlUrl,
    poolAccount: state.poolAccount,
    invites: state.invites.length,
  };
}

/**
 * The model as the screen sees it. `main.ts` calls this once per frame.
 *
 * Everything the view used to compute for itself is decided here, in Node: the fingerprint, the
 * attribution label on every message, and the crowd the selected channel sits in. All three
 * needed `cli/src/commands.ts`, which is the single choke point into `vault-client` — two
 * one-use imports were carrying three forbidden modules into the view's graph.
 */
export function viewOf(m: Model): View {
  const current = selected(m);
  const anchor = (current && m.state?.channels[current]?.anchor) || null;
  const shown = (channel: string, messages: readonly Received[]): readonly Shown[] =>
    messages.map((msg) => ({
      text: msg.text,
      mine: msg.mine,
      attribution: msg.attribution,
      // I7: the name and what backs it, from the one function that decides both.
      who: attributionLabel(msg, channel, anchor),
    }));
  return {
    page: m.page,
    client: m.state ? clientOf(m.state) : null,
    // Still read from `cli/src/state.ts`, so `HYDRA_HOME` at module load still governs it —
    // `web/scripts/capture-tui.ts` depends on that, and its leak assertions are what caught the
    // build machine's home directory going onto a public page the first time this was captured.
    statePath: STATE_FILE,
    typing: m.typing,
    field: m.field,
    fields: m.fields,
    channel: m.channel,
    scroll: m.scroll,
    transcript: Object.fromEntries(
      Object.entries(m.transcript).map(([n, msgs]) => [n, shown(n, msgs)])),
    foreign: m.foreign,
    linked: m.state && current ? linkabilityOf(m.state, current) : { known: false, crowd: 0 },
    log: m.log,
    busy: m.busy,
    // The effect is dropped: which button was pressed is the reducer's business.
    confirm: m.confirm ? { question: m.confirm.question, label: m.confirm.label } : null,
    cite: m.cite,
    signing: m.signing,
    now: m.now,
  };
}
