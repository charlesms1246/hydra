/**
 * The model, as a screen.
 *
 * Pure: `render` takes a model and a size and returns lines. It reads no clock, no environment
 * and no disk, which is what makes a frame something a test can assert on rather than something
 * a person has to look at.
 *
 * The one thing it computes rather than receives is the identity summary, because deriving a
 * fingerprint is an HKDF and two key generations and doing that on every keystroke would be
 * silly. It is memoised on the values it depends on — a cache, not state.
 *
 * WHAT THE LAYOUT IS FOR. Every page carries the cost of what it does, next to the button that
 * does it. `invite` says the vault operator learns you are reachable; `send` says the chain
 * shows that you sent something; `rotate` says who can no longer reach you. That is the same
 * rule the CLI follows — the warnings under `hydra send` are not decoration — and it survives
 * the move to a TUI only if the text moves with the action rather than into a help page.
 */

import { box, beside, fit, frame, paint, truncate, wrap, width } from "./screen.ts";
import { PAGES, FIELDS, channelNames, selected, due } from "./app.ts";
import type { Model, Page } from "./app.ts";
import { statement } from "../../claims/src/statement.ts";
import { bundleFrom, oneTimeRemaining } from "../../handshake/src/prekeys.ts";
import { derive, rootSeed, entropyFrom, fromStoredSeed, VAULT_DOMAIN } from "../../identity/src/domains.ts";
import { STATE_FILE } from "../../cli/src/state.ts";
import type { State } from "../../cli/src/state.ts";

export type Size = { readonly rows: number; readonly cols: number };

const STATEMENT = statement();

type Identity = { readonly fingerprint: string; readonly epoch: number; readonly oneTimeLeft: number };

let cached: { readonly key: string; readonly value: Identity } | null = null;

/** The fingerprint over BOTH long-term keys — see `commands.ts`, which explains why both. */
export function identityOf(state: State): Identity {
  const key = `${state.seedHex}:${state.prekeys.epoch}:${oneTimeRemaining(state.prekeys)}`;
  if (cached?.key === key) return cached.value;
  const root = derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromStoredSeed(
    new Uint8Array(Buffer.from(state.seedHex, "hex")), STATE_FILE))));
  const bundle = bundleFrom(root, state.prekeys);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const value: Identity = {
    fingerprint: hex(bundle.identityKey).slice(0, 16) + hex(bundle.signingKey).slice(0, 16),
    epoch: state.prekeys.epoch,
    oneTimeLeft: oneTimeRemaining(state.prekeys),
  };
  cached = { key, value };
  return value;
}

// ---------------------------------------------------------------------------
// Furniture
// ---------------------------------------------------------------------------

const nav = (m: Model, cols: number): string => {
  if (m.page === "setup") return paint(" HYDRA ", "inverse", "bold") + paint("  first run", "gray");
  const cells = PAGES.map((p, i) => (p.id === m.page
    ? paint(` ${p.label} `, "inverse")
    : paint(` ${p.label} (${i + 1})`, "gray")));
  return truncate(paint(" HYDRA ", "inverse", "bold") + " " + cells.join(" "), cols);
};

/**
 * The right-hand end of the nav: what the process is doing when nobody is typing.
 *
 * A resident client uploads on a timer, which means it acts while the user is not looking. That
 * has to be visible or the interface is lying about what it is doing on the network — the count
 * of objects due is exactly what the vault is about to be told.
 */
const activity = (m: Model): string => {
  if (m.busy) return paint(`● ${m.busy}…`, "yellow");
  const n = due(m);
  if (n) return paint(`● ${n} upload${n === 1 ? "" : "s"} due`, "cyan");
  const waiting = m.state?.pending.length ?? 0;
  return waiting ? paint(`○ ${waiting} scheduled`, "gray") : paint("○ idle", "gray");
};

const KEYS: Record<Page | "setup", string> = {
  setup: "i type · Tab field · Enter create identity · ctrl-c quit",
  chats: "i type · Enter send · s sign · r read · D forget · j/k channel · f flush · q quit",
  connect: "i type · Tab field · Enter invite · e export bundle · c collect · q quit",
  identity: "R rotate prekey · 1-5 pages · q quit",
  disclosure: "c citations · j/k scroll · 1-5 pages · q quit",
  status: "f flush now · j/k scroll · 1-5 pages · q quit",
};

