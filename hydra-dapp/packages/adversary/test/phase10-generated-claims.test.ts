/**
 * Phase 10 — the disclosure statement is generated, and says nothing it cannot compute.
 *
 * `HYDRA_HANDOFF.md` Phase 10 and standing rule §4: privacy claims are computed, never
 * asserted; if it cannot be computed, the product does not say it.
 *
 * A generator satisfies that only if it actually tracks the things it claims to. So these
 * checks are mostly adversarial towards the statement itself: every claim must cite a real
 * file, every measured number must equal the constant it came from, the uncomfortable
 * disclosures must be present, and the reassuring vocabulary a hand-written statement drifts
 * into must be absent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

import { statement, render, MEASURED } from "../../claims/src/statement.ts";
import { OBSERVABLE, DERIVABLE, NOT_OBSERVABLE } from "../../vault-server/src/observations.ts";
import { MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";
import { COVER_RATE } from "../../channel/src/cover.ts";
import { NOTE_FELTS } from "../../channel/src/note.ts";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const s = statement();
const all = [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee];

test("every claim cites a source file that exists", () => {
  // A claim whose provenance is a path nobody can open is a hand-written claim with a citation
  // stapled to it.
  for (const claim of all) {
    const files = [...claim.from.matchAll(/([\w./-]+\.(ts|md))/g)].map((m) => m[1]);
    assert.ok(files.length > 0, `no source cited for: ${claim.says}`);
    for (const f of files) {
      const candidates = [join(PACKAGES, f), join(PACKAGES, "..", "..", "claude-docs", f.replace(/^claude-docs\//, "")),
                          join(PACKAGES, "adversary", "test", f), join(PACKAGES, "..", "..", f)];
      assert.ok(candidates.some(existsSync), `${f} cited by "${claim.says.slice(0, 60)}…" does not exist`);
    }
  }
});

test("the statement covers every row of the disclosure table, both columns", () => {
  // The generator must not be able to quietly omit a disclosure. If a row exists, it is said.
  // Coverage is asserted row by row rather than by a count, so adding a row to the table
  // fails here instead of silently changing an arithmetic expectation.
  for (const o of OBSERVABLE) {
    assert.ok(s.whoCanSeeWhat.some((c) => c.says.includes(o.what)), `${o.id} is not stated`);
  }
  // The third table too, and it is the one most likely to be forgotten: nothing in the vault's
  // record produces these, so no capture test would notice their absence either.
  for (const d of DERIVABLE) {
    const said = s.whoCanSeeWhat.find((c) => c.says.includes(d.what));
    assert.ok(said, `${d.id} is derivable and not stated`);
    assert.ok(said!.says.includes(d.given),
      `${d.id} is stated without saying what an observer needs to hold to work it out`);
  }
  for (const o of NOT_OBSERVABLE) {
    assert.ok(s.whatWeCannotSee.some((c) => c.says.includes(o.what)), `${o.id} is not stated`);
  }
  assert.equal(s.whatWeCannotSee.length, NOT_OBSERVABLE.length);
  // The chain and the pool's auditor are disclosures the vault's table does not cover, and
  // they are the two most consequential ones. They must be stated on top of it.
  assert.ok(s.whoCanSeeWhat.length >= OBSERVABLE.length + DERIVABLE.length + 2,
    "the chain and the auditor are not stated beyond the vault's own table");
});

test("the numbers it quotes are the numbers the code runs on", () => {
  // Not copies. If a default moves, the statement moves with it in the same commit, or this
  // fails and someone has to decide which of the two is wrong.
  assert.equal(MEASURED.jitterBlocks, MIN_JITTER_BLOCKS);
  assert.equal(MEASURED.coverRate, COVER_RATE);
  assert.equal(MEASURED.noteFelts, NOTE_FELTS);
  // The published floor must be the one the rate actually buys, not a measured best case.
  assert.equal(MEASURED.isolatedMessageIdentified, 1 / (COVER_RATE + 1));
  assert.ok(MEASURED.clusteredMessageIdentified < MEASURED.isolatedMessageIdentified,
    "the clustered figure should be the better one; if not, the two are swapped");
  const text = render(s);
  assert.ok(text.includes(String(MIN_JITTER_BLOCKS)), "the jitter number is not in the output");
  assert.ok(text.includes(String(NOTE_FELTS)), "the on-chain footprint is not in the output");
});

test("the uncomfortable disclosures are present and unhedged", () => {
  // The three a hand-written statement would soften, drop, or move to a footnote. Each is the
  // conclusion of a decision record, and each is a reason someone might choose not to use this.
  const text = render(s).toLowerCase();
  assert.ok(text.includes("auditor can decrypt every message"),
    "the pool's escrow is not stated plainly");
  // Was "first message of a session" — that framing came from the span-based cover design,
  // where the leak was positional. Under per-event cover it is not about position at all: an
  // isolated message is exposed wherever it sits in the conversation, and the statement has to
  // say which case it is quoting.
  assert.ok(/one in five/.test(text), "the isolated-message floor is not stated in plain words");
  assert.ok(/quick succession/.test(text), "the statement does not say the figure depends on pace");
  assert.ok(/repeat within a conversation/.test(text),
    "deterministic encryption's repeat visibility is not stated");
});

test("a partial guarantee always carries its number", () => {
  // `complete: false` is the flag that says "this is qualified". A qualified claim that states
  // no boundary is one the reader will round up to a guarantee — so each must either carry a
  // figure or say plainly what it does NOT cover. Not every partial guarantee is numeric:
  // "the server can see a repeat within a conversation, not across them" is a scope, not a
  // measurement, and demanding a number there would invite a fabricated one.
  for (const claim of s.whatIsPartial) {
    assert.equal(claim.complete, false);
    assert.ok(/\d/.test(claim.says) || /\bnot\b/.test(claim.says),
      `partial claim states neither a figure nor a boundary: ${claim.says}`);
  }
  // And the reassuring half is not allowed to be qualified silently in the other direction.
  for (const claim of s.whatWeCannotSee) assert.equal(claim.complete, true);
});

test("the statement uses none of the vocabulary that means nothing", () => {
  // The words a privacy page reaches for when it has no measurement. Any of them appearing
  // here means someone wrote a claim instead of computing one.
  const banned = [
    "military-grade", "bank-level", "unbreakable", "完全", "absolutely secure",
    "we never", "we do not log", "your data is safe", "fully anonymous", "100%",
    "end-to-end encrypted and therefore", "trust us", "industry-standard",
  ];
  const text = render(s).toLowerCase();
  for (const phrase of banned) {
    assert.ok(!text.includes(phrase), `the statement says "${phrase}"`);
  }
});

test("the statement makes no promise about behaviour, only about capability", () => {
  // "We will not read your messages" is a promise; "we cannot" is a property. Only the second
  // survives a change of operator, a subpoena, or a sale — and only the second is computable.
  for (const claim of all) {
    assert.ok(!/\bwe (will|won't|will not|promise|pledge)\b/i.test(claim.says),
      `a promise rather than a property: ${claim.says}`);
  }
  // Which is why the operator is named as a role, not as us.
  assert.ok(render(s).includes("Whoever runs"));
});

test("a person can actually read it, without a wallet or an account", () => {
  // The statement was generated, tested, and rendered nowhere. A disclosure a user cannot get
  // to is a disclosure that exists for the test suite. `hydra disclose` prints it, and this
  // check runs the real command — with no state directory, because someone deciding whether to
  // use the thing has not set it up yet.
  const cli = join(HERE, "..", "..", "cli", "src", "cli.ts");
  const out = execFileSync(process.execPath, [cli, "disclose"], {
    encoding: "utf8",
    env: { ...process.env, HYDRA_HOME: join(HERE, "does-not-exist") },
  });
  for (const row of [...OBSERVABLE, ...DERIVABLE]) {
    assert.ok(out.includes(row.what), `${row.id} is on the table and not in what a user reads`);
  }
  for (const g of NOT_OBSERVABLE) {
    assert.ok(out.includes(g.what), `${g.id} is on the table and not in what a user reads`);
  }
  // And it says what it is, so nobody mistakes a computed list for a marketing page.
  assert.match(out, /generated from the code that makes it true/);
  assert.match(out, /Nothing here is a promise about what anyone will do/);
});

test("render is deterministic and lists everything", () => {
  assert.equal(render(statement()), render(statement()));
  const lines = render(s).split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, all.length);
});
