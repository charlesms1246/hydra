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
import { attributionLabel } from "../../cli/src/commands.ts";
import type { Model, Page } from "./app.ts";
import { statement } from "../../claims/src/statement.ts";
import { describe } from "../../channel/src/crowd.ts";
import { linkabilityOf } from "../../cli/src/commands.ts";
import { bundleFrom, oneTimeRemaining } from "../../handshake/src/prekeys.ts";
import { derive, rootSeed, entropyFrom, fromStoredSeed, VAULT_DOMAIN } from "../../identity/src/domains.ts";
import { STATE_FILE } from "../../cli/src/state.ts";
import { SIGNED, DENIABLE, RECORD_NOT_WRITTEN, SECOND_CLIENT, KEY_IN_CLEAR, KEY_LOCKED }
  from "../../claims/src/warnings.ts";
import type { State } from "../../cli/src/state.ts";

export type Size = { readonly rows: number; readonly cols: number };

const STATEMENT = statement();

type Identity = { readonly fingerprint: string; readonly epoch: number; readonly oneTimeLeft: number };

let cached: { readonly key: string; readonly value: Identity } | null = null;

/** The fingerprint over BOTH long-term keys — see `commands.ts`, which explains why both. */
function identityOf(state: State): Identity {
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
  identity: "R rotate prekey · 1-6 pages · q quit",
  record: "i type · Tab field · A write mine · C check theirs · 1-6 pages · q quit",
  disclosure: "c citations · j/k scroll · 1-6 pages · q quit",
  status: "f flush now · j/k scroll · 1-6 pages · q quit",
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
  // Where this channel's signing key is published, or null while it is only what the handshake
  // said. It changes what a tick MEANS, so it reaches both the label and the legend below.
  const anchor = (current && m.state?.channels[current]?.anchor) || null;
  const body = messages.length
    ? messages.flatMap((msg) => {
      // I7: the name and what backs it, together, from the one function that decides both. A
      // deniable message still shows the name the reader gave this channel — their own belief is
      // theirs to hold — but never without the mark that says the product cannot prove it.
      const who = attributionLabel(msg, current ?? "", anchor);
      const tone = msg.attribution === "signed" ? "green" : "yellow";
      return bullet(
        msg.text, size.cols - listWidth - 4,
        paint(who.mark, tone) + " " + paint(`${who.name}  `, msg.mine ? "gray" : "cyan"));
    })
    : note(current
      ? "nothing read yet. `r` fetches every chain event and asks the vault for every "
        + "candidate id at once — that batch IS the read defence, and it is why reading is "
        + "quadratic in the number of events."
      : "no channels. open one on Connect (2).", size.cols - listWidth - 4);

  const visible = body.slice(Math.max(0, body.length - (top - 2)));

  const foreign = current ? m.foreign[current] ?? 0 : 0;
  // The mode, above the line you are typing on. Which of the two things Enter is about to do is
  // not a setting to be remembered; it is part of the message.
  // FROM `claims/src/warnings.ts`. This line used to say "anyone holding your bundle can prove
  // it", which the CLI had already been corrected out of: signing alone buys no third-party proof.
  // One source, both readers — standing rule 3.
  const mode = m.signing
    ? paint(" SIGNED ", "inverse", "yellow") + paint(`  ${SIGNED.short}`, "gray")
    : paint(" deniable ", "inverse") + paint(`  ${DENIABLE.short} — \`s\` to sign`, "gray");
  // The crowd, on the page that composes. Plain text and no colour: it is computed from public
  // data and verified by nobody, so anything that read as a badge would be claiming more than
  // I7 allows. `describe` writes the zero case first because zero is the usual answer.
  const linked = m.state && current ? linkabilityOf(m.state, current) : { known: false, crowd: 0 };
  const compose = [
    mode,
    fit(m.fields.compose + (m.typing && m.page === "chats" ? paint("▏", "cyan") : ""), size.cols - 4),
    "",
    ...(foreign
      // The cover collision is FIXED (`decisions/0033`) — two devices salt their decoys with the
      // commitment, which differs per message — so this no longer warns about identical cover.
      // What is left is still worth saying: both clients spend invites and count sequences, and
      // the other one's messages cannot be read here because this client destroyed that key.
      ? wrap(`${foreign} message(s) here were sent as you by another client. `
        + SECOND_CLIENT.full.slice(1).join(" "), size.cols - 4)
        .slice(0, 2).map((l) => paint(l, "yellow"))
      : note("the chain shows that YOU published, and in what order. the timing defence hides "
        + "which upload holds the text, not that you sent it.", size.cols - 4).slice(0, 2)),
    ...describe(linked).flatMap((l) => wrap(l, size.cols - 4)).map((l) => paint(l, "gray")),
  ];

  return [
    ...beside(
      box(list, { width: listWidth, height: top, title: `channels (${names.length})` }),
      box(visible, { width: size.cols - listWidth, height: top, title: current ?? "—" }),
    ),
    ...box(compose, {
      width: size.cols, height: composeHeight, focus: m.typing,
      title: anchor
        ? `message  ✓ signed, key at ${anchor.slice(0, 10)}… · ? unverifiable`
        : "message  ✓ signed, key from the handshake · ? unverifiable",
    }),
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
    // FROM `claims/src/warnings.ts`, and WHICH ONE depends on what is true of the file. This said
    // the key is "in the clear" unconditionally, in three places, and a test defended it — so the
    // moment `hydra lock` shipped it would have been false everywhere with a guard holding it in
    // place. See `decisions/0040` §4.
    ...note(`${STATE_FILE}: ${(m.state?.lockedAtRest ? KEY_LOCKED : KEY_IN_CLEAR).full.join(" ")}`,
      size.cols - 4),
    "",
    ...note("that file also holds every message you have sent or read, as text. it does not "
      + "widen who can read them — anyone with the seed could fetch and open them anyway — but "
      + "it means the words are there without any work, and deleting them from that file is the "
      + "only way not to have them.", size.cols - 4),
  ];
  return box(lines, { width: size.cols, height, title: "identity" });
}

