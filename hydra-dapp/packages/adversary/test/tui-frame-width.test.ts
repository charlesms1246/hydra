/**
 * No line of a frame is ever wider than the terminal, at any width, on any page.
 *
 * ## THIS TEST IS THE PRICE OF `\x1b[?7l`
 *
 * `screen.ts` turns autowrap OFF for the alternate screen, because a terminal that reports one
 * more column than it can draw folds every bordered row into a continuation line with no right
 * border — reported by a user, and not reproducible at any width from this side, because the
 * mismatch is between what the terminal SAYS and what it can DRAW.
 *
 * **That fix converts a visible failure into an invisible one.** With autowrap on, a line wider
 * than `cols` folds where you can see it. With it off, the terminal silently drops the overflow
 * at the right margin — so a renderer that started producing over-wide lines would look fine and
 * quietly lose characters off the end of every row. **This file is the signal that replaces the
 * one that was removed.** `screen.ts` says not to keep that line without this test; this is that
 * test, and the two must land and stay together.
 *
 * ## WHY EVERY WIDTH RATHER THAN A FEW
 *
 * Every wrap, truncate and box computation here is arithmetic on `cols` — `Math.floor(cols / 4)`,
 * `Math.min(26, Math.max(16, …))`, `cols - listWidth - 4`. Those are exactly the expressions that
 * are right at 80 and off by one at 81, so sampling widths samples the bug out. The sweep is
 * ~42,000 assertions and runs in well under a second, because `render` touches no clock, no
 * environment and no disk.
 *
 * ## THE SECOND NUMBER IS THE DIAGNOSIS AND IT IS ASSERTED ON PURPOSE
 *
 * Not being over-wide is only half of what was measured. The other half is that the frame is drawn
 * to the LAST COLUMN on the overwhelming majority of its rows — there is no margin anywhere to
 * absorb a terminal's off-by-one, which is why the remedy had to be a terminal mode rather than a
 * column of padding. A floor is asserted so that this file states the condition the fix rests on
 * rather than only its absence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { render } from "../../tui/src/view.ts";
import { width, ALT_SCREEN_ON, ALT_SCREEN_OFF } from "../../tui/src/screen.ts";
import { start, viewOf } from "../../tui/src/app.ts";
import { PAGES } from "../../tui/src/model.ts";
import type { Page, View } from "../../tui/src/model.ts";
import { init } from "../../cli/src/commands.ts";
import type { State } from "../../cli/src/state.ts";

const MIN = 40;
const MAX = 300;

const fresh = (): State => init({ vaultUrl: "http://127.0.0.1:1", contract: "0x1", fromBlock: 1 });

/**
 * Every screen the interface can be showing, including the two that are not pages.
 *
 * `setup`, help and a confirm are drawn by `render` and reached by none of the six digits, so a
 * sweep over `PAGES` alone would miss three of the nine things a user can be looking at — and
 * `confirmBody` is the one whose whole purpose is showing a long sentence in full.
 */
function screens(): { readonly name: string; readonly view: View }[] {
  const state = fresh();
  const base = { ...start(state, 0), state };
  const out = [{ name: "setup", view: viewOf({ ...start(null, 0), page: "setup" as const }) }];
  for (const p of PAGES) out.push({ name: p.id, view: viewOf({ ...base, page: p.id as Page }) });
  out.push({ name: "help", view: viewOf({ ...base, help: true }) });
  out.push({
    name: "confirm",
    view: viewOf({
      ...base,
      confirm: {
        question: "destroy the current prekey private? anyone who fetched your old bundle and has "
          + "not been collected can no longer reach you.",
        label: "rotate",
        effect: { t: "rotate" },
      },
    }),
  });
  return out;
}

test("NO FRAME IS EVER WIDER THAN THE TERMINAL, 40 TO 300 COLUMNS", () => {
  const all = screens();
  // The sweep is only worth what it covers, and "every page" is a claim about a list that grows.
  assert.equal(all.length, PAGES.length + 3,
    "screens() no longer covers every page plus setup, help and a confirm");

  let total = 0;
  const over: string[] = [];
  for (let cols = MIN; cols <= MAX; cols++) {
    for (const { name, view } of all) {
      for (const line of render(view, { rows: 24, cols })) {
        total++;
        const w = width(line);
        if (w > cols) over.push(`${name} at ${cols} cols drew a line of ${w}`);
      }
    }
  }

  assert.deepEqual(over.slice(0, 5), [],
    `${over.length} line(s) exceed the terminal width — with autowrap off these are silently cut `
    + "at the right margin rather than folded, so nothing on screen would show it");
  // A sweep that rendered nothing would report zero overflows and pass. Floor, not equality: the
  // count moves whenever a page gains a row, and pinning it would make this fail for the wrong
  // reason on every unrelated edit.
  assert.ok(total > 20_000, `the sweep only measured ${total} lines, so it proves little`);
});

test("AND THE FRAME IS DRAWN TO THE LAST COLUMN, WHICH IS WHY THE FIX IS A TERMINAL MODE", () => {
  const all = screens();
  let total = 0;
  let exact = 0;
  for (let cols = MIN; cols <= MAX; cols++) {
    for (const { view } of all) {
      for (const line of render(view, { rows: 24, cols })) {
        total++;
        if (width(line) === cols) exact++;
      }
    }
  }
  // Measured at 92% when `?7l` was added. The floor is well under that: the assertion is "there is
  // no margin", not a percentage anybody should be defending.
  assert.ok(exact / total > 0.6,
    `only ${((exact / total) * 100).toFixed(1)}% of lines reach the last column. If the frame has `
    + "gained a margin, `\\x1b[?7l` in `screen.ts` is no longer paying for itself and the comment "
    + "there is no longer true");
});

test("THE ALTERNATE SCREEN TURNS AUTOWRAP OFF, AND GIVES IT BACK", () => {
  assert.ok(ALT_SCREEN_ON.includes("\x1b[?7l"),
    "autowrap is not disabled, so a terminal reporting one column too many folds every row");
  // The half that is easy to drop. A shell left with DECAWM off wraps nothing at all, so a long
  // command line overwrites itself in place — the program would be corrupting a terminal it no
  // longer owns, on every exit including a crash.
  assert.ok(ALT_SCREEN_OFF.includes("\x1b[?7h"),
    "autowrap is never restored, so quitting leaves the user's shell unable to wrap");
});
