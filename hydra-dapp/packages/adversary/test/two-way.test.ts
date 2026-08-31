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

import { init, open, accept, publishBundle, sendMessage, flush, readChannel }
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

test("a channel with no role is refused rather than guessed", async () => {
  const { alice, server, chain } = await pair();
  try {
    // What a state file written before this change looks like. Defaulting the role would give
    // both ends the same direction, which is the original defect restored silently.
    delete (alice.channels.bob as { role?: string }).role;
    await assert.rejects(() => sendMessage(alice, chain, "bob", "x", T0), /predates two-way/);
    await assert.rejects(() => readChannel(alice, chain, "bob"), /predates two-way/);
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

    // Bob, holding the same material, mints a message in ALICE's direction by taking her role.
    const forged = { ...bob.channels.alice, role: "initiator" as const, nextSeq: 1 };
    bob.channels.forged = forged;
    await sendMessage(bob, chain, "forged", "alice did NOT say this", T0 + BLOCK);
    await flush(bob, LATER);

    const read = await readChannel(alice, chain, "bob");
    const forgedLine = read.find((m) => m.text === "alice did NOT say this");
    assert.ok(forgedLine, "the forgery did not land — if this is now impossible, say what closed it");
    assert.equal(forgedLine.mine, true,
      "the forgery landed but was not attributed to alice, which would be a partial defence");
  } finally { server.close(); }
});
