/**
 * What an operator works out that the vault never wrote down.
 *
 * `operator-view.test.ts` captures the vault's own record and compares it against `OBSERVABLE`
 * in both directions. That is the right check and it has a blind spot: an operator is not
 * limited to the record. They can combine it with information the PROTOCOL publishes and get
 * answers the record does not contain.
 *
 * The prekey inbox made this visible. Its slot ids are a public function of the recipient's
 * identity key — they have to be, or a stranger could not write to you before you share a
 * secret — so the vault stores them as ordinary objects and knows nothing about them. Nothing
 * in the record says "inbox". `operator-view` would never have produced the row and would have
 * correctly reported the table over-claiming. The disclosure is real anyway.
 *
 * So `DERIVABLE` is a third category, and this file performs each derivation against a real
 * capture rather than asserting it. Both directions, like the other two tables: a row with no
 * derivation here fails, a derivation with no row fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DERIVABLE, DERIVABLE_IDS, OBSERVABLE_IDS } from "../../vault-server/src/observations.ts";
import { Vault, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { inboxSlot, inboxSlots, postPrekey, collectPrekeys, encodePrekey, INBOX_SLOTS }
  from "../../handshake/src/inbox.ts";
import type { Transport } from "../../handshake/src/inbox.ts";
import { initiate, respond, bundleFor } from "../../handshake/src/x3dh.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, expose, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

const rootOf = (n: number, label: string) =>
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(n), label))));

const alice = rootOf(31, "alice");
const bob = rootOf(32, "bob");
const carol = rootOf(33, "carol");
const bobKey = bundleFor(bob, 0, 0).identityKey;

/** A transport straight onto a `Vault`, so the operator's view is the real one. */
function vaultTransport(vault: Vault, invites: string[]): Transport {
  return {
    async put(id, body) {
      return vault.handle({
        op: "upload", endpoint: ENCRYPTED_ENDPOINT, id, body, invite: invites.shift(),
      }).ok;
    },
    async get(ids) {
      const reply = vault.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: [...ids] });
      if (!reply.ok) throw new Error(String((reply as { error: string }).error));
      return new Map((reply as { found: ReadonlyMap<string, Uint8Array> }).found);
    },
  };
}

const freshVault = () => new Vault({
  invites: Array.from({ length: 64 }, (_, i) => `inv-${i}`),
  buckets: BUCKETS,
  observeReads: true,
});

/**
 * The derivations, keyed by the row they prove. Each one takes only the vault's public record
 * and the `given` — never a secret — and returns what the operator learns.
 */
const DERIVATIONS: Record<string, () => Promise<void>> = {
  "inbox.exists": async () => {
    const vault = freshVault();
    const invites = Array.from({ length: 64 }, (_, i) => `inv-${i}`);
    const transport = vaultTransport(vault, invites);

    // Nothing waiting yet: the operator's answer is zero, and that is already an answer.
    const stored = () => new Set(vault.observe().rows.map((r) => r["blob.id"] as string));
    const waiting = () => inboxSlots(bobKey).filter((id) => stored().has(id)).length;
    assert.equal(waiting(), 0);

    // Two strangers open conversations with bob.
    await postPrekey(transport, bobKey, initiate(alice, bundleFor(bob, 0, 0)).message, () => 0);
    await postPrekey(transport, bobKey, initiate(carol, bundleFor(bob, 0, 1)).message, () => 0);

    // The operator holds bob's PUBLISHED identity key and nothing else. They compute the same
    // slot ids anyone can and read the count off the store.
    assert.equal(waiting(), 2, "the derivation does not find what was put there");
    // It is specific to bob: another identity's mailbox is empty, so this is a fact about a
    // person and not a fact about the vault being busy.
    const carolKey = bundleFor(carol, 0, 0).identityKey;
    assert.equal(inboxSlots(carolKey).filter((id) => stored().has(id)).length, 0);
  },

  "inbox.activity": async () => {
    const vault = freshVault();
    const invites = Array.from({ length: 64 }, (_, i) => `inv-${i}`);
    const transport = vaultTransport(vault, invites);
    await postPrekey(transport, bobKey, initiate(alice, bundleFor(bob, 0, 0)).message, () => 0);

    // A write is an ordinary object with an ordinary expiry, and expiry minus the published TTL
    // is an arrival time — the `blob.arrival` row, applied to an id the operator can name.
    const row = vault.observe().rows.find((r) => inboxSlots(bobKey).includes(r["blob.id"] as string));
    assert.ok(row, "the mailbox write is not in the record at all");
    assert.ok(row!["blob.expiry"] !== undefined, "no arrival time is derivable for an inbox slot");

    // And collection is a read of exactly this mailbox's ids. Recording reads is opt-in, but
    // the row claims what an operator CAN see, so the check is with recording on.
    await collectPrekeys(transport, bobKey);
    const reads = vault.observe().reads;
    assert.ok(reads.length > 0, "the collection did not reach the server");
    const asked = new Set(reads.flatMap((r) => r.ids));
    const mine = inboxSlots(bobKey).filter((id) => asked.has(id)).length;
    assert.equal(mine, INBOX_SLOTS,
      "a collection does not ask for the whole mailbox, so it is not identifiable as one — "
      + "good news, but then this row over-claims and should be removed");
  },
};

