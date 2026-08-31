/**
 * A conversation with a reply in it, which nothing in this repo had ever tried.
 *
 * Every harness here sent in one direction. `conversation.test.ts`, `cli-conversation.test.ts`,
 * `tui-conversation.test.ts` — alice sends, bob reads, done. A messaging product whose second
 * party never speaks is not being tested; it is being demonstrated.
 *
 * WHAT A REPLY BROKE, measured before it was fixed and asserted here so it cannot come back:
 *
 *   - **Cover collided.** Both ends derived decoys from one channel key at the same sequence
 *     numbers, so their cover was byte-identical. Ten uploads became SIX objects in the vault
 *     and eight invites bought four. Worse than the waste: an id that arrives twice can only be
 *     cover, because it is the one object two people independently mint — so a vault keeping a
 *     request log identifies every decoy with certainty. That is 1.000, the same figure the
 *     unfetched-decoy defect scored, reached from the other end.
 *   - **Sequence numbers collided.** Both counted from zero, so a transcript held two messages
 *     at seq 0 with no way to order them.
 *   - **Authorship was absent.** Each end read its own messages back indistinguishably from the
 *     other's.
 *
 * The fix is that a channel is two one-way keys and your role picks which you send under. What
 * it does NOT fix is forgery between the two participants: the nullifier is still derived from
 * material both ends hold, so your counterparty can compute yours. That is asserted below as a
 * KNOWN residual rather than left to be discovered. See `decisions/0023-two-way-channels.md`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { init, open, accept, publishBundle, sendMessage, flush, readChannel, foreignSends }
  from "../../cli/src/commands.ts";
import { memoryChain } from "../../cli/src/chain.ts";
import { Vault } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { COVER_RATE } from "../../channel/src/cover.ts";
import { MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";

const BLOCK = 30_000;
const T0 = 1_800_000_000_000;
const LATER = T0 + 40 * BLOCK;

async function pair(n = 600) {
  const invites = Array.from({ length: n }, (_, i) => `tw-${i}`);
  const v = new Vault({ invites: [...invites], buckets: BUCKETS });
  const { url, server } = await serve(v);
  const alice = init({ vaultUrl: url, blockMs: BLOCK, invites: invites.slice(0, n / 2) });
  const bob = init({ vaultUrl: url, blockMs: BLOCK, invites: invites.slice(n / 2) });
  accept(bob, "alice", open(alice, "bob", publishBundle(bob, 0)));
  return { alice, bob, v, server, chain: memoryChain() };
}

test("the two ends send under different keys, so no object of theirs equals one of yours", async () => {
  const { alice, bob, v, server, chain } = await pair();
  try {
    await sendMessage(alice, chain, "bob", "alice one", T0);
    await sendMessage(bob, chain, "alice", "bob one", T0 + BLOCK);

    const mine = new Set(alice.pending.map((p) => p.id));
    const theirs = new Set(bob.pending.map((p) => p.id));
    const shared = [...mine].filter((id) => theirs.has(id));
    assert.deepEqual(shared, [],
      `${shared.length} objects are identical across the two ends — cover has collapsed, and an `
      + "id that two people mint independently is an id the operator knows is cover");

    // And the vault agrees: every upload is a distinct object, so the invites bought what they
    // were spent on.
    const a = await flush(alice, LATER);
    const b = await flush(bob, LATER);
    assert.equal(a.uploaded + b.uploaded, 2 * (1 + COVER_RATE));
    assert.equal(v.observe().rows.length, a.uploaded + b.uploaded,
      "the vault holds fewer objects than were uploaded — two ends minted the same bytes");
  } finally { server.close(); }
});

test("both ends read the whole conversation, in the order the chain gives", async () => {
  const { alice, bob, server, chain } = await pair();
  try {
    await sendMessage(alice, chain, "bob", "are you there", T0);
    await sendMessage(bob, chain, "alice", "yes", T0 + BLOCK);
    await sendMessage(alice, chain, "bob", "the usual place then", T0 + 2 * BLOCK);
    await flush(alice, LATER);
    await flush(bob, LATER);

    const said = ["are you there", "yes", "the usual place then"];
    for (const [who, state, name] of [["alice", alice, "bob"], ["bob", bob, "alice"]] as const) {
      const read = await readChannel(state, chain, name);
      assert.deepEqual(read.map((m) => m.text), said, `${who} read the conversation out of order`);
    }
  } finally { server.close(); }
});

test("a transcript says who spoke, and the two ends agree in mirror image", async () => {
  const { alice, bob, server, chain } = await pair();
  try {
    await sendMessage(alice, chain, "bob", "mine", T0);
    await sendMessage(bob, chain, "alice", "yours", T0 + BLOCK);
    await flush(alice, LATER);
    await flush(bob, LATER);

    const aliceSees = await readChannel(alice, chain, "bob");
    const bobSees = await readChannel(bob, chain, "alice");
    assert.deepEqual(aliceSees.map((m) => m.mine), [true, false]);
    assert.deepEqual(bobSees.map((m) => m.mine), [false, true],
      "the two ends do not disagree about who spoke, which means the roles are not opposite");
    // Same words, opposite attribution. That is the whole property.
    assert.deepEqual(aliceSees.map((m) => m.text), bobSees.map((m) => m.text));
  } finally { server.close(); }
});

test("each direction counts its own sequence numbers", async () => {
  const { alice, bob, server, chain } = await pair();
  try {
    await sendMessage(alice, chain, "bob", "a0", T0);
    await sendMessage(alice, chain, "bob", "a1", T0 + BLOCK);
    await sendMessage(bob, chain, "alice", "b0", T0 + 2 * BLOCK);
    assert.equal(alice.channels.bob.nextSeq, 2);
    assert.equal(bob.channels.alice.nextSeq, 1, "the responder's counter follows the initiator's");

    await flush(alice, LATER);
    await flush(bob, LATER);
    const read = await readChannel(alice, chain, "bob");
    // Two messages at seq 0 and 1 in one direction, one at seq 0 in the other. Ordering comes
    // from the chain, which is why `at` exists: seq alone would put b0 between a0 and a1.
    assert.deepEqual(read.map((m) => `${m.mine ? "a" : "b"}${m.seq}`), ["a0", "a1", "b0"]);
  } finally { server.close(); }
});

test("a channel from before the ratchet is refused rather than migrated", async () => {
  const { alice, server, chain } = await pair();
  try {
    // What a state file written before the ratchet looks like: the agreed material and no
    // stored keys. Migrating it would mean inventing chains the other end does not have, and a
    // channel whose keys only one side knows is worse than one that refuses to open.
    delete (alice.channels.bob as { addressSendHex?: string }).addressSendHex;
    await assert.rejects(() => sendMessage(alice, chain, "bob", "x", T0), /predates the message ratchet/);
    await assert.rejects(() => readChannel(alice, chain, "bob"), /predates the message ratchet/);
  } finally { server.close(); }
});

test("KNOWN RESIDUAL: your counterparty can still forge as you", async () => {
  // Asserted so it is a documented property rather than an assumption. The nullifier a message
  // commits under comes from the sending direction's key, and both ends can derive both keys —
  // that is what a shared secret is. So `commit` binds authorship against everybody except the
  // one person with a motive.
  //
  // Closing it needs a per-party secret the other end never learns: the sender's own vault root,
  // with the recipient holding a public commitment to it, which changes what Phase 5's proof is
  // about. This test exists to fail the day someone believes it is already closed.
  const { alice, bob, server, chain } = await pair();
  try {
    await sendMessage(alice, chain, "bob", "alice said this", T0);
    await flush(alice, LATER);

    // Bob, who holds both addressing keys and both chains because that is what a shared secret
    // is, mints a message in ALICE's direction by swapping the two round.
    const his = bob.channels.alice;
    bob.channels.forged = {
      ...his,
      addressSendHex: his.addressRecvHex,
      addressRecvHex: his.addressSendHex,
      send: JSON.parse(JSON.stringify(his.recv)),
      recv: JSON.parse(JSON.stringify(his.send)),
      nextSeq: 1,
      history: [],
    };
    await sendMessage(bob, chain, "forged", "alice did NOT say this", T0 + BLOCK);
    await flush(bob, LATER);

    // Alice's own client counts it as a message in HER direction that she did not send, which
    // is the same signal a second device raises — the two are indistinguishable from here, and
    // that is the honest state of it.
    await readChannel(alice, chain, "bob");
    assert.equal(foreignSends(alice, "bob"), 1,
      "the forgery did not land — if this is now impossible, say what closed it");
  } finally { server.close(); }
});

test("TWO CLIENTS ON ONE IDENTITY mint identical cover, and cannot be stopped from it", async () => {
  // The same defect the direction split fixed, from a place the split cannot reach: two devices
  // sharing a seed share a ROLE, so they are one direction. Copying a state file to a second
  // machine is the obvious thing to do with it.
  const { alice, bob, v, server, chain } = await pair();
  try {
    const laptop = JSON.parse(JSON.stringify(alice)) as typeof alice;
    // Its own invites, so nothing fails for the boring reason.
    laptop.invites = Array.from({ length: 200 }, (_, i) => `laptop-${i}`);
    for (const inv of laptop.invites) v.handle({ op: "invite", invite: inv } as never);

    await sendMessage(alice, chain, "bob", "from the phone", T0);
    await sendMessage(laptop, chain, "bob", "from the laptop", T0 + BLOCK);

    const phone = new Set(alice.pending.map((p) => p.id));
    const shared = laptop.pending.filter((p) => phone.has(p.id));
    assert.equal(shared.length, COVER_RATE,
      `${shared.length} objects collided across two devices; if this is now zero, something `
      + "gives a device its own cover — say how the recipient fetches it");
    assert.ok(shared.every((p) => !p.real), "a real message collided, which would be worse");
    void bob;
  } finally { server.close(); }
});

test("and the client says so, because it cannot prevent it", async () => {
  const { alice, bob, server, chain } = await pair();
  try {
    const laptop = JSON.parse(JSON.stringify(alice)) as typeof alice;
    laptop.invites = alice.invites.slice(100);
    alice.invites = alice.invites.slice(0, 100);

    await sendMessage(alice, chain, "bob", "phone", T0);
    await sendMessage(laptop, chain, "bob", "laptop", T0 + BLOCK);
    await flush(alice, LATER);
    await flush(laptop, LATER);

    // The phone sent one message and the channel holds two in its own direction. The second is
    // COUNTED, not shown: its key came out of a sending chain on the other device, and this one
    // destroyed its own copy of that sequence's key the moment it stepped past it. The words are
    // unreachable from here, which is forward secrecy working — and it is still a signal.
    const read = await readChannel(alice, chain, "bob");
    assert.equal(read.filter((m) => m.mine).length, 1, "the transcript shows a message this client never sent");
    assert.equal(alice.channels.bob.nextSeq, 1);
    assert.equal(foreignSends(alice, "bob"), 1,
      "a second client on this identity went unnoticed");

    // And bob, who is genuinely a different party, triggers nothing.
    await readChannel(bob, chain, "alice");
    assert.equal(foreignSends(bob, "alice"), 0,
      "the other END of the conversation was mistaken for another of your own devices");
  } finally { server.close(); }
});
