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
  // block 0, a read that scans the whole chain forever, and nothing connecting the two.
  //
  // The CLI printed three lines for this before the move into `commands.ts`, and the move dropped
  // them. Restoring them in `cli.ts` alone would rebuild the asymmetry this whole file is about,
  // which is why the assertion is over both surfaces rather than over the one that regressed.
  for (const [i, { name }] of FRONT_ENDS.entries()) {
    const code = codeOf(readFileSync(FRONT_ENDS[i]!.file, "utf8"));
    const init = i === 0
      ? code.slice(code.indexOf('case "init"'), code.indexOf('case "bundle"'))
      : code.slice(code.indexOf('effect.t === "init"'), code.indexOf("if (!state)"));
    assert.match(init, /scans? the whole chain/,
      `${name} creates an identity, fails to reach the node, and says nothing about it — so the `
      + "user gets a client that reads the whole chain on every read and no sentence anywhere "
      + "saying why. That reads as broken rather than as misconfigured, and only one of those "
      + "gets reported");
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
