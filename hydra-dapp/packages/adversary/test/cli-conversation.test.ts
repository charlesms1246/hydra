/**
 * The client people will actually run, driven end to end.
 *
 * `conversation.test.ts` proves the packages compose. This proves the CLI does — which is a
 * different claim, and the one that matters, because every guarantee in this repo is a
 * guarantee about a sequence and the CLI is where the sequence is finally written down for a
 * human to invoke one command at a time.
 *
 * The interesting property is the one a CLI is most likely to lose. An upload must happen
 * strictly after the chain event that names it, by a jittered delay of at least eight block
 * intervals — so `send` cannot upload, and the temptation to make it do so (one command instead
 * of two) is exactly the regression to guard. `flush` is a separate act, and a flush at the
 * moment of sending uploads the message's COVER and leaves the message behind — which is the
 * shape the defence actually has, and not the shape I first wrote a test for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  init, publishBundle, open, accept, sendMessage, flush, readChannel, fingerprint,
} from "../../cli/src/commands.ts";
import { memoryChain } from "../../cli/src/chain.ts";
import { Vault } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { MIN_READ_BATCH } from "../../client/src/read.ts";
import { COVER_RATE } from "../../channel/src/cover.ts";
import { MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";

const BLOCK = 30_000;
const T0 = 1_800_000_000_000;

/** A vault with enough invites for a conversation and its cover, since cover spends them too. */
async function vault(n = 200) {
  const v = new Vault({
    invites: Array.from({ length: n }, (_, i) => `inv-${i}`),
    buckets: BUCKETS,
  });
  const { url, server } = await serve(v);
  return { v, url, server, invites: Array.from({ length: n }, (_, i) => `inv-${i}`) };
}

function pair(url: string, invites: string[]) {
  const alice = init({ vaultUrl: url, blockMs: BLOCK, invites: [...invites] });
  const bob = init({ vaultUrl: url, blockMs: BLOCK, invites: [...invites] });
  // Bob publishes a bundle while offline; alice never speaks to him to start the conversation.
  const message = open(alice, "with-bob", publishBundle(bob, 0));
  accept(bob, "with-alice", message);
  return { alice, bob };
}

test("a conversation runs end to end through the CLI's own operations", async () => {
  const { url, server, invites } = await vault();
  try {
    const { alice, bob } = pair(url, invites);
    const chain = memoryChain();

    const sent = await sendMessage(alice, chain, "with-bob", "meet me at the usual place", T0);
    assert.match(sent.txHash, /^0x[0-9a-f]+$/);

    // At the moment of sending, the MESSAGE is not due: its upload is scheduled strictly after
    // the event. Some of its cover usually is due, because cover leads the event — but "usually"
    // is 15 in 16 (each of four decoys is before T0 with probability a half), and asserting a
    // per-draw outcome of a random schedule is what made this file fail one run in sixteen.
    // The lead is measured over many sessions further down; here only the certainty is claimed.
    const early = await flush(alice, T0);
    assert.ok(alice.pending.some((p) => p.real), "the message went up with its own cover");
    assert.deepEqual(await readChannel(bob, chain, "with-alice"), []);

    // Then time passes.
    const done = await flush(alice, sent.uploadAt + MIN_JITTER_BLOCKS * BLOCK);
    assert.ok(early.uploaded + done.uploaded >= 1 + COVER_RATE,
      `only ${early.uploaded + done.uploaded} objects went up`);
    assert.equal(alice.pending.length, 0);

    const read = await readChannel(bob, chain, "with-alice");
    assert.deepEqual(read.map((m) => m.text), ["meet me at the usual place"]);
    assert.equal(read[0].seq, 0);
  } finally {
    server.close();
  }
});