const field = (m: Model, index: number, key: string, label: string, cols: number): string => {
  const on = m.field === index && FIELDS[m.page].length > 0;
  const value = m.fields[key] ?? "";
  const caret = on && m.typing ? paint("▏", "cyan") : "";
  const name = fit(label, Math.min(28, Math.floor(cols / 3)));
  return `${on ? paint("›", "cyan") : " "} ${on ? paint(name, "bold") : paint(name, "gray")} ${value}${caret}`;
};

const fieldBlock = (m: Model, cols: number): string[] =>
  FIELDS[m.page].map((f, i) => field(m, i, f.key, f.label, cols));

const note = (text: string, cols: number): string[] =>
  wrap(text, cols).map((l) => paint(l, "gray"));

/**
 * A list item with a hanging indent.
 *
 * Only visible once the thing is on a terminal, which is why it was missing: rendered into a
 * string array the disclosure list reads fine, and drawn at eighty columns every continuation
 * line starts hard against the left border and the list stops looking like a list.
 */
const bullet = (text: string, cols: number, marker = "- "): string[] => {
  // `width`, not `.length`: a coloured marker carries escape sequences that occupy no columns,
  // and indenting by their byte count pushes every continuation line off the right edge.
  const n = width(marker);
  return wrap(text, cols - n).map((l, i) => (i === 0 ? marker : " ".repeat(n)) + l);
};

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function chats(m: Model, size: Size, height: number): string[] {
  const names = channelNames(m);
  const current = selected(m);
  const listWidth = Math.min(26, Math.max(16, Math.floor(size.cols / 4)));
  const composeHeight = 6;
  const top = height - composeHeight;

  const list = names.map((n, i) => {
    const pending = (m.state?.pending ?? []).filter((p) => p.channel === n).length;
    const mark = i === m.channel ? paint("›", "cyan") : " ";
    const tail = pending ? paint(` ${pending}`, "gray") : "";
    return `${mark} ${i === m.channel ? paint(n, "bold") : n}${tail}`;
  });

  const messages = current ? m.transcript[current] ?? [] : [];
  const body = messages.length
    ? messages.flatMap((msg) => bullet(
      msg.text, size.cols - listWidth - 4,
      // Who spoke, on every line's first row. A channel is two one-way keys, and which one
      // opened a message is the only thing that establishes authorship on this screen.
      msg.mine ? paint("you  ", "gray") : paint(`${current}  `, "cyan")))
    : note(current
      ? "nothing read yet. `r` fetches every chain event and asks the vault for every "
        + "candidate id at once — that batch IS the read defence, and it is why reading is "
        + "quadratic in the number of events."
      : "no channels. open one on Connect (2).", size.cols - listWidth - 4);

  const visible = body.slice(Math.max(0, body.length - (top - 2)));

  const foreign = current ? m.foreign[current] ?? 0 : 0;
  // The mode, above the line you are typing on. Which of the two things Enter is about to do is
  // not a setting to be remembered; it is part of the message.
  const mode = m.signing
    ? paint(" SIGNED ", "inverse", "yellow") + paint(
      "  only you could have written this, and anyone holding your bundle can prove it", "gray")
    : paint(" deniable ", "inverse") + paint(
      "  either of you could have written this — `s` to sign", "gray");
  const compose = [
    mode,
    fit(m.fields.compose + (m.typing && m.page === "chats" ? paint("▏", "cyan") : ""), size.cols - 4),
    "",
    ...(foreign
      ? wrap(`${foreign} message(s) here were sent as you by another client. two clients on one `
        + "seed mint identical cover, and an object uploaded twice is one the storage server "
        + "knows is cover. use one client per identity.", size.cols - 4)
        .slice(0, 2).map((l) => paint(l, "yellow"))
      : note("the chain shows that YOU published, and in what order. the timing defence hides "
        + "which upload holds the text, not that you sent it.", size.cols - 4).slice(0, 2)),
  ];

  return [
    ...beside(
      box(list, { width: listWidth, height: top, title: `channels (${names.length})` }),
      box(visible, { width: size.cols - listWidth, height: top, title: current ?? "—" }),
    ),
    ...box(compose, { width: size.cols, height: composeHeight, title: "message", focus: m.typing }),
  ];
}