test("every derivable row is actually derivable, and every derivation has a row", () => {
  assert.deepEqual(DERIVABLE_IDS.slice().sort(), Object.keys(DERIVATIONS).sort(),
    "the derivable table and its proofs have drifted apart");
  // And a derivation is not an observation: these must not be claimed as things the vault's own
  // record shows, or `operator-view` would demand a capture that cannot exist.
  for (const id of DERIVABLE_IDS) {
    assert.ok(!OBSERVABLE_IDS.includes(id),
      `${id} is on both tables — it is either in the record or derived from it, not both`);
  }
});

for (const row of DERIVABLE) {
  test(`${row.id} — given ${row.given}`, async () => {
    // The `given` must be public. A derivation that needed a secret would not be a disclosure,
    // it would be a decryption, and the distinction is the whole value of this table.
    assert.ok(!/secret|private key|channel key/i.test(row.given),
      `${row.id} claims to need ${row.given}, which is not public information`);
    await DERIVATIONS[row.id]();
  });
}

test("the sender is not derivable, which is the row next door", () => {
  // `inbox.sender` sits in NOT_OBSERVABLE. The check is that the slot carries nothing about who
  // wrote it: two different senders, same recipient, and the set of ids they may use is
  // identical — so where a message lands says nothing.
  const fromAlice = initiate(alice, bundleFor(bob, 0, 0));
  const fromCarol = initiate(carol, bundleFor(bob, 0, 1));
  const slots = inboxSlots(bobKey);
  for (const m of [fromAlice.message, fromCarol.message]) {
    const bytes = encodePrekey(m);
    // The sender's own identity key IS in the message — it must be, X3DH needs it — but it is
    // not in the address, and the address is what the operator indexes by.
    assert.ok(bytes.length === BUCKETS[0]);
    assert.ok(!slots.some((id) => id.includes(Buffer.from(m.identityKey).toString("hex").slice(0, 12))));
  }
  // Both senders could have used any slot, so the choice is not a signal either.
  assert.equal(slots.length, INBOX_SLOTS);
  assert.equal(new Set(slots).size, INBOX_SLOTS, "two slots collide — a mailbox holds fewer than it says");
});

test("a delivered prekey message actually opens a channel", async () => {
  // The derivations above are about what leaks. This is the check that the thing leaking is at
  // least doing its job: alice posts, bob collects, and both sides hold the same channel.
  const vault = freshVault();
  const invites = Array.from({ length: 64 }, (_, i) => `inv-${i}`);
  const transport = vaultTransport(vault, invites);

  const opening = initiate(alice, bundleFor(bob, 0, 0));
  const slot = await postPrekey(transport, bobKey, opening.message);
  assert.ok(slot >= 0 && slot < INBOX_SLOTS);

  const waiting = await collectPrekeys(transport, bobKey);
  assert.equal(waiting.length, 1);
  const theirs = respond(bob, waiting[0].message);
  assert.equal(
    Buffer.from(expose(theirs.channel, VAULT_DOMAIN)).toString("hex"),
    Buffer.from(expose(opening.channel, VAULT_DOMAIN)).toString("hex"),
    "the delivered handshake does not produce the same channel");
});

test("a full mailbox is refused rather than overwritten", async () => {
  // Overwriting would drop a stranger's pending handshake silently, and silently is the part
  // that matters: the sender would believe they had opened a conversation.
  const vault = freshVault();
  const invites = Array.from({ length: 64 }, (_, i) => `inv-${i}`);
  const transport = vaultTransport(vault, invites);
  for (let i = 0; i < INBOX_SLOTS; i++) {
    await postPrekey(transport, bobKey, initiate(alice, bundleFor(bob, 0, i)).message);
  }
  await assert.rejects(
    () => postPrekey(transport, bobKey, initiate(carol, bundleFor(bob, 0, 0)).message),
    /slots are occupied/);
  // And every one of them is still collectable — nothing was lost on the way in.
  assert.equal((await collectPrekeys(transport, bobKey)).length, INBOX_SLOTS);
});

test("junk in a slot is discarded, not thrown", async () => {
  // Anyone may write to a mailbox — that is what makes delivery work — so garbage is expected
  // rather than exceptional. A collector that threw would let one stranger deny service with
  // one object.
  const vault = freshVault();
  const invites = Array.from({ length: 64 }, (_, i) => `inv-${i}`);
  const transport = vaultTransport(vault, invites);
  await transport.put(inboxSlot(bobKey, 5), new Uint8Array(BUCKETS[0]).fill(0xff));
  await postPrekey(transport, bobKey, initiate(alice, bundleFor(bob, 0, 0)).message);
  const waiting = await collectPrekeys(transport, bobKey);
  assert.equal(waiting.length, 1, "the junk was collected as if it were a handshake");
  assert.notEqual(waiting[0].slot, 5);
});
