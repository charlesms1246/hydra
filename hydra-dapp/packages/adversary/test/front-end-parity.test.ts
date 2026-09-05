/**
 * Things both front ends must do, asserted structurally.
 *
 * **THE RESIDENT CLIENT READ FROM BLOCK 0 FOREVER AND NOTHING NOTICED.** `repairFromBlock` lived in
 * `cli.ts` and was called from two places in that file; `packages/tui/src/` contained the string
 * `fromBlock` **nowhere at all**. So the CLI had been repairing itself since the fix landed and the
 * surface `0022` makes primary had not.
 *
 * Measured on Sepolia against a genuinely TUI-created state, before and after:
 *
 *     fromBlock 0           108,060 ms   178 RPC round trips
 *     fromBlock 14,319,650    1,914 ms     3 RPC round trips
 *
 * **This is the exact defect `chain.ts`'s header describes**, one function over: *there are now two
 * front ends, and a TUI that picked differently would give the same user two different disclosures.*
 * `chainFor` was moved to shared code for that reason. `repairFromBlock` was the same shape and was
 * not, so the fix reached one surface and the fault survived on the other.
 *
 * The fix is placement, not a second call site: `ensureFromBlock` lives in `commands.ts`, which both
 * front ends already import. **This file is the part that stops it drifting apart again** — it
 * asserts against source text rather than behaviour, because the failure was a call that was never
 * written and no behavioural test can assert the absence of an omission it does not know about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { codeOf } from "../src/prose.ts";
import { assertScansEveryFile } from "../src/scan.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

/** The two surfaces a user can drive. Adding a third puts it here. */
const FRONT_ENDS = [
  { name: "cli", file: join(PACKAGES, "cli", "src", "cli.ts") },
  { name: "tui", file: join(PACKAGES, "tui", "src", "effects.ts") },
];

test("THE INSTRUMENT BEFORE THE FINDING — every front-end source is readable", () => {
  assertScansEveryFile(join(PACKAGES, "cli", "src"), assert);
  assertScansEveryFile(join(PACKAGES, "tui", "src"), assert);
});