test("send publishes the pointer and does NOT upload, which is the whole timing defence", async () => {
  const { url, server, v, invites } = await vault();
  try {
    const { alice } = pair(url, invites);
    const chain = memoryChain();
    const sent = await sendMessage(alice, chain, "with-bob", "hello", T0);

    // On chain immediately: two felts, and only two.
    assert.equal(chain.published.length, 1);
    assert.equal(chain.published[0].length, 2);
    // In the vault: nothing at all.
    assert.equal(v.observe().rows.length, 0, "send uploaded — the correlation is back");
    // And the upload is scheduled strictly after the event, by at least the jitter floor.
    assert.ok(sent.uploadAt > T0);
    assert.ok(sent.uploadAt <= T0 + MIN_JITTER_BLOCKS * BLOCK);
    assert.ok(alice.pending.length >= 1 + COVER_RATE, "cover was not queued with the message");
  } finally {
    server.close();
  }
});

test("cover goes up by the same route as a message, in the same size bucket", async () => {
  const { url, server, v, invites } = await vault();
  try {
    const { alice } = pair(url, invites);
    const chain = memoryChain();
    const sent = await sendMessage(alice, chain, "with-bob", "x", T0);
    await flush(alice, sent.uploadAt + MIN_JITTER_BLOCKS * BLOCK);

    const sizes = new Set(v.observe().rows.map((r) => r["blob.bucket"]));
    assert.equal(sizes.size, 1, `${sizes.size} sizes stored — a decoy is separable by length`);
    // The operator's whole record, searched for anything that says which one was real.
    const view = JSON.stringify(v.observe());
    assert.ok(!/real|decoy|cover/i.test(view), "the vault's record distinguishes cover from messages");
  } finally {
    server.close();
  }
});

test("within a flush, cover USUALLY goes up before the message — and the residual is measured", async () => {
  // Queue order would put the message first every time, because that is the order `send`
  // creates them in. Scheduled order is what matters, and the cover for a message is scheduled
  // to start before that message's own chain event.
  //
  // USUALLY, not always, and this test asserted "always" until it failed one run in ten. The
  // real upload is uniform over [event, event + W); a decoy is uniform over [event - W,
  // event + W). Every decoy landing after the real one is a real event with probability
  // (1/2)^rate * 1/(rate + 1) — about 1 in 80 at the shipped defaults — and on those messages
  // the cheapest possible attack, "the earliest upload is the first message", is right.
  //
  // Asserting a distribution as a certainty is how a residual gets hidden. The number is small
  // and it is not zero, so it is measured here and stated rather than asserted away.
  const { url, server, invites } = await vault(4000);
  try {
    const chain = memoryChain();
    let firstWasReal = 0;
    const positions = new Set<number>();
    const TRIALS = 300;
    for (let t = 0; t < TRIALS; t++) {
      const alice = init({ vaultUrl: url, blockMs: BLOCK, invites: [...invites] });
      const message = open(alice, "with-bob", publishBundle(init({ invites: [] }), 0));
      void message;
      const sent = await sendMessage(alice, chain, "with-bob", "x", T0);
      const realId = alice.pending.find((p) => p.real)!.id;
      const due = [...alice.pending].sort((a, b) => a.uploadAt - b.uploadAt);
      assert.ok(sent.uploadAt > T0);
      positions.add(due.findIndex((p) => p.id === realId));
      if (due[0].id === realId) firstWasReal++;
    }
    const rate = firstWasReal / TRIALS;
    assert.ok(rate < 0.05,
      `the real message was the earliest upload ${(rate * 100).toFixed(1)}% of the time; `
      + "above a few percent means the lead has stopped working, not that this draw was unlucky");

    // The randomness is asserted on the POSITIONS, not on the rare event. The first version
    // required at least one occurrence of a 1-in-80 outcome across 300 trials, which is itself
    // absent about 2% of the time — a test that fails one run in fifty because the thing it
    // measures is rare. Measuring a distribution and then asserting a single draw from it is
    // the same mistake this file's own comment warns about, made in the assertion below it.
    assert.ok(positions.size > 3,
      `the real upload landed in ${positions.size} distinct positions across ${TRIALS} sessions; `
      + "if it is always in the same place the schedule has stopped being random");
  } finally {
    server.close();
  }
});

