/**
 * A fresh install says what it cannot do — on all three surfaces, from one source.
 *
 * **`hydra init` WITH NO FLAGS SUCCEEDS AND THE RESULT CANNOT SEND A MESSAGE.** It writes an
 * identity and prints a fingerprint; there is no contract and there are no invites. `status`
 * rendered both as ordinary values — `(unset)` and `0 invites left`, at the weight of a
 * fingerprint — so the only signal that the install was unusable was two strings that read like
 * settings. That is the family this suite keeps finding: **a state that reads as fine because
 * nothing named the condition**, the same as a queue whose payload was byte-identical whether the
 * vault was alive or dead.
 *
 * **THREE SURFACES IN ONE FILE ON PURPOSE.** The defect this repository has spent the week on is a
 * rule living in one front end. `setupGaps` is in `claims/src/setup.ts` precisely so the CLI's
 * printed block, the TUI's status page and the HTTP API cannot phrase one gap three ways — and a
 * test that checked only the CLI would let two of the three drift.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { setupGaps, RECONFIGURE, DEVNET_VAULT, DEVNET_RPC } from "../../claims/src/setup.ts";
import { init, gapsOf } from "../../cli/src/commands.ts";
import { render } from "../../tui/src/view.ts";
import { start, viewOf } from "../../tui/src/app.ts";
import type { State } from "../../cli/src/state.ts";

const fresh = (): State => init();
const configured = (): State => init({
  contract: "0x1", invites: ["a", "b"],
  vaultUrl: "http://vault.example", rpcUrl: "http://node.example",
});

test("A FRESH INSTALL REPORTS EXACTLY WHAT STOPS IT SENDING, AND WHAT NOBODY CHOSE", () => {
  const gaps = gapsOf(fresh());
  const missing = gaps.filter((g) => g.severity === "missing").map((g) => g.id).sort();
  const unchosen = gaps.filter((g) => g.severity === "unchosen").map((g) => g.id).sort();

  assert.deepEqual(missing, ["contract", "invites"],
    "a fresh `hydra init` does not report the two things that stop it sending");
  // **THE CATEGORY THAT WOULD NOT EXIST IN THE OBVIOUS MODEL.** `vaultUrl` and `rpcUrl` are NOT
  // empty — they hold devnet defaults — so a plain blocker list passes in silence over the two
  // fields that most look like working configuration and are not.
  assert.deepEqual(unchosen, ["rpc", "vault"],
    "the devnet defaults are not reported as unchosen, so they still read as settings");
});

test("A CONFIGURED INSTALL REPORTS NOTHING", () => {
  assert.deepEqual(gapsOf(configured()), [],
    "a fully configured client still reports gaps, so the check is unconditional and worthless");
});

test("EACH GAP SAYS WHERE THE THING COMES FROM, WHICH IS THE ONBOARDING MODEL", () => {
  // The sentence the product was missing entirely: the vault and the invites are the RECIPIENT's,
  // not yours. It is carried per gap rather than printed once as a banner, so a reader meets it at
  // the moment the thing is missing.
  const by = Object.fromEntries(gapsOf(fresh()).map((g) => [g.id, g]));
  assert.match(by.invites.why, /whoever you are contacting/,
    "the invites gap does not say where invites come from");
  assert.match(by.invites.why, /CANNOT MINT ITS OWN|admission control/,
    "the invites gap does not say why a client cannot issue its own");
  assert.match(by.vault.why, /RECIPIENT/,
    "the vault gap does not say whose infrastructure the vault is");
  for (const g of Object.values(by)) {
    assert.ok(g.what && g.why && g.remedy, `${g.id} is missing one of what/why/remedy`);
    // A remedy naming a command that does not exist is worse than none — no command changes any
    // of these after `init`, which is why the remedy is the state file.
    assert.doesNotMatch(g.remedy, /hydra (set|config|configure)\b/,
      `${g.id} points at a command this client does not have`);
  }
  assert.match(RECONFIGURE, /destroys your identity/,
    "the shared remedy does not say what re-running `hydra init` would cost");
});

test("THE TUI STATUS PAGE DRAWS THEM, AND NOT AS VALUES", () => {
  const state = fresh();
  const frame = render(viewOf({ ...start(state, 0), state, page: "status" }),
    { rows: 60, cols: 100 }).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(frame, /MISSING/, "the TUI status page does not mark a blocker as one");
  assert.doesNotMatch(frame, /\(unset\)/,
    "the TUI still renders an absent contract as `(unset)`, which reads like a setting");
  assert.match(frame, /whoever you are contacting/,
    "the TUI shows the gaps without the sentence explaining where the things come from");

  const ok = configured();
  const clean = render(viewOf({ ...start(ok, 0), state: ok, page: "status" }),
    { rows: 60, cols: 100 }).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.doesNotMatch(clean, /MISSING|never chosen/,
    "a configured client is still told it is missing something");
});

test("ALL THREE SURFACES USE THE SAME SENTENCES, RATHER THAN THEIR OWN", () => {
  // The whole reason `setupGaps` is not written in a printer. Checked by source rather than by
  // rendering: a surface that stopped calling it and hand-wrote the text would still LOOK right in
  // a frame assertion, which is how the claims in `warnings.ts` drifted three times.
  const here = import.meta.dirname;
  for (const [surface, file] of [
    ["cli", "../../cli/src/cli.ts"],
    ["tui", "../../tui/src/view.ts"],
    ["gui", "../../gui/src/server.ts"],
  ] as const) {
    const src = readFileSync(join(here, file), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|import\b)/.test(l)).join("\n");
    assert.match(src, /gapsOf|g\.what|gaps/,
      `${surface} does not render the shared gaps — it has its own answer, or none`);
  }
  // And the defaults the `unchosen` category tests against are the ones `init` actually writes.
  // Two copies of a URL would be two answers to what the default is.
  const s = init();
  assert.equal(s.vaultUrl, DEVNET_VAULT, "`init` and `setupGaps` disagree about the vault default");
  assert.equal(s.rpcUrl, DEVNET_RPC, "`init` and `setupGaps` disagree about the RPC default");
  assert.deepEqual(setupGaps({ contract: "0x1", invites: 1, vaultUrl: "x", rpcUrl: "y" }), [],
    "the narrow entry point disagrees with the State projection");
});
