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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

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

    const sent = await sendMessage(alice, chain, "with-bob", "ephemeral", "meet me at the usual place", T0);
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
    const sent = await sendMessage(alice, chain, "with-bob", "ephemeral", "hello", T0);

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
    const sent = await sendMessage(alice, chain, "with-bob", "ephemeral", "x", T0);
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

test("the real message is the earliest upload about a fifth of the time, and that is chance", async () => {
  // THIS TEST USED TO CLAIM THE OPPOSITE, and the claim was about a schedule rather than about a
  // client. `coverPlan` puts half of a message's decoys BEFORE that message's own chain event, so
  // "the earliest upload is the message" was wrong about 98% of the time — on paper. No client
  // can perform it: a client learns the message exists when the user sends it, and by then those
  // slots are in the past. `commands.ts` now redraws a past-due decoy from the same window the
  // message's own upload is drawn from, because the alternative — uploading them all at once —
  // is a burst that `adversary/src/matchers.ts` `after-the-burst` reads at 0.467.
  //
  // So the honest figure is chance among the objects that share the window: about a fifth to a
  // third, depending on how many of the message's decoys the plan put later. It is measured here
  // rather than asserted, and `adversary/test/resident-flush.test.ts` is where the comparison
  // lives.
  const { url, server, invites } = await vault(4000);
  try {
    const chain = memoryChain();
    let firstWasReal = 0;
    const positions = new Set<number>();
    const TRIALS = 300;
    for (let t = 0; t < TRIALS; t++) {
      const alice = init({ vaultUrl: url, blockMs: BLOCK, invites: [...invites] });
      open(alice, "with-bob", publishBundle(init({ invites: [] }), 0));
      const sent = await sendMessage(alice, chain, "with-bob", "ephemeral", "x", T0);
      const realId = alice.pending.find((p) => p.real)!.id;
      const due = [...alice.pending].sort((a, b) => a.uploadAt - b.uploadAt);
      assert.ok(sent.uploadAt > T0);
      // Nothing is queued in the past any more. A single past-due object is a burst of one; four
      // of them, on every message, is the burst.
      assert.ok(due.every((p) => p.uploadAt >= T0),
        "an upload is queued for a moment that has already gone");
      positions.add(due.findIndex((p) => p.id === realId));
      if (due[0].id === realId) firstWasReal++;
    }
    const rate = firstWasReal / TRIALS;
    assert.ok(rate > 0.1 && rate < 0.45,
      `the real message was the earliest upload ${(rate * 100).toFixed(1)}% of the time; outside `
      + "0.1–0.45 means the redraw is no longer putting cover in the message's own window");

    // The randomness is asserted on the POSITIONS, not on a rare event: requiring at least one
    // occurrence of a 1-in-80 outcome across 300 trials is itself absent about 2% of the time,
    // which is a test that fails one run in fifty because the thing it measures is rare.
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
    const sent = await sendMessage(alice, chain, "with-bob", "ephemeral", "x", T0);
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
    const sent = await sendMessage(alice, chain, "with-bob", "ephemeral", "one message only", T0);
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
  // Compared on the KEYS rather than on the agreed material, because the material is no longer
  // kept — that is what makes the ratchet's deletions mean anything. Alice's sending side must
  // be bob's receiving side and vice versa, or they have two channels rather than one.
  const a = alice.channels["with-bob"];
  const b = bob.channels["with-alice"];
  assert.equal(a.addressSendHex, b.addressRecvHex);
  assert.equal(a.addressRecvHex, b.addressSendHex);
  // AND THE CONTENT CHAINS DELIBERATELY DO NOT MATCH YET, which is a change the DH ratchet
  // makes and worth stating rather than deleting. The initiator steps at handshake time — she
  // knows the responder's initial ratchet key, so she never sends under the bootstrap chain —
  // while the responder cannot step until her first message arrives and tells him which key to
  // step onto. So the chains align one message in, not at `accept`.
  assert.notEqual(a.dh.sending.chainHex, b.dh.receiving.chainHex,
    "the initiator did not step at handshake time, so she will send under the bootstrap chain");
  // What DOES have to agree here is the addressing above: same agreed material, mirrored. The
  // chains agreeing is checked where it becomes true — `dh-conversation.test.ts` opens real
  // messages, which is the only proof that matters.
  assert.notEqual(a.dh.sending.chainHex, a.dh.receiving.chainHex,
    "one chain is doing both directions");
  assert.notEqual(a.addressSendHex, a.addressRecvHex, "one key is doing both directions again");
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

test("PUBLISH SAYS THE ACCOUNT KEY IS WHAT CONTESTS A REMOVAL, before it acts", () => {
  // Standing rule 7: publishing is an act, so what the act commits you to belongs in it.
  //
  // The appeal path proves authorship by signing with the account that published — the only
  // identity this system has. And the anonymity design pushes the other way: the value-free route
  // works once per account, and the shape it encourages is publish-once-and-never-return. So THE
  // MORE CORRECTLY SOMEBODY FOLLOWS THE ANONYMITY DESIGN, THE LESS ABLE THEY ARE TO APPEAL, and
  // the people with a durable reusable account are the ones with least to fear.
  //
  // That trade is defensible. It is not defensible to let somebody make it without being told.
  const src = readFileSync(join(HERE, "..", "..", "cli", "src", "cli.ts"), "utf8");
  const block = src.slice(src.indexOf('case "send":'), src.indexOf('case "read":'));
  assert.match(block, /KEEP THE ACCOUNT KEY/,
    "publish does not say the key is what proves authorship later");
  assert.match(block, /appeal/i, "publish does not mention appealing a takedown");
  assert.match(block, /permanent|forecloses/,
    "publish does not say that discarding it cannot be undone");
  // And it is on the SIGNED path, where authorship is the point — not on the deniable one, where
  // there is nothing to prove and the warning would be noise.
  assert.match(block, /if \(signed\) \{/);
});
