/**
 * The site cannot say more than the software does, and cannot say less either.
 *
 * A marketing page is where an over-claim gets written by somebody who was not in the room when
 * the number was measured. This project's standing rule is that privacy claims are computed and
 * never asserted, so the rule is enforced here in both directions:
 *
 *   - the page may not contain a claim the statement does not produce, and
 *   - it may not omit one the statement does. Dropping the uncomfortable half of a disclosure
 *     table is the same lie as inventing a guarantee, and it is the easier one to commit.
 *
 * Plus the invariant `claude-docs/docs/FRONTEND-SCAFFOLD.md` asked for. It wanted a check that
 * `web/package.json` never lists the identity or vault-client packages, so I6 cannot be violated
 * in a browser. The check here is stronger and simpler: **the site ships no JavaScript**. A page
 * with no code cannot hold a key by any route, including the ones nobody thought to guard.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { page } from "../build.ts";
import { SITE } from "../content.ts";
import { statement } from "../../hydra-dapp/packages/claims/src/statement.ts";

const html = page();

/** The prose a person wrote, with every generated block removed. */
const handWritten = html.replace(/<section data-generated="[^"]*">[\s\S]*?<\/section>/g, "");

test("the site ships no JavaScript, which is I6 as a property of the artifact", () => {
  assert.ok(!/<script/i.test(html), "a <script> tag reached the marketing site");
  assert.ok(!/\son\w+=/i.test(html), "an inline event handler reached the marketing site");
  assert.ok(!/javascript:/i.test(html));
});

test("nothing is fetched from anywhere else, on a page about who can see what", () => {
  // A webfont, an analytics tag or a CDN stylesheet is a request to a third party made by every
  // visitor to a page whose whole subject is which third parties can see what. The only external
  // URLs allowed are the ones the footer links to, which a reader chooses to follow.
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const external = urls.filter((u) => /^(https?:)?\/\//.test(u));
  const declared = new Set(SITE.links.map((l) => l.href));
  for (const u of external) {
    assert.ok(declared.has(u), `${u} is fetched or linked and is not one of the declared links`);
  }
  assert.ok(!urls.some((u) => u.endsWith(".js")));
});

test("every claim the statement makes is on the page", () => {
  // The direction that matters most. A site can be made to look excellent by publishing the
  // seven things nobody can see and quietly dropping the twenty-eight things they can.
  const s = statement();
  const all = [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee];
  const text = html.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  for (const claim of all) {
    assert.ok(text.includes(claim.says),
      `the statement says "${claim.says.slice(0, 60)}…" and the site does not`);
    assert.ok(text.includes(claim.from),
      `"${claim.says.slice(0, 40)}…" is on the page without the source that makes it checkable`);
  }
  assert.equal(all.length, 43, "the statement changed size; confirm the page still carries all of it");
});

test("the hand-written prose makes no privacy claim of its own", () => {
  for (const word of SITE.forbidden) {
    assert.ok(!handWritten.toLowerCase().includes(word),
      `"${word}" appears in prose a person wrote — if it is true, generate it from the thing `
      + "that makes it true; if it is not, do not say it");
  }
  // And the words that ARE allowed are allowed because they are attached to a measurement: the
  // generated sections quote percentages, and those come from the tests that produced them.
  assert.match(html, /data-generated="statement"/);
});

test("the page says what it is not ready for, above what it can do", () => {
  // Ordering is a claim too. A "not ready" section below three screens of guarantees is a
  // disclaimer; above them it is a description.
  const warning = html.indexOf("What it is not ready for");
  const first = html.indexOf('data-generated="statement"');
  assert.ok(warning > 0 && warning < first,
    "the limitations moved below the guarantees, which turns them into small print");
  for (const line of SITE.notYet) assert.ok(html.includes(line.replace(/'/g, "&#39;")) || html.includes(line));
});

test("content is escaped, so a claim containing markup cannot become markup", () => {
  const s = statement();
  const risky = [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee]
    .filter((c) => /[<>&]/.test(c.says));
  for (const c of risky) {
    assert.ok(!html.includes(c.says), `"${c.says.slice(0, 40)}…" reached the page unescaped`);
  }
});