test("a flush that would run out of invites refuses before sending anything", async () => {
  // Half a batch is worse than none: real messages in the vault with their cover still queued
  // is precisely the uncovered case the cover exists to prevent.
  const { url, server, v, invites } = await vault();
  try {
    const { alice } = pair(url, invites);
    alice.invites = ["only-one"];
    const chain = memoryChain();
    const sent = await sendMessage(alice, chain, "with-bob", "x", T0);
    await assert.rejects(() => flush(alice, sent.uploadAt + MIN_JITTER_BLOCKS * BLOCK), /invites/);
    assert.equal(v.observe().rows.length, 0, "it uploaded some of them before giving up");
  } finally {
    server.close();
  }
});

test("the read asks for more ids than it wants, always", async () => {
  // `read.target` on the disclosure table says the operator cannot tell which blob a reader
  // wanted. The server refuses a batch narrower than eight; this is the check that the CLI's
  // reader does not sail close to that line and get refused in production instead.
  const { url, server, v, invites } = await vault();
  try {
    const { alice, bob } = pair(url, invites);
    const chain = memoryChain();
    const sent = await sendMessage(alice, chain, "with-bob", "one message only", T0);
    await flush(alice, sent.uploadAt + MIN_JITTER_BLOCKS * BLOCK);

    // Checked on the wire the client actually puts out, not on what the server tolerated: the
    // server refusing narrow batches is a different guarantee, already asserted elsewhere.
    let asked = 0;
    const spy: typeof fetch = async (input, opts) => {
      if (opts?.method === "POST") asked = (JSON.parse(String(opts.body)) as string[]).length;
      return fetch(input as string, opts);
    };
    const read = await readChannel(bob, chain, "with-alice", spy);
    assert.ok(asked >= MIN_READ_BATCH, `the client asked for ${asked} ids, the floor is ${MIN_READ_BATCH}`);
    assert.deepEqual(read.map((m) => m.text), ["one message only"]);
    // One message, many ids: the surplus is the defence, not waste.
    assert.ok(asked > read.length);
  } finally {
    server.close();
  }
});

test("both sides derive the same channel from names they chose separately", () => {
  // The bug this pins: an earlier version folded the channel's LOCAL NAME into the key, so
  // alice calling it "with-bob" and bob calling it "with-alice" produced two different secrets
  // and a conversation that silently could not happen. A name a user picks must never reach a
  // key, and the two sides here deliberately pick different ones.
  const alice = init({ invites: [] });
  const bob = init({ invites: [] });
  const message = open(alice, "with-bob", publishBundle(bob, 0));
  accept(bob, "with-alice", message);
  assert.equal(alice.channels["with-bob"].materialHex, bob.channels["with-alice"].materialHex);
  assert.notEqual(alice.seedHex, bob.seedHex);
});

test("a fingerprint covers both long-term keys", () => {
  // Over the signing key as well as the DH key: the signing key is what makes a swapped prekey
  // detectable, so a fingerprint that omitted it would match while an attacker chose which
  // prekeys the victim's contacts accepted.
  const bob = init({ invites: [] });
  const bundle = publishBundle(bob, 0);
  const fp = fingerprint(bundle);
  assert.equal(fp.length, 32);
  assert.ok(fp.includes(Buffer.from(bundle.identityKey).toString("hex").slice(0, 16)));
  assert.ok(fp.includes(Buffer.from(bundle.signingKey).toString("hex").slice(0, 16)));
  assert.notEqual(fingerprint(publishBundle(init({ invites: [] }), 0)), fp);
});

test("the seed is fresh every time, so two clients are two people", () => {
  const seeds = new Set(Array.from({ length: 16 }, () => init({ invites: [] }).seedHex));
  assert.equal(seeds.size, 16);
  assert.equal(seeds.values().next().value!.length, 64);
});
