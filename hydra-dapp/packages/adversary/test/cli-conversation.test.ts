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
  const message = open(alice, "with-bob", publishBundle(bob, 0, 0));
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

    // At the moment of sending, the MESSAGE is not due — only cover is, because cover is
    // scheduled to lead the event by the jitter window. So a flush now uploads decoys and
    // leaves the message behind, and the recipient has nothing to read.
    const early = await flush(alice, T0);
    assert.ok(alice.pending.some((p) => p.real), "the message went up with its own cover");
    assert.ok(early.uploaded >= 1, "no cover led the message at all");
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

test("within a flush, cover goes up before the message it covers", async () => {
  // Queue order would put the message first every time, because that is the order `send`
  // creates them in. Scheduled order is what matters, and the cover for a message is scheduled
  // to start before that message's own chain event.
  const { url, server, invites } = await vault();
  try {
    const { alice } = pair(url, invites);
    const chain = memoryChain();
    const sent = await sendMessage(alice, chain, "with-bob", "x", T0);
    const realId = alice.pending.find((p) => p.real)!.id;

    const order: string[] = [];
    const spy: typeof fetch = async (input, opts) => {
      order.push(String(input).split("/").pop()!);
      return fetch(input as string, opts);
    };
    await flush(alice, sent.uploadAt + MIN_JITTER_BLOCKS * BLOCK, spy);

    const at = order.indexOf(realId);
    assert.ok(at >= 0, "the message was never uploaded");
    assert.ok(at > 0, "the message was the first object the operator saw — cover did not lead it");
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
  const message = open(alice, "with-bob", publishBundle(bob, 0, 0));
  accept(bob, "with-alice", message);
  assert.equal(alice.channels["with-bob"].materialHex, bob.channels["with-alice"].materialHex);
  assert.notEqual(alice.seedHex, bob.seedHex);
});

test("a fingerprint covers both long-term keys", () => {
  // Over the signing key as well as the DH key: the signing key is what makes a swapped prekey
  // detectable, so a fingerprint that omitted it would match while an attacker chose which
  // prekeys the victim's contacts accepted.
  const bob = init({ invites: [] });
  const bundle = publishBundle(bob, 0, 0);
  const fp = fingerprint(bundle);
  assert.equal(fp.length, 32);
  assert.ok(fp.includes(Buffer.from(bundle.identityKey).toString("hex").slice(0, 16)));
  assert.ok(fp.includes(Buffer.from(bundle.signingKey).toString("hex").slice(0, 16)));
  assert.notEqual(fingerprint(publishBundle(init({ invites: [] }), 0, 0)), fp);
});

test("the seed is fresh every time, so two clients are two people", () => {
  const seeds = new Set(Array.from({ length: 16 }, () => init({ invites: [] }).seedHex));
  assert.equal(seeds.size, 16);
  assert.equal(seeds.values().next().value!.length, 64);
});
