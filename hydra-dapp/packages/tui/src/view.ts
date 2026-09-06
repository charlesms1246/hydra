/**
 * The model, as a screen.
 *
 * Pure: `render` takes a {@link View} and a size and returns lines. It reads no clock, no
 * environment and no disk, which is what makes a frame something a test can assert on rather than
 * something a person has to look at.
 *
 * **That sentence was half false until the split, and it is worth saying which half.** The
 * environment clause was untrue: this file imported `STATE_FILE`, which `cli/src/state.ts`
 * evaluates from `HYDRA_HOME` or the user's home directory at module load. It also computed the
 * identity summary rather than receiving it — an HKDF and two key generations, memoised in a
 * module-level variable **keyed on the raw seed hex**. All of that now happens in `app.ts`.
 *
 * ## IT DRAWS A `View`, NOT A `State`, AND THAT IS LOAD-BEARING
 *
 * `web/` renders this file live at the reader's width, so it is bundled and served to a browser.
 * I6 says no pool viewing key and no vault content key may enter one, and `web/scripts/
 * module-graph.ts` fails the build if a page reaches `packages/identity/` or
 * `packages/vault-client/`. This file reached four such modules; it now reaches none.
 *
 * The rule that keeps it that way: **this file may import `./screen.ts`, `./model.ts`, and
 * modules that hold text.** Not `./app.ts`, not `cli/src/state.ts`, not `cli/src/commands.ts` —
 * the last is a single import away from three forbidden modules, and `State` reaches a fourth
 * through `handshake/`. If you need a value from any of them, compute it in `app.ts` `viewOf`
 * and put it on the `View`. See `model.ts` for why the boundary is where it is.
 *
 * WHAT THE LAYOUT IS FOR. Every page carries the cost of what it does, next to the button that
 * does it. `invite` says the vault operator learns you are reachable; `send` says the chain
 * shows that you sent something; `rotate` says who can no longer reach you. That is the same
 * rule the CLI follows — the warnings under `hydra send` are not decoration — and it survives
 * the move to a TUI only if the text moves with the action rather than into a help page.
 */

import { box, beside, fit, frame, paint, truncate, wrap, width } from "./screen.ts";
import { PAGES, FIELDS, channelNames, selected, due } from "./model.ts";
import { scaled } from "./logo.ts";
import type { Page, View } from "./model.ts";
import { statement } from "../../claims/src/statement.ts";
import { describe } from "../../channel/src/crowd.ts";
import { SIGNED, DENIABLE, RECORD_NOT_WRITTEN, SECOND_CLIENT, KEY_IN_CLEAR, KEY_LOCKED,
  LOOKUP_KEY_NOT_PERSON, LOOKUP_NO_ONE_TIME, LOOKUP_NODE_SEES, REMOVED_UNDER_PROCESS }
  from "../../claims/src/warnings.ts";
import { RECONFIGURE } from "../../claims/src/setup.ts";

export type Size = { readonly rows: number; readonly cols: number };

const STATEMENT = statement();

// ---------------------------------------------------------------------------
// Furniture
// ---------------------------------------------------------------------------

