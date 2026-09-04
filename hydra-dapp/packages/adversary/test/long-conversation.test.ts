/**
 * A conversation long enough to break, and the two ways it did.
 *
 * The read path replays the chain and asks the vault for a candidate id per (event, sequence,
 * direction) triple, because a pointer names no channel. That cost is the feature — it is I3, and
 * the batch it produces is also the padded read `read.target` requires. Replaying from block zero
 * every time is not the feature, and nobody had counted what it cost:
 *
 *     35 messages: 4800 ids in a 323 KiB request, against a vault that accepts 257 KiB
 *
 * Not slow. Dead, with a clear error and no way past it. The product had a message limit and it
 * was under forty.
 *
 * Fixing that introduced the second failure, which is worse because it is silent. Bounding the
 * sequence numbers by "the highest already known, plus a constant" is right for a client that
 * keeps up and wrong for one catching up: across a hundred unread events the other end may have
 * sent a hundred messages, and anything past the bound was never asked for — and never asked for
 * again, because the read cursor had moved past its events. **A hundred messages sent, seventy-
 * four read, no error anywhere.**
 *
 * So both are pinned here: the ceiling must not come back, and a client that has been away must
 * lose nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { init, open, accept, publishBundle, sendMessage, flush, readChannel }
  from "../../cli/src/commands.ts";
import { memoryChain } from "../../cli/src/chain.ts";
import { Vault } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";

const BLOCK = 30_000;
const T0 = 1_800_000_000_000;

/**
 * The limiter is off here and only here.
 *
 * A long conversation uploads a message and its cover per turn, and the default global limit is
 * tuned for a client sending a few. Leaving it on would make this file fail for a reason it is
 * not about — and the honest note is that the limit interacting badly with cover is a REAL
 * finding, already recorded where `flush` translates the 429.
 */
async function stack(n = 6000) {
  const invites = Array.from({ length: n }, (_, i) => `lc-${i}`);
  const v = new Vault({ invites: [...invites], buckets: BUCKETS });
  const { url, server } = await serve(v, 0, { rateLimit: { mode: "none" } });
  const alice = init({ vaultUrl: url, blockMs: BLOCK, invites: invites.slice(0, n / 2) });
  const bob = init({ vaultUrl: url, blockMs: BLOCK, invites: invites.slice(n / 2) });
  accept(bob, "alice", open(alice, "bob", publishBundle(bob, 0)));
  // `own: true` — a stream carrying only this client's events, which is the unrealistic case and
  // is the right one HERE. This file measures how the work of keeping up grows with the
  // CONVERSATION, and foreign events add a constant that swamps the signal: with them the cost
  // reads 1224 / 1188 / 1296 at turns 10 / 20 / 40, so "the rescan window is filling" cannot be
  // seen at all. Resilience to a shared chain is a different property and belongs in its own test.
  return { alice, bob, v, server, url, chain: memoryChain({ own: true }) };
}

/** A `fetch` that records how many ids each read asked for. */
function counting() {
  const asked: number[] = [];
  const impl: typeof fetch = async (input, init) => {
    if (init?.method === "POST" && typeof init.body === "string" && init.body.startsWith("[")) {
      asked.push((JSON.parse(init.body) as string[]).length);
    }
    return fetch(input, init);
  };
  return { asked, impl };
}

const turn = async (s: Awaited<ReturnType<typeof stack>>, i: number) => {
  const [who, name] = i % 2 ? [s.bob, "alice"] as const : [s.alice, "bob"] as const;
  await sendMessage(who, s.chain, name, "ephemeral", `message ${i}`, T0 + i * BLOCK);
  await flush(who, T0 + (i + 20) * BLOCK);
};

// ---------------------------------------------------------------------------

test("a conversation past the old ceiling still reads, completely", async () => {
  const s = await stack();
  try {
    for (let i = 0; i < 45; i++) {
      await turn(s, i);
      // Reading every turn is the supported shape: a client that keeps up.
      const read = await readChannel(s.alice, s.chain, "bob");
      assert.equal(read.length, i + 1, `after ${i + 1} messages the transcript holds ${read.length}`);
    }
    const read = await readChannel(s.alice, s.chain, "bob");
    assert.deepEqual(read.map((m) => m.text), Array.from({ length: 45 }, (_, i) => `message ${i}`));
    assert.deepEqual(read.map((m) => m.mine), Array.from({ length: 45 }, (_, i) => i % 2 === 0));
  } finally { s.server.close(); }
});