test("BOTH FRONT ENDS REPAIR fromBlock — the CLI-only fix that left the TUI at 108 seconds", () => {
  for (const { name, file } of FRONT_ENDS) {
    const code = codeOf(readFileSync(file, "utf8"));
    assert.match(code, /\bensureFromBlock\s*\(/,
      `${name} never calls ensureFromBlock, so a state file it creates reads from block 0 — 178 RPC `
      + "round trips and about 108 seconds per read, permanently, against a real chain");
  }
});

test("neither front end reimplements the discovery instead of calling the shared one", () => {
  // The other way this drifts: a front end that grows its own copy passes the check above while
  // being free to diverge. `deploymentBlock` and `blockHeight` belong to `commands.ts` now.
  for (const { name, file } of FRONT_ENDS) {
    const code = codeOf(readFileSync(file, "utf8"));
    assert.ok(!/\bdeploymentBlock\s*\(/.test(code),
      `${name} calls deploymentBlock directly rather than going through ensureFromBlock, which is `
      + "how the two front ends start disagreeing again");
    assert.ok(!/\bblockHeight\s*\(/.test(code), `${name} calls blockHeight directly`);
  }
});

test("the repair is reachable from identity creation, not only from reading", () => {
  // hydra-45's point, and it is the one that matters: repairing on read would leave a narrower
  // version of the same asymmetry — a TUI-created state wrong until something happened to fix it.
  // Both front ends must call it where the identity is made.
  const cli = codeOf(readFileSync(FRONT_ENDS[0]!.file, "utf8"));
  const tui = codeOf(readFileSync(FRONT_ENDS[1]!.file, "utf8"));

  const cliInit = cli.slice(cli.indexOf('case "init"'), cli.indexOf('case "bundle"'));
  assert.match(cliInit, /ensureFromBlock/,
    "the CLI creates an identity without discovering the deployment block");

  const tuiInit = tui.slice(tui.indexOf('effect.t === "init"'), tui.indexOf('if (!state)'));
  assert.match(tuiInit, /ensureFromBlock/,
    "the TUI creates an identity without discovering the deployment block, so a state file made "
    + "on that surface starts life reading the whole chain");
});

test("BOTH FRONT ENDS SAY SO WHEN DISCOVERY FAILS — the diagnostic the refactor dropped", () => {
  // `ensureFromBlock` is never fatal, so a node that blinked for one second at identity creation
  // is SILENT unless a front end chooses to speak — and the user is left with a state file at
  // block 0, a read that scans the whole chain forever, and nothing connecting the two. The CLI
  // printed three lines for this before the move into `commands.ts`; the move dropped them.
  //
  // **THE TWO SURFACES SAY IT DIFFERENTLY AND THAT IS NOT A PARITY FAILURE.** A CLI writes as
  // many lines of stderr as it likes. A TUI's log is ONE ROW, truncated at the terminal width —
  // driving the real thing through a pty at 100 columns turned the long version into "…but the
  // node did not answer (fetc…", the problem named and the remedy cut off, which is worse than
  // silence. So the TUI points at the page that wraps, and what is asserted here is the property
  // rather than the wording: neither surface is silent, and each names somewhere to go.
  const SAYS = [
    { i: 0, condition: /scans? the whole chain/, remedy: /--from-block/ },
    { i: 1, condition: /node unreachable/, remedy: /Status/ },
  ];
  for (const { i, condition, remedy } of SAYS) {
    const { name, file } = FRONT_ENDS[i]!;
    const code = codeOf(readFileSync(file, "utf8"));
    const init = i === 0
      ? code.slice(code.indexOf('case "init"'), code.indexOf('case "bundle"'))
      : code.slice(code.indexOf('effect.t === "init"'), code.indexOf("if (!state)"));
    assert.match(init, condition,
      `${name} creates an identity, fails to reach the node, and says nothing about it — so the `
      + "user gets a client that reads the whole chain on every read and no sentence anywhere "
      + "saying why. That reads as broken rather than as misconfigured, and only one of those "
      + "gets reported");
    assert.match(init, remedy,
      `${name} names the problem and no remedy, which leaves the user knowing something is wrong `
      + "and having nowhere to go with it");
  }
});

test("NEITHER FRONT END REPORTS AN ANCHOR MATCH WITHOUT SAYING WHAT IT DOES NOT PROVE", () => {
  // Driven on Record (4) against a really published record. At 100 columns the TUI showed:
  //
  //   from-9c8e3079b19a's signing key is published at 0x2afa2039a4173a1c327f6bb87d49bac815c5c…
  //
  // and the qualification that followed — "which does not say the address is the person you
  // mean" — started past column 110, because a Starknet address is 66 characters. **It appeared
  // at no width.** The reader got a positive attribution claim and none of its limit.
  //
  // The CLI has always said it, in four lines of prose, because it has room. So this is not "one
  // surface is missing a sentence" — it is the same claim rendered on two surfaces where only one
  // has the space, and the TUI has to buy it with word order instead.
  for (const { name, file } of FRONT_ENDS) {
    const code = codeOf(readFileSync(file, "utf8"));
    const anchor = code.slice(code.indexOf('"anchor"'));
    assert.match(anchor.slice(0, 1200), /unproven|does not say|is still a fingerprint/,
      `${name} reports that a signing key matches a published record and never says what that `
      + "does not establish — who owns the address. A qualification the reader never sees makes "
      + "the check read as stronger than it is, which is the one direction this must not fail in");
  }
});

test("AND THE TUI PUTS THAT LIMIT BEFORE THE 66-CHARACTER ADDRESS", () => {
  // The ordering IS the fix, not the wording: the log is one row and truncation eats the tail, so
  // an address interpolated ahead of the caveat guarantees the caveat is never read. Asserted as
  // an order rather than a length, because the length that matters is the terminal's, not ours.
  // SCOPED TO THE MESSAGE, NOT THE CASE BODY. The first version searched the whole `case "anchor"`
  // block and found the `BigInt(effect.address)` on the line that does the verification, which
  // precedes the message and has nothing to do with what the reader sees. It failed against code
  // that was already correct — a search whose scope was wider than the property it was asserting,
  // for the third time today.
  const tui = codeOf(readFileSync(FRONT_ENDS[1]!.file, "utf8"));
  // Anchored to `anchorPeer(` — the verification call — because the success message is the only
  // `text:` after it. Slicing from `case "anchor"` found the FELT-COUNT ERROR message instead,
  // which is the second wrong scope this one assertion has had: a search that lands on something
  // real is not a search that landed on the thing you meant.
  const from = tui.indexOf("anchorPeer(");
  const body = tui.slice(from, from + 1500);
  const message = body.slice(body.indexOf("text:"), body.indexOf("};", body.indexOf("text:")));
  const limit = message.search(/unproven/);
  const address = message.search(/effect\.address/);
  assert.ok(limit >= 0 && address >= 0,
    `the anchor message no longer has both parts to order:\n  ${message}`);
  assert.ok(limit < address,
    "the TUI interpolates the address before the qualification, so at any real terminal width "
    + `the reader keeps the claim and loses the limit:\n  ${message}`);
});

test("BOTH FRONT ENDS DESCRIBE AN UNREACHABLE VAULT, and neither owns the sentence", () => {
  // **THE INVENTORY SAID THIS WAS SHARED AND IT WAS NOT.** `describeFailure` was module-private to
  // `tui/src/effects.ts`, so `cli.ts`'s `die()` printed `e.message` raw — same state, same command,
  // same dead vault, and the TUI named the host and the remedy while the CLI said `fetch failed`.
  // The row claimed "asserted over two effects" and both effects were the TUI's: two effects is
  // not two front ends.
  for (const { name, file } of FRONT_ENDS) {
    const code = codeOf(readFileSync(file, "utf8"));
    assert.match(code, /describeFailure\s*\(/,
      `${name} does not use the shared failure description, so an unreachable vault reads `
      + "differently depending on which front end the user happens to be in");
  }
  // AND NEITHER DEFINES IT. A second copy is the drift this row already suffered once.
  for (const { name, file } of FRONT_ENDS) {
    const code = codeOf(readFileSync(file, "utf8"));
    assert.ok(!/function describeFailure/.test(code),
      `${name} defines its own describeFailure rather than importing the shared one`);
  }
});

test("THE TUI INJECTS ITS FETCH — a front end that reaches the real network in tests", () => {
  // Caught by the suite going from seconds to minutes. `ensureFromBlock(next)` without
  // `deps.fetchImpl` used the global `fetch`, so the TUI's own tests started bisecting a live
  // chain. A dependency-injected front end that forgets to inject is a test suite that talks to
  // the internet, which is slow, flaky and occasionally a disclosure.
  const tui = codeOf(readFileSync(FRONT_ENDS[1]!.file, "utf8"));
  for (const call of tui.match(/ensureFromBlock\([^)]*\)/g) ?? []) {
    assert.match(call, /deps\.fetchImpl/,
      `${call} does not pass the injected fetch, so this path reaches the real network`);
  }
});