const nav = (m: View, cols: number): string => {
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
const activity = (m: View): string => {
  if (m.busy) return paint(`● ${m.busy}…`, "yellow");
  const n = due(m);
  if (n) return paint(`● ${n} upload${n === 1 ? "" : "s"} due`, "cyan");
  const waiting = m.client?.pending.length ?? 0;
  return waiting ? paint(`○ ${waiting} scheduled`, "gray") : paint("○ idle", "gray");
};

/**
 * The footer, per page.
 *
 * **`? help` LEADS EVERY ONE OF THEM, AND THE ORDER IS THE WHOLE POINT.** This line is truncated
 * at the terminal's width, and the Chats footer was already 79 columns before help existed — so
 * appending the one key that finds everything else would have put it past the edge at exactly the
 * width most terminals open at. `effects.ts` states the rule this follows: truncation eats the
 * tail, so the tail has to be the part you can afford to lose. Everything after `? help` is
 * repeated on the help screen; `? help` is not repeated anywhere.
 */
const KEYS: Record<Page | "setup", string> = {
  setup: "? help · i type · Tab field · Enter create identity · ctrl-c quit",
  chats: "? help · i type · Enter send · s sign · r read · D forget · j/k channel · f flush · q quit",
  connect: "? help · i type · Enter invite · l from address · e export · c collect · j/k · q quit",
  identity: "? help · R rotate prekey · 1-6 pages · q quit",
  record: "? help · i type · Tab field · A write mine · C check theirs · 1-6 pages · q quit",
  disclosure: "? help · c citations · j/k scroll · 1-6 pages · q quit",
  status: "? help · f flush now · j/k scroll · 1-6 pages · q quit",
};

const field = (m: View, index: number, key: string, label: string, cols: number): string => {
  const on = m.field === index && FIELDS[m.page].length > 0;
  const value = m.fields[key] ?? "";
  const caret = on && m.typing ? paint("▏", "cyan") : "";
  const name = fit(label, Math.min(28, Math.floor(cols / 3)));
  return `${on ? paint("›", "cyan") : " "} ${on ? paint(name, "bold") : paint(name, "gray")} ${value}${caret}`;
};

const fieldBlock = (m: View, cols: number): string[] =>
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

/**
 * The mark, on the pane that has no conversation to draw yet.
 *
 * An empty message pane with one grey sentence in it reads as a client that has not finished
 * loading. This is the first thing a new user sees after `init` and it should look like the
 * product rather than like a blank.
 *
 * **THE SENTENCE STAYS UNDER IT.** The mark is decoration and "open one on Connect (2)" is the
 * only affordance on the page — a splash that replaced it would be a nicer-looking dead end. It
 * is drawn in `gray` for the same reason: this pane holds messages and their attribution marks,
 * and decoration that competes with those for attention is decoration that costs something.
 *
 * Falls back to the sentence alone when the pane is too small to hold a mark worth drawing. The
 * cutoff is height rather than taste: below about four rows the outer ring closes into a blob.
 */
function splash(cols: number, rows: number): string[] {
  const caption = wrap("no channels yet. open one on Connect (2).", cols);
  const artRows = rows - caption.length - 1;
  if (artRows < 4 || cols < 12) return caption.map((l) => paint(l, "gray"));
  const art = scaled(cols, artRows);
  const pad = Math.max(0, Math.floor((cols - Math.max(0, ...art.map(width))) / 2));
  return [
    ...Array.from({ length: Math.max(0, Math.floor((artRows - art.length) / 2)) }, () => ""),
    ...art.map((l) => paint(" ".repeat(pad) + l, "gray")),
    "",
    ...caption.map((l) => paint(l, "gray")),
  ];
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function chats(m: View, size: Size, height: number): string[] {
  const names = channelNames(m);
  const current = selected(m);
  const listWidth = Math.min(26, Math.max(16, Math.floor(size.cols / 4)));
  const composeHeight = 6;
  const top = height - composeHeight;

  const list = names.map((n, i) => {
    const pending = (m.client?.pending ?? []).filter((p) => p.channel === n).length;
    const mark = i === m.channel ? paint("›", "cyan") : " ";
    const tail = pending ? paint(` ${pending}`, "gray") : "";
    return `${mark} ${i === m.channel ? paint(n, "bold") : n}${tail}`;
  });

  const messages = current ? m.transcript[current] ?? [] : [];
  // Where this channel's signing key is published, or null while it is only what the handshake
  // said. It changes what a tick MEANS, so it reaches both the label and the legend below.
  const anchor = (current && m.client?.channels[current]?.anchor) || null;
  const body = messages.length
    ? messages.flatMap((msg) => {
      // I7: the name and what backs it, together, from the one function that decides both —
      // `attributionLabel`, applied in `app.ts` `viewOf` because it lives behind `commands.ts`.
      // A deniable message still shows the name the reader gave this channel — their own belief
      // is theirs to hold — but never without the mark that says the product cannot prove it.
      const who = msg.who;
      const tone = msg.attribution === "signed" ? "green" : "yellow";
      return bullet(
        msg.text, size.cols - listWidth - 4,
        paint(who.mark, tone) + " " + paint(`${who.name}  `, msg.mine ? "gray" : "cyan"));
    })
    : current
      ? note("nothing read yet. `r` fetches every chain event and asks the vault for every "
        + "candidate id at once — that batch IS the read defence, and it is why reading is "
        + "quadratic in the number of events.", size.cols - listWidth - 4)
      : splash(size.cols - listWidth - 4, top - 2);

  const visible = body.slice(Math.max(0, body.length - (top - 2)));

  const foreign = current ? m.foreign[current] ?? 0 : 0;
  // **THE TUI COULD NOT SAY THIS AT ALL UNTIL THE PROJECTION CARRIED IT.** `clientOf` mapped a
  // channel to `{ anchor }`, so the field never reached the view — the CLI and the API could show
  // a compelled removal and the surface a source actually uses could not. `GUI-API-CONTRACT.md`
  // requires it *"because a removal indistinguishable from expiry is invisible to the people it
  // happened to"*. A count here; the ids stay in the CLI.
  const taken = (current && m.client?.channels[current]?.removedUnderProcess) || 0;
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
  const linked = m.linked;
  const compose = [
    // ABOVE the mode line, because it is the only thing on this page that already happened to
    // these messages rather than a property of the one being typed. Yellow and unabbreviated:
    // `short` is a status-bar line and this is the one disclosure a reader must not skim.
    ...(taken
      ? wrap(`${taken} message(s) here: ${REMOVED_UNDER_PROCESS.full.join(" ")}`, size.cols - 4)
        .map((l) => paint(l, "yellow"))
      : []),
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

function connect(m: View, size: Size, height: number): string[] {
  const id = m.client?.identity ?? null;
  const lines = [
    `${paint("your fingerprint", "gray")}  ${paint(id?.fingerprint ?? "—", "bold")}`,
    "",
    ...fieldBlock(m, size.cols),
    "",
    ...note("Enter opens a channel and delivers the prekey message through the vault. the "
      + "storage server can then see that they are reachable and count what is waiting for "
      + "them — unavoidable without accounts, and an account is a name the server could count "
      + "against over time.", size.cols - 4),
    "",
    ...note("AND: that write is not scheduled the way message uploads are. if you send in the "
      + "next few minutes, the chain publish nearest it is yours, and anyone holding both "
      + "records reads it off. measured above 90%.", size.cols - 4),
    "",
    ...note("`e` writes your own bundle to the path above; give that file to whoever wants to "
      + "reach you. `c` accepts whatever is waiting in your vault mailbox.", size.cols - 4),
    "",
    // **`l` IS THE STEP THAT HAD NO PATH, AND ITS THREE COSTS SIT UNDER IT RATHER THAN IN HELP.**
    // Everything above needs their bundle file, which means a source can only reach an
    // organisation they already have a relationship with — a prerequisite in front of the surface,
    // undoing its premise. A published record removes the file from both directions.
    //
    // FROM `claims/src/warnings.ts`, rendered `full` and not `short`. The CLI has printed these
    // three since `lookup` existed and this is the second surface to show them, which is precisely
    // when a sentence starts drifting — so they moved to one source and neither front end owns the
    // words. `full` because this box wraps and has the room: `short` exists for a status line, and
    // summarising a disclosure on the surface a user is likelier to be reading is the wrong way
    // round.
    paint("or, with no file at all", "bold"),
    ...note("`l` opens a conversation from a record they published at a Starknet address. put "
      + "their address in the field above.", size.cols - 4),
    ...[LOOKUP_KEY_NOT_PERSON, LOOKUP_NO_ONE_TIME, LOOKUP_NODE_SEES]
      .flatMap((w) => note(w.full.join(" "), size.cols - 4).concat("")),
  ];
  // **SCROLLED, BECAUSE THE THIRD CAVEAT WAS FALLING OFF THE FRAME.** Adding the lookup path put
  // this page over the height of an ordinary terminal, and what went off the bottom was
  // `LOOKUP_NODE_SEES` — who learns that you looked. A page too full to show what it costs is the
  // failure this interface is built around, and the answer here is the one Status and Disclosure
  // already use rather than a shorter warning.
  //
  // `move` has been writing `m.scroll` on this page all along and nothing read it, so j/k did
  // nothing here. The count goes in the title for the reason Disclosure's does: an interface that
  // scrolls without saying so is one where the part below the fold is the part nobody knows about.
  const shown = lines.slice(Math.min(m.scroll, Math.max(0, lines.length - (height - 2))));
  return box(shown, {
    width: size.cols, height, focus: m.typing,
    title: `start a conversation${lines.length > height - 2 ? ` — ${m.scroll + 1}/${lines.length}` : ""}`,
  });
}

function identity(m: View, size: Size, height: number): string[] {
  const id = m.client?.identity ?? null;
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
    ...note(`${m.statePath}: ${(m.client?.lockedAtRest ? KEY_LOCKED : KEY_IN_CLEAR).full.join(" ")}`,
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
function record(m: View, size: Size, height: number): string[] {
  const anchored = Object.entries(m.client?.channels ?? {})
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

function disclosure(m: View, size: Size, height: number): string[] {
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

function status(m: View, size: Size, height: number): string[] {
  const s = m.client;
  const pending = s?.pending ?? [];
  const soon = [...pending].sort((a, b) => a.uploadAt - b.uploadAt).slice(0, 8);
  const at = (t: number) => (t <= m.now ? paint("due", "cyan") : `in ${Math.ceil((t - m.now) / 1000)}s`);
  const lines = [
    `${paint("state    ", "gray")}${m.statePath}`,
    `${paint("vault    ", "gray")}${s?.vaultUrl ?? "—"}`,
    /*
     * **TWO ROWS, BECAUSE ONE ROW LOST THE NODE ON EVERY REAL CLIENT.**
     *
     * This was `chain <contract> via <rpc>`. A Starknet address is 66 characters and the label is
     * 9, so the row is 123–125 on any real deployment and `box` cuts it to the pane width — at 80
     * columns the RPC arrived as `v…`. Measured against the live Sepolia install.
     *
     * **The half that fell off was the disclosing half.** `claims/src/setup.ts` describes the RPC
     * as deciding *"which node sees every read you make"*; the contract is the same for everyone
     * on a deployment and is recoverable from `hydra disclose`. So the row was spending its width
     * on the shared value and clipping the per-user one — and it was invisible to anyone
     * developing on a wide terminal, which is everyone.
     *
     * Split rather than truncated or reordered: each value fits its own row at 80 columns, so
     * neither is a judgement about which matters more. `screen.ts` has `truncate`, `wrap` and
     * `fit`, and this row was written without reaching for any of them.
     */
    `${paint("contract ", "gray")}${s?.contract || paint("(none — see below)", "yellow")}`,
    `${paint("node     ", "gray")}${s?.rpcUrl ?? "—"}`,
    // **A SLOW CLIENT THAT DOES NOT SAY IT IS SLOW READS AS A BROKEN ONE.** `fromBlock` is 0 with
    // a contract set exactly when the deployment-block discovery has not succeeded — the node was
    // unreachable at identity creation, or this file predates the discovery existing. Every read
    // then scans the chain from genesis: 178 RPC round trips and about 108 seconds, measured.
    // Derived from the state rather than recorded, so it cannot disagree with it, and it clears
    // itself the moment a discovery succeeds.
    // WRAPPED, NOT ONE LONG LINE. The first version of this was a single status row, and the box
    // truncated it at the terminal edge: the sentence naming the problem survived and the half
    // naming the remedy did not, which is a worse state than saying nothing. Caught by asserting
    // the remedy is on the page rather than that the warning is.
    ...(s?.contract && s.rpcUrl && s.fromBlock === 0
      ? wrap("reading from block 0 — every read scans the whole chain. the node did not answer; "
        + "restart to retry, or set it with `hydra init --from-block N`.", size.cols - 4)
        .map((l) => paint(l, "yellow"))
      : []),
    `${paint("route    ", "gray")}${s?.controlUrl ? `pool (${s.poolAccount || "alice"})` : "direct from your own account"}`,
    `${paint("invites  ", "gray")}${s?.invites ?? 0} left`,
    "",
    // **A BLOCKER IS NOT A VALUE, AND THIS PAGE USED TO DRAW THEM THE SAME.** `(unset)` and
    // `0 invites left` sat in the rows above at the weight of a fingerprint, so a client that
    // could not send one message looked configured. From `claims/src/setup.ts` via the `View`, so
    // the CLI, this page and the HTTP API cannot phrase the same gap three ways.
    ...(s?.gaps ?? []).flatMap((g) => [
      ...bullet(g.what, size.cols - 4,
        g.severity === "missing" ? paint("MISSING      ", "yellow") : paint("never chosen ", "gray")),
      ...note(g.why, size.cols - 6).map((l) => `  ${l}`),
      ...note(g.remedy, size.cols - 6).map((l) => `  ${l}`),
      "",
    ]),
    ...((s?.gaps ?? []).length ? note(RECONFIGURE, size.cols - 4) : []),
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

function setup(m: View, size: Size, height: number): string[] {
  const lines = [
    ...note("no identity yet. this creates one: a fresh vault root from OS randomness, twenty "
      + "one-time prekeys, and nothing else.", size.cols - 4),
    "",
    // SECTIONED, and the indices stay the real ones so Tab still walks the whole list in order.
    // The split is read from `later` on each entry rather than from a boundary written here — see
    // `FIELDS` in `model.ts` for why the marker is on the field and what it does NOT claim.
    ...FIELDS.setup.flatMap((f, i) => (f.later ? [] : field(m, i, f.key, f.label, size.cols))),
    "",
    paint("needed before your first message, not before this one", "bold"),
    ...note("nothing above sends anything: creating an identity is local and makes no request. "
      + "these four are what a send and an upload need, and leaving one blank fails then rather "
      + "than now.", size.cols - 4),
    ...FIELDS.setup.flatMap((f, i) => (f.later ? field(m, i, f.key, f.label, size.cols) : [])),
    "",
    ...note(`Enter writes ${m.statePath}. that file holds your root key in the clear. it is `
      + "mode 0600 and that is all the protection there is.", size.cols - 4),
  ];
  return box(lines, { width: size.cols, height, title: "first run", focus: m.typing });
}

/**
 * What the interface is, for someone who has just met it.
 *
 * **IT DESCRIBES THE INTERFACE AND NOT THE PRODUCT'S CLAIMS, and that split is the point.** Every
 * page in this client already carries the cost of what it does next to the button that does it —
 * this file's header says so — and Disclosure (5) is generated from the code that makes it true.
 * A help screen that restated any of that would be a second, hand-written copy of sentences whose
 * whole value is that nobody wrote them by hand. So this points at them and says nothing they say.
 *
 * **THE PURPOSES ARE A `Record<Page, …>`, WHICH IS THE `initialFields` LESSON APPLIED.** A page
 * added to `PAGES` with no line here is a type error rather than a help screen that has quietly
 * stopped listing a page — which is the failure `usage()` in `cli.ts` had, where a hardcoded
 * `slice(3, 30)` dropped four commands off the only place a user finds out they exist. The order
 * comes from `PAGES` for the same reason: two lists agreeing by hand is two lists.
 */
const PURPOSE: Record<Page, string> = {
  chats: "read and write. Enter sends, `s` switches between deniable and signed before you do.",
  connect: "start a conversation. you need their bundle file; Enter delivers your half through "
    + "the vault, so only one file ever changes hands.",
  identity: "your fingerprint, to read aloud to the person you are talking to by some other "
    + "means. `R` destroys the current prekey and mints fresh ones.",
  record: "publish your signing key at a Starknet address, or check that someone else's matches "
    + "what you handshook with.",
  disclosure: "what every party involved can see. generated from the code, not written; `c` "
    + "shows what each line is generated from.",
  status: "where this client is pointed, and what it is about to upload. the queue moves on a "
    + "clock rather than on your command.",
};

function helpBody(m: View, size: Size, height: number): string[] {
  const inner = size.cols - 4;
  const row = (keys: string, what: string) =>
    bullet(what, inner, paint(fit(keys, 16), "bold"));
  const lines = [
    paint("getting around", "bold"),
    ...row("1-6", "go straight to a page"),
    ...row("[  ]", "previous page, next page"),
    ...row("?", "this screen. any key puts it away and gives you back the page underneath"),
    ...row("q  ctrl-c", "quit. nothing is left running"),
    "",
    paint("typing", "bold"),
    ...note("THIS INTERFACE IS MODAL. letters do things until you press `i`, and type until you "
      + "press Esc. that is why `q` can be a key at all.", inner),
    ...row("i", "start typing into the highlighted field"),
    ...row("Esc", "stop typing"),
    ...row("Tab  shift-Tab", "move between the fields on the page"),
    ...row("Enter", "the page's one action — the footer at the bottom names it"),
    "",
    paint("the pages", "bold"),
    ...PAGES.flatMap((p, i) => bullet(PURPOSE[p.id], inner, paint(fit(`${p.label} (${i + 1})`, 16), "cyan"))),
    "",
    paint("what it does while you are not looking", "bold"),
    ...note("this client stays running because it has to: uploads are scheduled for a jittered "
      + "moment after the chain event, and a client that only ran when you typed would send a "
      + "message and all of its cover in one burst. the top right corner says what it is doing "
      + "and Status (6) says what is queued.", inner),
  ];
  // Clamped so `j` cannot scroll the screen into nothing: `slice` past the end returns [], and a
  // help screen that can be paged into a blank box is a help screen that looks broken.
  const top = Math.min(m.helpScroll, Math.max(0, lines.length - (height - 2)));
  return box(lines.slice(top), {
    width: size.cols, height,
    title: `help — what the keys do${top ? ` · ${top + 1}/${lines.length}` : ""}`,
    focus: true,
  });
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
function confirmBody(m: View, size: Size, height: number): string[] {
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

const PAGE_BODY: Record<Page | "setup", (m: View, size: Size, height: number) => string[]> = {
  setup, chats, connect, identity, record, disclosure, status,
};

/** The lines of one frame. `main.ts` is what turns these into a write. */
export function render(m: View, size: Size): string[] {
  const head = nav(m, size.cols);
  const right = activity(m);
  const header = fit(head, Math.max(0, size.cols - width(right) - 1)) + " " + right;

  const bodyHeight = Math.max(6, size.rows - 4);
  // Help sits OVER the page and `confirm` sits over both. A consent dialog is the one thing on
  // screen that must not be displaceable by a reminder — see the dismissal rule in `app.ts`.
  const body = m.confirm ? confirmBody(m, size, bodyHeight)
    : m.help ? helpBody(m, size, bodyHeight)
      : PAGE_BODY[m.page](m, size, bodyHeight);

  const last = m.log[m.log.length - 1];
  const tone = last?.tone === "bad" ? "red" : last?.tone === "warn" ? "yellow" : "gray";
  const line = paint(truncate(last ? last.text : "", size.cols), tone as "gray");

  const keys = m.confirm ? "y confirm · any other key cancels"
    : m.help ? "any key returns to the page underneath · j/k scroll"
      : KEYS[m.page];
  return [header, ...body, line, paint(truncate(keys, size.cols), "gray")];
}

/** What gets written to the terminal. */
export const screen = (m: View, size: Size): string => frame(render(m, size), size.rows);
