/**
 * Opening a conversation from a published record, in the front end people actually use.
 *
 * `hydra lookup` is described in its own `cli.ts` comment as *"the step that had no path"*: without
 * it a bundle can only reach a stranger out of band, **so a source needs a prior relationship with
 * the organisation they are anonymously contacting** — a prerequisite standing in front of the
 * surface, undoing its premise. The command existed only in the scriptable front end, and `cli.ts`
 * calls the other one *"the one people use"*.
 *
 * So this is a parity gap of the class `FRONT-END-PARITY-INVENTORY.md` exists for, with the twist
 * that the document had no row for it — and by that document's own standard, *"a parity document
 * with no row for a thing cannot report that thing missing."*
 *
 * What is asserted here is the disclosure, not the plumbing: which parties learn what, and that a
 * user is told all three costs before pressing the key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { render } from "../../tui/src/view.ts";
import { start, update, viewOf } from "../../tui/src/app.ts";
import type { Model } from "../../tui/src/app.ts";
import { perform } from "../../tui/src/effects.ts";
import type { Deps } from "../../tui/src/effects.ts";
import { LOOKUP_KEY_NOT_PERSON, LOOKUP_NO_ONE_TIME, LOOKUP_NODE_SEES }
  from "../../claims/src/warnings.ts";
import { init } from "../../cli/src/commands.ts";
import type { State } from "../../cli/src/state.ts";

const VAULT = "http://vault.example:8080";
const RPC = "http://node.example:5050";

const fresh = (): State => init({ vaultUrl: VAULT, rpcUrl: RPC, contract: "0x1", fromBlock: 1 });

const typeInto = (m: Model, key: string, value: string): Model =>
  ({ ...m, fields: { ...m.fields, [key]: value } });

const pressL = (m: Model) => update(m, { t: "key", key: { t: "char", value: "l" } });

test("`l` NEEDS A NAME AND AN ADDRESS, AND SAYS SO INSTEAD OF FAILING LATER", () => {
  const state = fresh();
  const base = { ...start(state, 0), state, page: "connect" as const };

  const bare = pressL(base);
  assert.deepEqual(bare.effects, [], "`l` reached the network with no address");
  assert.match(bare.model.log[bare.model.log.length - 1].text, /address/,
    "`l` did nothing and did not say why");

  const named = pressL(typeInto(typeInto(base, "peerName", "alice"), "peerAddress", "0x2993"));
  assert.deepEqual(named.effects, [{ t: "lookup", name: "alice", address: "0x2993" }],
    "`l` with both fields did not ask for a lookup");
});

test("A LOOKUP THAT FINDS NOTHING NEVER TOUCHES THE VAULT", async () => {
  // **THIS IS THE DISCLOSURE CLAIM, NOT AN OPTIMISATION.** `LOOKUP_NODE_SEES` tells the user that
  // asking costs them the RPC node knowing, and that this is the better of the two available
  // disclosures because fetching from the peer's vault would tell THE PEER they were being
  // considered. That sentence is only true while a failed lookup stops at the node — if the
  // channel were opened before the record verified, a mistyped address would write a prekey
  // message into a vault mailbox and the claim would be false in the direction that matters.
  const state = fresh();
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    asked.push(String(url));
    // The node answers, politely, that this address owns no identity.
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: ["0x0"] }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const deps = {
    save: () => {}, readFile: () => "", writeFile: () => {},
    chain: () => ({ publish: async () => "0x0", events: async () => [] }),
    fetchImpl, now: () => 0, session: { discoveryFailedFor: null },
  } as unknown as Deps;

  const event = await perform({ t: "lookup", name: "alice", address: "0x2993" }, state, deps);

  assert.equal(event.t, "error", "a lookup against an address with no record reported success");
  assert.ok(asked.length > 0, "nothing was asked of anybody, so this test measured nothing");
  assert.deepEqual(asked.filter((u) => u.startsWith(VAULT)), [],
    `the vault was contacted ${asked.filter((u) => u.startsWith(VAULT)).length} time(s) by a `
    + "lookup that found no record — LOOKUP_NODE_SEES claims only the node learns");
  assert.ok(asked.every((u) => u.startsWith(RPC)), `something other than the node was asked: ${asked}`);
  assert.ok(!state.channels.alice, "a channel was opened for a record that does not exist");
});

test("ALL THREE COSTS ARE ON THE PAGE, AT A REAL TERMINAL HEIGHT", () => {
  // Reachable, not merely present in the array. The page grew past 24 rows when the lookup path
  // landed and `LOOKUP_NODE_SEES` fell off the bottom — a page too full to show what it costs is
  // the failure this interface is built around, so `connect` scrolls now. This walks it the way a
  // user would rather than reading the unclipped lines.
  const state = fresh();
  const base = { ...start(state, 0), state, page: "connect" as const };
  const seen: string[] = [];
  for (let scroll = 0; scroll < 40; scroll++) {
    // Borders stripped before joining, not just colour. Each row is `│ … │`, so a sentence that
    // wraps across three rows is interrupted by two boxes' worth of `│` — a naive normaliser
    // reports every multi-line claim as clipped, which is a test that fails on correct output.
    seen.push(render(viewOf({ ...base, scroll }), { rows: 24, cols: 88 })
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/[│╭╮╰╯─]/g, " "))
      .join(" ").replace(/\s+/g, " "));
  }
  const anywhere = seen.join("\n");
  for (const w of [LOOKUP_KEY_NOT_PERSON, LOOKUP_NO_ONE_TIME, LOOKUP_NODE_SEES]) {
    const sentence = w.full.join(" ").replace(/\s+/g, " ");
    assert.ok(anywhere.includes(sentence),
      `"${w.id}" is never fully visible on Connect at 24 rows — it is being clipped, which is the `
      + "one thing a disclosure must not be");
  }
});

test("THE PAGE SAYS IT SCROLLS, AND CANNOT BE SCROLLED INTO NOTHING", () => {
  const state = fresh();
  const base = { ...start(state, 0), state, page: "connect" as const };
  const title = render(viewOf(base), { rows: 24, cols: 88 })[1].replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(title, /start a conversation — 1\/\d+/,
    "Connect overflows 24 rows and does not say so, so the part below the fold is invisible");

  const far = render(viewOf({ ...base, scroll: 500 }), { rows: 24, cols: 88 })
    .join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(far, /\S/, "scrolling past the end left an empty box");
  assert.ok(far.includes("hydra disclose") || far.includes("choose the node"),
    "the clamp does not land on the end of the content");
});
