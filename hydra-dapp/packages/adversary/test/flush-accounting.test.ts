/**
 * A flush that fails part-way does not lose the invites it already spent.
 *
 * **STATE CORRUPTION ON THE SCARCE RESOURCE, on the path a source uses under pressure.** `flush`
 * spends one invite per successful `PUT` and the line clearing `pending` sat AFTER the loop — so a
 * vault refusing the fourth object left three objects it had already accepted still queued, and
 * three invites already burnt, with the caller's `save` never reached either.
 *
 * The next flush then presents dead codes and re-uploads objects the vault holds. Invites are the
 * one resource this client cannot obtain more of: `init --invites` is the only way in, and there
 * is no top-up command. See `decisions/0038` finding 1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { flush } from "../../cli/src/commands.ts";
import type { State } from "../../cli/src/state.ts";

const pending = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `enc:${i.toString(16).padStart(4, "0")}`,
  bodyB64: Buffer.from(new Uint8Array(8)).toString("base64"),
  uploadAt: 0,
  seq: i,
  channel: "bob",
}));

const stateWith = (n: number): State => ({
  vaultUrl: "http://vault.example", rpcUrl: "", contract: "", fromBlock: 0,
  accountsFile: "", account: "", blockMs: 30_000, seedHex: "00",
  prekeys: {} as never,
  invites: Array.from({ length: n }, (_, i) => `inv-${i}`),
  channels: {}, pending: pending(n),
} as unknown as State);

/** A vault that accepts the first `ok` uploads and then refuses. */
const failsAfter = (ok: number): typeof fetch => {
  let seen = 0;
  return (async () => (seen++ < ok
    ? new Response(JSON.stringify({ ok: true }), { status: 201 })
    : new Response("no", { status: 500 }))) as unknown as typeof fetch;
};

test("A PARTIAL FLUSH KEEPS ITS BOOKS: spent invites and delivered objects agree", async () => {
  const state = stateWith(6);
  await assert.rejects(() => flush(state, 0, failsAfter(3), Infinity), /refused/);

  // Three uploads succeeded, so three invites are gone and three objects have left the queue.
  // Before the fix, `pending` still held all six while three invites had been shifted — the two
  // records disagreeing is what makes the next flush present a dead code.
  assert.equal(state.invites.length, 3, "an invite was spent for an upload that did not happen, "
    + "or kept for one that did");
  assert.equal(state.pending.length, 3, "objects the vault accepted are still queued");
  // And they agree with each other: exactly the objects that went are the ones gone.
  assert.deepEqual(state.pending.map((p) => p.id), ["enc:0003", "enc:0004", "enc:0005"]);
  assert.deepEqual(state.invites, ["inv-3", "inv-4", "inv-5"]);
});

test("the count reported is what was uploaded, not what was due", async () => {
  // `uploaded: due.length` was returned unconditionally, so a caller that caught the error and
  // read the count was told everything went. It reports the actual number now.
  const state = stateWith(4);
  const ok = await flush(state, 0, failsAfter(9), Infinity);
  assert.equal(ok.uploaded, 4);
  assert.equal(state.invites.length, 0);
  assert.equal(state.pending.length, 0);
});

test("a rate-limited flush loses nothing either, which is what its message promises", async () => {
  // The 429 path says "nothing was lost — run `hydra flush` again", and that has to be true of the
  // objects already up as well as the ones not yet attempted.
  const state = stateWith(5);
  const limited: typeof fetch = (() => {
    let seen = 0;
    return async () => (seen++ < 2
      ? new Response(JSON.stringify({ ok: true }), { status: 201 })
      : new Response("slow down", { status: 429 }));
  })() as unknown as typeof fetch;

  await assert.rejects(() => flush(state, 0, limited, Infinity), /rate limiting/);
  assert.equal(state.invites.length, 3);
  assert.equal(state.pending.length, 3);
});

test("nothing is spent when the queue cannot be covered at all", async () => {
  // The pre-flight refusal: uploading half a batch and running out leaves real messages in the
  // vault with their cover still queued, which is worse than not starting.
  const state = stateWith(3);
  state.invites = ["only-one"];
  await assert.rejects(() => flush(state, 0, failsAfter(99), Infinity), /Get more before flushing/);
  assert.equal(state.invites.length, 1, "an invite was spent by a flush that refused to start");
  assert.equal(state.pending.length, 3);
});
