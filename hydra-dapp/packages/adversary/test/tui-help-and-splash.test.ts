/**
 * The help overlay and the Chats splash — the two things added for a user who has just arrived.
 *
 * Both are affordances rather than behaviour, which is the reason they need a test rather than the
 * reason they do not: an affordance that is silently truncated, or that quietly stops listing a
 * page, fails in the one direction nobody notices — the person who needed it did not know it was
 * there, so they do not report it missing.
 *
 * `FRONT-END-PARITY-INVENTORY.md` used to say the TUI's help was *"its six pages and its key
 * footer"*. That row is now reversed: a per-page footer is a reminder, not a help affordance, and
 * a user who does not know a page exists cannot be told about it by that page's footer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { render } from "../../tui/src/view.ts";
import { width } from "../../tui/src/screen.ts";
import { start, update, viewOf, PAGES } from "../../tui/src/app.ts";
import type { Model } from "../../tui/src/app.ts";
import type { Key } from "../../tui/src/keys.ts";
import { SIGNED, DENIABLE, KEY_IN_CLEAR } from "../../claims/src/warnings.ts";
import { init, openAndSend } from "../../cli/src/commands.ts";
import type { State } from "../../cli/src/state.ts";

const SIZE = { rows: 40, cols: 100 };

const fresh = (): State => init({ vaultUrl: "http://127.0.0.1:1", contract: "0x1", fromBlock: 1 });
const press = (m: Model, key: Key): Model => update(m, { t: "key", key }).model;
const ch = (value: string): Key => ({ t: "char", value });
const frameOf = (m: Model, size = SIZE): string =>
  render(viewOf(m), size).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

test("`?` OPENS HELP FROM COMMAND MODE, AND ANY KEY GIVES THE PAGE BACK", () => {
  const state = fresh();
  const on = press({ ...start(state, 0), state, page: "status" }, ch("?"));
  assert.equal(on.help, true, "`?` did not open help");
  assert.match(frameOf(on), /help — what the keys do/, "help is open but not drawn");

  const off = press(on, ch("x"));
  assert.equal(off.help, false, "an unbound key did not dismiss help");
  assert.equal(off.page, "status", "dismissing help did not return to the page underneath");
});

test("HELP DOES NOT MOVE THE PAGE UNDERNEATH WHEN IT SCROLLS", () => {
  // The reason `helpScroll` exists rather than reusing `scroll`. Status and Disclosure both scroll,
  // and help is drawn over them — so sharing one offset means reading help silently scrolls the
  // page you came from, which the user finds on dismissing and cannot explain. Point `helpScroll`
  // at `scroll` in `app.ts` and this fails.
  const state = fresh();
  const base = { ...start(state, 0), state, page: "status" as const, scroll: 4 };
  let m = press(base, ch("?"));
  m = press(m, ch("j"));
  m = press(m, ch("j"));
  assert.equal(m.helpScroll, 2, "j did not scroll help");
  assert.equal(m.scroll, 4, `help scrolled the page underneath to ${m.scroll}`);
  assert.equal(press(m, ch("x")).scroll, 4, "the page's own scroll did not survive help");
});

test("HELP CANNOT BE SCROLLED INTO A BLANK BOX", () => {
  // `slice` past the end returns [], and a help screen that pages into an empty rectangle looks
  // broken rather than finished. The clamp is in `helpBody`.
  const state = fresh();
  let m = press({ ...start(state, 0), state }, ch("?"));
  for (let i = 0; i < 200; i++) m = press(m, ch("j"));
  const frame = frameOf(m);
  assert.match(frame, /the pages|what it does while you are not looking/,
    "help scrolled past its own content and drew an empty box");
});

test("`?` TYPES A QUESTION MARK WHILE TYPING, RATHER THAN OPENING HELP", () => {
  // This interface is modal and the whole point of that is that letters type when you are typing.
  // A help key that punched through the mode would be the one key that does not obey it.
  const state = fresh();
  const typing = { ...start(state, 0), state, typing: true };
  const after = press(typing, ch("?"));
  assert.equal(after.help, false, "`?` opened help from typing mode");
  assert.equal(after.fields.compose, "?", "`?` did not reach the field");
});

test("HELP LISTS EVERY PAGE, AND CANNOT QUIETLY STOP", () => {
  // `usage()` in `cli.ts` had exactly this failure: a hardcoded `slice(3, 30)` dropped four
  // commands off the only place a user finds out they exist. Here the list is a `Record<Page, …>`
  // driven by `PAGES`, so a new page is a type error — this asserts the rendering, not the type.
  const state = fresh();
  const frame = frameOf(press({ ...start(state, 0), state }, ch("?")), { rows: 80, cols: 100 });
  for (const [i, p] of PAGES.entries()) {
    assert.ok(frame.includes(`${p.label} (${i + 1})`),
      `help does not mention ${p.label} (${i + 1}), so that page is undiscoverable from it`);
  }
});

test("HELP DESCRIBES THE INTERFACE AND DOES NOT RESTATE THE CLAIMS", () => {
  // The claims have generated homes — `claims/src/warnings.ts` and the Disclosure page, which is
  // built from the code that makes it true. A hand-written second copy on a help screen is a copy
  // that drifts, and its whole value is that nobody wrote it by hand.
  const state = fresh();
  const frame = frameOf(press({ ...start(state, 0), state }, ch("?")), { rows: 80, cols: 100 });
  // FILTERED, AND THE FIRST VERSION WAS NOT. `KEY_IN_CLEAR.full` carries an empty string as a
  // paragraph break, and `"anything".includes("")` is true — so a "does not contain" check over a
  // list with a blank in it fails on every input, including the correct one. A needle that matches
  // everything is not a strict guard, it is a broken one, and it reported a claim of `"…"`.
  const claims = [SIGNED.short, DENIABLE.short, ...KEY_IN_CLEAR.full].filter((c) => c.length > 20);
  assert.ok(claims.length >= 3, "the claim list is too thin for this to be measuring anything");
  for (const claim of claims) {
    assert.ok(!frame.includes(claim),
      `help restates a generated claim verbatim: "${claim.slice(0, 60)}…". It should point at `
      + "Disclosure (5) instead");
  }
  assert.match(frame, /Disclosure \(5\)/, "help never points at where the claims actually live");
});

test("EVERY FOOTER STILL ADVERTISES `? help` AFTER TRUNCATION AT 80 COLUMNS", () => {
  // **THE ORDERING IS THE ASSERTION.** The Chats footer was 79 columns before help existed, so
  // appending `? help` would have put the one key that finds everything else past the right edge
  // at the width most terminals open at. `effects.ts` states the rule: truncation eats the tail,
  // so the tail has to be what you can afford to lose. Move `? help` to the end of any KEYS entry
  // and this fails for Chats.
  const state = fresh();
  for (const page of [...PAGES.map((p) => p.id), "setup" as const]) {
    const m = page === "setup"
      ? { ...start(null, 0), page }
      : { ...start(state, 0), state, page };
    const lines = render(viewOf(m as Model), { rows: 24, cols: 80 });
    const footer = lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(footer.includes("? help"),
      `the ${page} footer loses "? help" at 80 columns: "${footer}"`);
    assert.ok(width(lines[lines.length - 1]) <= 80, `the ${page} footer overflows 80 columns`);
  }
});

test("THE MARK IS DRAWN UNTIL THERE IS A CONVERSATION, AND THE AFFORDANCE SURVIVES IT", async () => {
  const state = fresh();
  const empty = frameOf({ ...start(state, 0), state, page: "chats" });
  // The glyph is a dash and the mark is a broad block of them, so a run this long cannot come from
  // a box border (those are `─`) or from any prose on the page.
  assert.match(empty, /-{12,}/, "the Chats page draws no mark when there are no channels");
  assert.ok(empty.includes("no channels yet. open one on Connect (2)."),
    "the splash replaced the only affordance on the page instead of sitting above it");

  // One channel, and the pane has something truer to draw than a decoration.
  await openAndSend(state, "alice", JSON.parse(JSON.stringify(
    (await import("../../cli/src/commands.ts")).publishBundle(fresh(), 0),
    (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v))) as never,
    (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch)
    .catch(() => {/* the vault is not the subject; a channel in state is */});
  state.channels.alice ??= { peerSigningKeyHex: "00", anchor: null } as never;
  const opened = frameOf({ ...start(state, 0), state, page: "chats" });
  assert.ok(!/-{12,}/.test(opened),
    "the mark is still drawn once a channel exists — it should give the pane to the conversation");
});