function connect(m: Model, size: Size, height: number): string[] {
  const id = m.state ? identityOf(m.state) : null;
  const lines = [
    `${paint("your fingerprint", "gray")}  ${paint(id?.fingerprint ?? "—", "bold")}`,
    "",
    ...fieldBlock(m, size.cols),
    "",
    ...note("Enter opens a channel and delivers the prekey message through the vault. the "
      + "storage server can then see that they are reachable and count what is waiting for "
      + "them — unavoidable without accounts, and accounts would disclose more. "
      + "(decisions/0013)", size.cols - 4),
    "",
    ...note("AND: that write is not scheduled the way message uploads are. if you send in the "
      + "next few minutes, the chain publish nearest it is yours, and anyone holding both "
      + "records reads it off. measured above 90%. (decisions/0018)", size.cols - 4),
    "",
    ...note("`e` writes your own bundle to the path above; give that file to whoever wants to "
      + "reach you. `c` accepts whatever is waiting in your vault mailbox.", size.cols - 4),
  ];
  return box(lines, { width: size.cols, height, title: "start a conversation", focus: m.typing });
}

function identity(m: Model, size: Size, height: number): string[] {
  const id = m.state ? identityOf(m.state) : null;
  const lines = [
    `${paint("fingerprint       ", "gray")}${paint(id?.fingerprint ?? "—", "bold")}`,
    `${paint("signed prekey     ", "gray")}epoch ${id?.epoch ?? "—"}`,
    `${paint("one-time prekeys  ", "gray")}${id?.oneTimeLeft ?? 0} left`,
    "",
    ...note("read that fingerprint out loud to the person you are talking to, by some means "
      + "that is not this program. it covers both long-term keys: fingerprinting only the DH "
      + "key would leave the signing key unverified, and the signing key is what makes a "
      + "swapped prekey detectable.", size.cols - 4),
    "",
    ...(id && id.oneTimeLeft === 0
      ? note("NO ONE-TIME PREKEYS LEFT. bundles published now have no replay resistance. "
        + "press R.", size.cols - 4).map((l) => paint(l.replace(/\x1b\[[0-9;]*m/g, ""), "yellow"))
      : []),
    "",
    ...note(`your root key is in ${STATE_FILE}, in the clear, mode 0600 and nothing else. `
      + "no passphrase, no keychain, no hardware token. anyone who reads that file reads every "
      + "past and future conversation. this is a client for a devnet and a testnet.",
      size.cols - 4),
    "",
    ...note("that file also holds every message you have sent or read, as text. it does not "
      + "widen who can read them — anyone with the seed could fetch and open them anyway — but "
      + "it means the words are there without any work, and deleting them from that file is the "
      + "only way not to have them.", size.cols - 4),
  ];
  return box(lines, { width: size.cols, height, title: "identity" });
}

function disclosure(m: Model, size: Size, height: number): string[] {
  const inner = size.cols - 4;
  const section = (title: string, claims: readonly { says: string; from: string }[]) => [
    paint(title, "bold"),
    ...claims.flatMap((c) => [
      ...bullet(c.says, inner),
      ...(m.cite ? bullet(c.from, inner, "  ").map((l) => paint(l, "gray")) : []),
    ]),
    "",
  ];
  const lines = [
    ...section("What the people running this can see", STATEMENT.whoCanSeeWhat),
    ...section("What is protected, and how well", STATEMENT.whatIsPartial),
    ...section("What they cannot see", STATEMENT.whatWeCannotSee),
  ];
  // Where the statement comes from does not scroll. It was at the bottom of a hundred-odd
  // wrapped lines, which meant the one sentence explaining why any of it can be trusted was the
  // one sentence nobody would ever have on screen.
  const head = [
    ...note("every line below is generated from the code that makes it true. nothing here is a "
      + "promise about what anyone will do with what they can see.", inner),
    "",
  ];
  return box([...head, ...lines.slice(m.scroll)], {
    width: size.cols, height,
    title: `what everyone involved can see — ${m.scroll + 1}/${lines.length}${m.cite ? " · cited" : ""}`,
  });
}

function status(m: Model, size: Size, height: number): string[] {
  const s = m.state;
  const pending = s?.pending ?? [];
  const soon = [...pending].sort((a, b) => a.uploadAt - b.uploadAt).slice(0, 8);
  const at = (t: number) => (t <= m.now ? paint("due", "cyan") : `in ${Math.ceil((t - m.now) / 1000)}s`);
  const lines = [
    `${paint("state    ", "gray")}${STATE_FILE}`,
    `${paint("vault    ", "gray")}${s?.vaultUrl ?? "—"}`,
    `${paint("chain    ", "gray")}${s?.contract || "(unset)"} via ${s?.rpcUrl ?? "—"}`,
    `${paint("route    ", "gray")}${s?.controlUrl ? `pool (${s.poolAccount || "alice"})` : "direct from your own account"}`,
    `${paint("invites  ", "gray")}${s?.invites.length ?? 0} left`,
    "",
    paint(`queue — ${pending.length} object(s), uploaded on the clock, not on your command`, "bold"),
    ...soon.map((p) => `  ${fit(p.channel, 18)}${p.real ? "message" : paint("cover  ", "gray")}  ${at(p.uploadAt)}`),
    ...(pending.length ? [] : [paint("  nothing queued", "gray")]),
    "",
    ...note("cover spends invites too, at the cover rate per message. a vault tuned for bare "
      + "messages will rate-limit the clients doing the timing defence correctly.", size.cols - 4),
  ];
  return box(lines.slice(m.scroll), { width: size.cols, height, title: "status" });
}

function setup(m: Model, size: Size, height: number): string[] {
  const lines = [
    ...note("no identity yet. this creates one: a fresh vault root from OS randomness, twenty "
      + "one-time prekeys, and nothing else.", size.cols - 4),
    "",
    ...FIELDS.setup.map((f, i) => field(m, i, f.key, f.label, size.cols)),
    "",
    ...note(`Enter writes ${STATE_FILE}. that file holds your root key in the clear. it is `
      + "mode 0600 and that is all the protection there is.", size.cols - 4),
  ];
  return box(lines, { width: size.cols, height, title: "first run", focus: m.typing });
}

/**
 * A question, as the whole body.
 *
 * It takes the page over rather than sharing the status line, because the status line is one row
 * and the questions worth asking do not fit in one row. The first version truncated "anyone who
 * fetched your old bundle and has not been collected can no longer reach you" at the terminal's
 * width, which is a consent dialog that hides the consequence — the exact failure the rest of
 * this interface is built to avoid.
 */
function confirmBody(m: Model, size: Size, height: number): string[] {
  const inner = size.cols - 4;
  const lines = [
    "",
    ...wrap(m.confirm!.question, inner).map((l) => paint(l, "yellow")),
    "",
    `${paint("y", "bold")} do it     ${paint("n", "bold")} or any other key, cancel`,
  ];
  return box(lines, { width: size.cols, height, title: m.confirm!.label, focus: true });
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

const PAGE_BODY: Record<Page | "setup", (m: Model, size: Size, height: number) => string[]> = {
  setup, chats, connect, identity, disclosure, status,
};

/** The lines of one frame. `main.ts` is what turns these into a write. */
export function render(m: Model, size: Size): string[] {
  const head = nav(m, size.cols);
  const right = activity(m);
  const header = fit(head, Math.max(0, size.cols - width(right) - 1)) + " " + right;

  const bodyHeight = Math.max(6, size.rows - 4);
  const body = m.confirm ? confirmBody(m, size, bodyHeight) : PAGE_BODY[m.page](m, size, bodyHeight);

  const last = m.log[m.log.length - 1];
  const tone = last?.tone === "bad" ? "red" : last?.tone === "warn" ? "yellow" : "gray";
  const line = paint(truncate(last ? last.text : "", size.cols), tone as "gray");

  const keys = m.confirm ? "y confirm · any other key cancels" : KEYS[m.page];
  return [header, ...body, line, paint(truncate(keys, size.cols), "gray")];
}

/** What gets written to the terminal. */
export const screen = (m: Model, size: Size): string => frame(render(m, size), size.rows);
