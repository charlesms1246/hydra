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

import type { Key } from "./keys.ts";
import type { State } from "../../cli/src/state.ts";
import type { Received } from "../../cli/src/commands.ts";

export type Page = "chats" | "connect" | "identity" | "disclosure" | "status";

export const PAGES: readonly { readonly id: Page; readonly label: string }[] = [
  { id: "chats", label: "Chats" },
  { id: "connect", label: "Connect" },
  { id: "identity", label: "Identity" },
  { id: "disclosure", label: "Disclosure" },
  { id: "status", label: "Status" },
];

/**
 * The fields each page owns.
 *
 * `setup` is not in `PAGES` because it is not a destination: it is what the interface is when
 * there is no identity yet, and it goes away for good once there is one.
 */
export const FIELDS: Record<Page | "setup", readonly { readonly key: string; readonly label: string }[]> = {
  setup: [
    { key: "vault", label: "vault URL" },
    { key: "rpc", label: "chain RPC" },
    { key: "contract", label: "contract address" },
    { key: "accountsFile", label: "sncast accounts file" },
    { key: "account", label: "account name" },
    { key: "network", label: "network (blank for a devnet URL)" },
    { key: "invites", label: "upload invites, comma separated" },
  ],
  chats: [{ key: "compose", label: "message" }],
  connect: [
    { key: "peerName", label: "what to call them" },
    { key: "peerBundle", label: "path to their bundle file" },
    { key: "exportPath", label: "write my bundle to" },
  ],
  identity: [],
  disclosure: [],
  status: [],
};

/** What `main.ts` is being asked to do. Descriptions, not calls. */
export type Effect =
  | { readonly t: "init"; readonly fields: Readonly<Record<string, string>> }
  | { readonly t: "send"; readonly channel: string; readonly text: string }
  | { readonly t: "read"; readonly channel: string }
  | { readonly t: "flush" }
  | { readonly t: "collect" }
  | { readonly t: "rotate" }
  | { readonly t: "invite"; readonly name: string; readonly path: string }
  | { readonly t: "export"; readonly path: string }
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

export type LogLine = { readonly at: number; readonly text: string; readonly tone: "info" | "warn" | "bad" };

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
    fields: {
      vault: "http://127.0.0.1:8080", rpc: "http://127.0.0.1:5050", contract: "",
      accountsFile: "", account: "", network: "", invites: "",
      compose: "", peerName: "", peerBundle: "", exportPath: "bundle.json",
    },
    channel: 0,
    scroll: 0,
    transcript: {},
    foreign: {},
    log: [],
    busy: null,
    confirm: null,
    cite: false,
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
    const digit = "12345".indexOf(k.value);
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
        "send", { t: "send", channel, text: m.fields.compose });
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
