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
 * The fix is that a channel is two one-way keys and your role picks which you send under. It did
 * NOT fix forgery between the two participants — the value a message committed under came from
 * material both ends hold — and this file carried that as an asserted residual so that nobody
 * could believe it was closed while it was not.
 *
 * **It is closed now**, by a per-author signature: `authorship.test.ts`,
 * `decisions/0026-authorship-and-deniability.md`. What remains below is the deniable half, which
 * is the same capability turned into a choice rather than a defect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { init, open, accept, publishBundle, sendMessage, flush, readChannel, foreignSends, SKIPPED_KEEP, linkabilityOf }
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
    await sendMessage(alice, chain, "bob", "ephemeral", "alice one", T0);
    await sendMessage(bob, chain, "alice", "ephemeral", "bob one", T0 + BLOCK);

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
    await sendMessage(alice, chain, "bob", "ephemeral", "are you there", T0);
    await sendMessage(bob, chain, "alice", "ephemeral", "yes", T0 + BLOCK);
    await sendMessage(alice, chain, "bob", "ephemeral", "the usual place then", T0 + 2 * BLOCK);
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
    await sendMessage(alice, chain, "bob", "ephemeral", "mine", T0);
    await sendMessage(bob, chain, "alice", "ephemeral", "yours", T0 + BLOCK);
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
    await sendMessage(alice, chain, "bob", "ephemeral", "a0", T0);
    await sendMessage(alice, chain, "bob", "ephemeral", "a1", T0 + BLOCK);
    await sendMessage(bob, chain, "alice", "ephemeral", "b0", T0 + 2 * BLOCK);
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
    await assert.rejects(() => sendMessage(alice, chain, "bob", "ephemeral", "x", T0), /predates the ratchet/);
    await assert.rejects(() => readChannel(alice, chain, "bob"), /predates the ratchet/);
  } finally { server.close(); }
});

test("a channel from before the DH ratchet is refused too, for the same reason", async () => {
  // TWO GENERATIONS OF STATE NOW. A file written before `decisions/0032` has the two bare chains
  // and no `dh`, and there is nothing to migrate it from: the DH root descends from the agreed
  // material, which this client deliberately does not keep. Inventing one would produce a
  // channel whose keys the other end has never heard of.
  const { alice, server, chain } = await pair();
  try {
    delete (alice.channels.bob as { dh?: unknown }).dh;
    await assert.rejects(() => sendMessage(alice, chain, "bob", "ephemeral", "x", T0),
      /predates the ratchet/);
    await assert.rejects(() => readChannel(alice, chain, "bob"), /predates the ratchet/);
  } finally { server.close(); }
});

test("TWO CLIENTS ON ONE IDENTITY no longer mint identical cover", async () => {
  // `decisions/0023` recorded this as unfixable and it was not. Two devices sharing a seed share
  // a ROLE, so they are one direction, and copying a state file to a second machine is the
  // obvious thing to do with it — so both would mint the same decoy bodies at the same sequence,
  // collide in the vault, and hand the operator a blob id that proves two clients share an
  // identity.
  //
  // THE ARGUMENT FOR UNFIXABLE was that a decoy must be regenerable by the RECIPIENT, who knows
  // the channel and the sequence and nothing about which device sent it — so any per-device salt
  // is one the recipient cannot compute. True of anything the sender picks privately. Not true of
  // the **commitment**, which the sender publishes on chain and the recipient reads off the event
  // before it fetches anything.
  //
  // So: the recipient fetches them by deriving from the commitment, exactly as it already derives
  // everything else about a message from the chain event that announced it. The blind inside the
  // commitment is `randomBytes` per message, so two devices at sequence 0 publish different
  // commitments without coordinating and without either knowing the other exists.
  const { alice, bob, v, server, chain } = await pair();
  try {
    const laptop = JSON.parse(JSON.stringify(alice)) as typeof alice;
    // Its own invites, so nothing fails for the boring reason.
    laptop.invites = Array.from({ length: 200 }, (_, i) => `laptop-${i}`);
    for (const inv of laptop.invites) v.handle({ op: "invite", invite: inv } as never);

    await sendMessage(alice, chain, "bob", "ephemeral", "from the phone", T0);
    await sendMessage(laptop, chain, "bob", "ephemeral", "from the laptop", T0 + BLOCK);

    const phone = new Set(alice.pending.map((p) => p.id));
    const shared = laptop.pending.filter((p) => phone.has(p.id));
    assert.deepEqual(shared, [],
      `${shared.length} objects still collide across two devices — the commitment salt is not `
      + "reaching the cover derivation");

    // And the two devices really did send at the same sequence, or the absence of a collision
    // would be the absence of an overlap rather than a fix.
    assert.equal(alice.channels.bob.nextSeq, 1);
    assert.equal(laptop.channels.bob.nextSeq, 1);
    assert.equal(alice.pending.filter((p) => !p.real).length, COVER_RATE);
    assert.equal(laptop.pending.filter((p) => !p.real).length, COVER_RATE);
    void bob;
  } finally { server.close(); }
});