test("a client that has been away loses nothing", async () => {
  const s = await stack();
  try {
    // One read early, so it has a cursor and a little history — the exact state in which the
    // sequence bound was wrong.
    await turn(s, 0);
    await readChannel(s.alice, s.chain, "bob");
    for (let i = 1; i < 60; i++) await turn(s, i);

    const read = await readChannel(s.alice, s.chain, "bob");
    assert.equal(read.length, 60,
      `${60 - read.length} messages were dropped by the catch-up read, silently`);
    assert.deepEqual(read.map((m) => m.text), Array.from({ length: 60 }, (_, i) => `message ${i}`));
  } finally { s.server.close(); }
});

test("the work of keeping up does not grow with the conversation", async () => {
  const s = await stack();
  const { asked, impl } = counting();
  try {
    const cost: number[] = [];
    for (let i = 0; i < 40; i++) {
      await turn(s, i);
      asked.length = 0;
      await readChannel(s.alice, s.chain, "bob", impl);
      cost.push(asked.reduce((a, b) => a + b, 0));
    }
    // STEADY STATE AGAINST STEADY STATE, and the turn-10 figure is not one.
    //
    // This compared turn 10 with turn 40 and was passing by 4% — 1850 against a bound of 1920.
    // Turn 10 is inside the warm-up: `fresh` is still filling toward RESCAN_EVENTS, so the read
    // is cheap for a reason that has nothing to do with the conversation's length. Salting cover
    // by commitment made the warm-up much cheaper still (960 -> 720 at turn 10, 1850 -> 1530 at
    // turn 40 — cheaper at every point) and the ratio against a smaller denominator tripped a
    // test measuring the wrong pair.
    //
    // Quadratic growth is what the ceiling was made of, so the property is that the read stops
    // growing once the window is full. Measured 1.07 across turns 20 to 40.
    assert.ok(cost[39] < cost[19] * 1.3,
      `a read costs ${cost[39]} ids at message 40 against ${cost[19]} at message 20 — the batch `
      + "is growing with the conversation again");
    // And the warm-up is a warm-up rather than a floor somebody should try to hold: it is
    // cheaper because the rescan window is not yet full, and asserting it stays that way would
    // be asserting that the client never catches up.
    assert.ok(cost[19] > cost[9],
      "the read did not grow at all from turn 10 to turn 20 — the rescan window is not filling, "
      + "which means a client that fell behind would not catch up");
    // An absolute ceiling too, because a flat ratio says nothing about the size it is flat at.
    // `fetchIds` pages against the vault's body limit, so this is about request count, not
    // failure: 1530 measured here against 1850 before cover was salted by commitment.
    assert.ok(cost[39] < 2_000,
      `a steady-state read asks for ${cost[39]} ids; it was 1530 when this bound was written`);
  } finally { s.server.close(); }
});

test("a read is paged rather than refused when the batch will not fit", async () => {
  const s = await stack();
  const { asked, impl } = counting();
  try {
    await turn(s, 0);
    await readChannel(s.alice, s.chain, "bob");
    for (let i = 1; i < 120; i++) await turn(s, i);

    asked.length = 0;
    const read = await readChannel(s.alice, s.chain, "bob", impl);
    assert.equal(read.length, 120);
    assert.ok(asked.length > 1,
      "a catch-up over 120 events fitted in one request; either the vault's limit moved or this "
      + "no longer exercises paging");
    // Every page is a real batch. A page narrower than the floor would be a read the vault is
    // entitled to refuse, and the floor is the defence.
    for (const n of asked) assert.ok(n >= 8, `a page of ${n} ids is below the read-batch floor`);
  } finally { s.server.close(); }
});

test("reading twice changes nothing, and sending needs no read", async () => {
  const s = await stack();
  try {
    await turn(s, 0);
    await turn(s, 1);
    const once = await readChannel(s.alice, s.chain, "bob");
    const twice = await readChannel(s.alice, s.chain, "bob");
    assert.deepEqual(once, twice, "a second read duplicated or reordered the transcript");

    // Alice's own message is in her transcript the moment she sends it: a client knows what it
    // said, and going to the vault for its own words costs a direction's worth of candidates.
    await sendMessage(s.alice, s.chain, "bob", "ephemeral", "straight into the log", T0 + 9 * BLOCK);
    assert.equal(s.alice.channels.bob.history.at(-1)!.text, "straight into the log");
    assert.equal(s.alice.channels.bob.history.at(-1)!.mine, true);
  } finally { s.server.close(); }
});
