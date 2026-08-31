/**
 * Phase 2's lifecycle, against a running pool.
 *
 * `HYDRA_HANDOFF.md` Phase 2: "Full lifecycle: `SetViewingKey` → `OpenChannel` →
 * `OpenSubchannel` → note → discover. Handle the re-open failure and the 10-block delay
 * explicitly in tests."
 *
 * This is the one part of the platform that cannot be built offline, and it is driven through
 * the Devtool's control API rather than through the SDK directly — the Devtool already owns
 * the awkward parts (proving, `executeOutside`, note selection), and re-implementing them here
 * would be re-implementing them wrongly.
 *
 *     cd devtool && node packages/cli/src/cli.mjs up
 *     HYDRA_CONTROL=http://127.0.0.1:<port> HYDRA_RPC=http://127.0.0.1:<port> npm run test:live
 *
 * Opt-in, like `live-chain.test.ts`, and a missing environment variable fails rather than
 * skips. These tests MUTATE the stack: they register accounts and move value. That is fine on
 * a devnet and would not be anywhere else, which is why the URL must be given explicitly and
 * has no default.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { explain } from "../../client/src/session.ts";

const CONTROL = process.env.HYDRA_CONTROL;
const RPC = process.env.HYDRA_RPC;
const POOL = process.env.HYDRA_POOL;

type Reply = { ok: boolean; error?: string; [k: string]: unknown };

async function control(action: string, body: unknown = {}): Promise<Reply> {
  const res = await fetch(`${CONTROL}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json() as Reply;
}

type Note = { symbol: string; amount: string };
const notesOf = async (who: string): Promise<Note[]> =>
  ((await control("notes", { who })).notes ?? []) as Note[];

before(() => {
  assert.ok(CONTROL, "set HYDRA_CONTROL to the running stack's control URL (see ~/.hydra/state.json)");
});

test("registering twice is refused by the pool", async () => {
  // The "re-open failure" Phase 2 asks to handle explicitly. `set_viewing_key` writes through
  // `to_write_once_action` and the comment at
  // `.upstream/packages/privacy/src/privacy.cairo:315-317` says re-registration reverts.
  //
  // What it looks like from a client is the finding. Not "already registered" — the proof
  // simply fails to compile, and the error names nothing a user could act on:
  //
  //     simulated __execute__ emitted no server message; the pool did not compile the actions
  //
  // Any real client has to recognise this shape and translate it, because the pool will not.
  const first = await control("register", { who: "alice" });
  const again = await control("register", { who: "alice" });
  assert.equal(again.ok, false, "the pool accepted a second registration");
  assert.match(String(again.error), /did not compile the actions|no server message/,
    `the re-open failure changed shape: ${again.error}`);
  // And the first one either succeeded now or had already succeeded — both are fine, but a
  // failure for a different reason is not.
  if (!first.ok) assert.match(String(first.error), /did not compile the actions|no server message/);
});

test("a shielded note is discoverable immediately, with no delay at all", async () => {
  // Worth asserting because it is the opposite of what "10-block delay" suggests, and a client
  // that waited before showing the user their balance would be waiting for nothing.
  const before = await notesOf("alice");
  const shielded = await control("shield", { who: "alice", amount: "100" });
  assert.equal(shielded.ok, true, `shield failed: ${shielded.error}`);
  const after = await notesOf("alice");
  assert.ok(after.length > before.length || after.some((n) => n.amount === "100"),
    "a freshly shielded note was not discoverable");
});

test("a transfer to an unregistered recipient is refused, and names the wrong thing", async () => {
  // This test exists because the one below was green for a week on a devnet that had outlived
  // several sessions, where bob had registered at some point nobody recorded. Rebuilt from
  // nothing, the transfer failed — the suite had been resting on chain history rather than on
  // anything it did. A live test whose precondition is "the last run left the chain like this"
  // is a live test that proves whatever the chain happens to hold.
  //
  // So the precondition is now established here, and the failure it used to hide is asserted
  // on the way past. `.upstream/sdk/src/internal/compiler.ts:294` requires the sender to hold
  // channel context for the recipient, which exists only once the recipient has registered.
  const notes = await notesOf("bob");
  if (notes.length === 0) {
    // Only meaningful before bob registers; on a re-run against the same chain he already has.
    const refused = await control("transfer", { from: "alice", to: "bob", amount: "50" });
    if (!refused.ok) {
      assert.match(String(refused.error), /Missing channel context for recipient/,
        `the unregistered-recipient failure changed shape: ${refused.error}`);
      assert.equal(explain(String(refused.error), "transfer").kind, "recipient-not-registered",
        "the client no longer translates the live pool's actual error text");
    }
  }
  const registered = await control("register", { who: "bob" });
  assert.ok(registered.ok || /did not compile the actions|no server message/.test(String(registered.error)),
    `registering the recipient failed for a new reason: ${registered.error}`);
});

test("value moves privately and both sides discover it", async () => {
  // The spine: SetViewingKey → OpenChannel → note → discover, end to end, on a real pool.
  const moved = await control("transfer", { from: "alice", to: "bob", amount: "50" });
  assert.equal(moved.ok, true, `transfer failed: ${moved.error}`);
  assert.match(String(moved.txHash), /^0x[0-9a-f]+$/);

  const bob = await notesOf("bob");
  assert.ok(bob.some((n) => n.amount === "50"), `bob did not discover the note: ${JSON.stringify(bob)}`);
  // And the sender keeps the change, which is the part the SDK will not infer: notes cannot be
  // partially spent, so a transfer that is not exactly a note needs a surplus destination.
  const alice = await notesOf("alice");
  assert.ok(alice.length > 0, "the sender's change vanished");
});

test("the pool's block window is one block minimum, not ten", async () => {
  // Phase 2 says "the 10-block delay". Read from the source and from the live pool, that is
  // not a pool constant:
  //
  //   privacy.cairo:833  assert(base_block_number < current_block_number)   — strictly before,
  //                      so a proof cannot be used in the block it was based on. One block.
  //   privacy.cairo:835  current <= base + proof_validity_blocks            — the upper bound,
  //                      which this pool reports as 450.
  //
  // The Devtool advances 11 blocks before a transfer, which is headroom rather than a
  // requirement. A client that hard-codes ten is coding to a number nothing enforces; what it
  // must actually handle is a proof going stale after 450.
  assert.ok(RPC && POOL, "set HYDRA_RPC and HYDRA_POOL to read the pool's configuration");
  const selector = await import("../../../../.upstream/client/node_modules/starknet/dist/index.js")
    .then((m) => (m as { hash: { getSelectorFromName(n: string): string } })
      .hash.getSelectorFromName("get_proof_validity_blocks"));
  const res = await fetch(RPC!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "starknet_call",
      params: [{ contract_address: POOL, entry_point_selector: selector, calldata: [] }, "latest"],
    }),
  });
  const body = await res.json() as { result?: string[] };
  assert.ok(body.result, "could not read get_proof_validity_blocks from the pool");
  const window = Number(BigInt(body.result[0]));
  assert.ok(window > 10,
    `proof_validity_blocks is ${window}; if this is ever 10 the handoff's number was right ` +
    "after all and this test should say so");
  assert.equal(window, 450, `the window moved to ${window} — the disclosure statement quotes it`);
});