test("and the client says so, because it cannot prevent it", async () => {
  const { alice, bob, server, chain } = await pair();
  try {
    const laptop = JSON.parse(JSON.stringify(alice)) as typeof alice;
    laptop.invites = alice.invites.slice(100);
    alice.invites = alice.invites.slice(0, 100);

    await sendMessage(alice, chain, "bob", "ephemeral", "phone", T0);
    await sendMessage(laptop, chain, "bob", "ephemeral", "laptop", T0 + BLOCK);
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

test("parked keys are bounded, and the bound drops the oldest rather than the needed", async () => {
  // `dh.acrossSteps` holds a message key for every sequence a ratchet step abandoned, so an
  // unbounded map is forward secrecy leaking back out through a state file — the same hazard
  // `forgetOldSkipped` exists for, one level up. `readChannel` trims it.
  //
  // WHAT MUST NOT HAPPEN is trimming a key whose message is still in flight, which would be data
  // loss dressed as secrecy. The bound is by insertion order, so the oldest parked sequences go
  // first; a straggler from the most recent abandoned chain is the one most likely to still be
  // coming, and it is the one kept.
  const { alice, bob, chain, server } = await pair();
  try {
    // A conversation with steps in it: alice speaks, bob replies, repeatedly. Each reply that
    // alice reads ends a chain and parks whatever she had not seen from it.
    for (let i = 0; i < 6; i++) {
      await sendMessage(alice, chain, "bob", "ephemeral", `a${i}`, T0 + i * 2 * BLOCK);
      await flush(alice, T0 + (i * 2 + 20) * BLOCK);
      await readChannel(bob, chain, "alice");
      await sendMessage(bob, chain, "alice", "ephemeral", `b${i}`, T0 + (i * 2 + 1) * BLOCK);
      await flush(bob, T0 + (i * 2 + 21) * BLOCK);
      await readChannel(alice, chain, "bob");
    }
    const read = await readChannel(alice, chain, "bob");
    assert.equal(read.length, 12, "the conversation did not complete across its ratchet steps");

    // Bounded, whatever happened above.
    const parked = Object.keys(alice.channels.bob.dh.acrossSteps).length;
    assert.ok(parked <= SKIPPED_KEEP,
      `${parked} parked keys against a bound of ${SKIPPED_KEEP} — a state file that only grows`);

    // And the trim is by insertion order, so a key parked more recently outlives an older one.
    const entry = alice.channels.bob.dh;
    entry.acrossSteps = {};
    for (let i = 0; i < SKIPPED_KEEP + 5; i++) entry.acrossSteps[`k:${i}`] = `${i}`;
    await readChannel(alice, chain, "bob");
    const left = Object.keys(entry.acrossSteps);
    assert.equal(left.length, SKIPPED_KEEP);
    assert.ok(!left.includes("k:0"), "the oldest parked key survived the trim");
    assert.ok(left.includes(`k:${SKIPPED_KEEP + 4}`), "the newest parked key was trimmed");
  } finally { server.close(); }
});

test("THE CROWD ONLY GOES DOWN, because it is an intersection and not a minimum", async () => {
  // `decisions/0029`: a crowd is set by its worst-covered message. One message of six sent into a
  // quiet chain took a measured 34.9 to zero, and a number that recovered afterwards would be a
  // lie about a message already on the chain.
  //
  // A MINIMUM OVER PER-MESSAGE COUNTS WOULD NOT DO IT. The minimum of two counts is an upper
  // bound on the size of their intersection and never a lower one — two disjoint crowds of ten
  // intersect to nothing. So the state holds the SET.
  const { alice, server } = await pair();
  try {
    const entry = alice.channels.bob;
    assert.equal(linkabilityOf(alice, "bob").known, false,
      "a channel that has never asked a node reported a known crowd");

    entry.crowd = ["a", "b", "c"];
    assert.deepEqual(linkabilityOf(alice, "bob"), { known: true, crowd: 3, identified: 1 / 4 });

    // A second message covered by a disjoint set takes it to zero, not to three.
    entry.crowd = entry.crowd.filter((a) => ["x", "y", "z"].includes(a));
    assert.equal(linkabilityOf(alice, "bob").crowd, 0);
    assert.equal(linkabilityOf(alice, "bob").identified, 1);

    // And nothing widens it again.
    entry.crowd = entry.crowd.filter((a) => ["a", "b", "c", "x"].includes(a));
    assert.equal(linkabilityOf(alice, "bob").crowd, 0, "the crowd recovered after a bad send");
  } finally { server.close(); }
});

test("a chain that cannot name senders leaves the crowd unknown, never zero", async () => {
  // `memoryChain` has no `senders`, so this is the ordinary path for every hermetic test here —
  // and the assertion is that it produces NO answer rather than a frightening one. An absent
  // capability and a measured zero are opposite claims and must not render alike.
  const { alice, chain, server } = await pair();
  try {
    await sendMessage(alice, chain, "bob", "ephemeral", "hello", T0);
    assert.equal(alice.channels.bob.crowd, undefined,
      "a chain with no sender lookup invented a crowd");
    assert.equal(linkabilityOf(alice, "bob").known, false);
  } finally { server.close(); }
});