/**
 * Publishing a signing key, and checking somebody else's.
 *
 * Its own page because it is its own act. Signed content is checked against a key that arrived
 * over the handshake, which proves the author is whoever answered it and nothing about who that
 * was; a record moves the key somewhere a stranger can find it. That is a real gain and a real
 * disclosure, and the disclosure is the part a user has to see before pressing anything.
 */
function record(m: Model, size: Size, height: number): string[] {
  const anchored = Object.entries(m.state?.channels ?? {})
    .filter(([, c]) => c.anchor)
    .map(([n, c]) => `${paint(n.padEnd(16), "cyan")}${c.anchor}`);
  const lines = [
    ...fieldBlock(m, size.cols),
    "",
    ...note("`A` writes the felts to publish at your address. the record carries your identity "
      + "and signing keys signed a SECOND time, over that address — otherwise anyone could "
      + "republish your keys under a name of their own and be believed as you, which is the "
      + "same forgery signing was meant to close.", size.cols - 4),
    "",
    // WAS FALSE: it said the ABI is "not verified anywhere in this repo", after `0031` verified
    // it against the deployed class and landed a record. The CLI had already retracted that.
    // `short`, not `full`: the full text pushed "joins to your conversations" off the bottom of
    // the frame, and `tui-conversation.test.ts` caught it — which is precisely why that assertion
    // has a neighbour, as its own comment says.
    ...note(`THIS PROGRAM DOES NOT PUT IT ON CHAIN — ${RECORD_NOT_WRITTEN.short}.`, size.cols - 4)
      .map((l) => paint(l.replace(/\x1b\[[0-9;]*m/g, ""), "gray")),
    "",
    ...note("PUBLISHING IT CANNOT BE UNDONE. the record names your messaging identity and that "
      + "address together, forever, for everybody — so everything else the address ever does "
      + "joins to your conversations. rotation replaces what is current, not what was.",
      size.cols - 4).map((l) => paint(l.replace(/\x1b\[[0-9;]*m/g, ""), "yellow")),
    "",
    ...note("`C` checks their record against the key you handshook with. it refuses on "
      + "disagreement rather than preferring one, because nothing here can tell a wrong record "
      + "from a wrong handshake — and it still does not say the address is the person you mean.",
      size.cols - 4),
    "",
    ...(anchored.length
      ? [paint("checked", "bold"), ...anchored]
      : note("no channel's key is published yet. their signatures still verify; only you can "
        + "check them.", size.cols - 4)),
  ];
  return box(lines, { width: size.cols, height, title: "published keys", focus: m.typing });
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
  setup, chats, connect, identity, record, disclosure, status,
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
