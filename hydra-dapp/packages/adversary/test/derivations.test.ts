/**
 * What an observer works out that the vault never wrote down.
 *
 * `operator-view.test.ts` captures the vault's own record and compares it against `OBSERVABLE`
 * in both directions. That is the right check and it has a blind spot: an operator is not
 * limited to the record. They can combine it with information the PROTOCOL publishes and get
 * answers the record does not contain.
 *
 * The prekey inbox made the category visible first. Its slot ids are a public function of the
 * recipient's
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
import { Vault, ENCRYPTED_ENDPOINT, DEFAULT_TTL_MS } from "../../vault-server/src/server.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { inboxSlot, inboxSlots, postPrekey, collectPrekeys, encodePrekey, INBOX_SLOTS }
  from "../../handshake/src/inbox.ts";
import type { Transport } from "../../handshake/src/inbox.ts";
import { initiate, respond, bundleFor } from "../../handshake/src/x3dh.ts";
import { send, cover, openChannel } from "../../client/src/session.ts";
import { coverBody, coverId, COVER_RATE } from "../../channel/src/cover.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, expose, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { ephemeral } from "../../handshake/src/authorship.ts";
import { init, open, publishBundle, sendMessage } from "../../cli/src/commands.ts";
import { memoryChain } from "../../cli/src/chain.ts";
import { jitterWindowMs } from "../../channel/src/schedule.ts";

/** splitmix32, as everywhere else here — see the note in `resident-flush.test.ts`. */
const prng = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 2 ** 32;
  };
};

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

  "invite.issuance": async () => {
    // NOT A DERIVATION FROM WHAT THE VAULT STORES, and that is the point of the row. The vault
    // keeps header NAMES only (`TransportRecord`) and deletes the token from a set, so its record
    // genuinely holds no association — `invite.redeemed` is accurate about that. What it cannot be
    // accurate about is the moment: the operator must READ the token to check it, and it arrives
    // in the same request as the object. Anything they choose to write down at that boundary is a
    // join they did not have to work for, and it is their own process.
    const vault = freshVault();
    // The issuer's own ledger, which is the "given". Nothing cryptographic about it.
    const issuedTo = new Map([["inv-ana", "ana"], ["inv-ben", "ben"]]);
    const vaultWithInvites = new Vault({ invites: [...issuedTo.keys()], buckets: BUCKETS });
    void vault;

    // What any operator can log at the boundary, in three lines, using only what the request hands
    // them. This is the whole derivation.
    const ledger: { person: string; object: string }[] = [];
    const upload = (invite: string, id: string, body: Uint8Array) => {
      ledger.push({ person: issuedTo.get(invite)!, object: id });
      return vaultWithInvites.handle({
        op: "upload", endpoint: ENCRYPTED_ENDPOINT, id, body, invite,
      });
    };

    const anaBlob = send({ channel: openChannel(alice, "a"), author: ephemeral(), blockMs: 30_000 },
      new TextEncoder().encode("ana's message"), 0, 0, () => 0.5);
    const benBlob = send({ channel: openChannel(bob, "b"), author: ephemeral(), blockMs: 30_000 },
      new TextEncoder().encode("ben's message"), 0, 0, () => 0.5);
    assert.equal(upload("inv-ana", anaBlob.blobId, anaBlob.body).ok, true);
    assert.equal(upload("inv-ben", benBlob.blobId, benBlob.body).ok, true);

    // The operator now names the uploader of any object, with no cryptography and no correlation.
    const who = (id: string) => ledger.find((l) => l.object === id)?.person;
    assert.equal(who(anaBlob.blobId), "ana");
    assert.equal(who(benBlob.blobId), "ben");
    assert.notEqual(who(anaBlob.blobId), who(benBlob.blobId),
      "the join does not distinguish two uploaders, so this row over-claims");

    // AND THE DEFAULT BUILD RETAINS NEITHER HALF, which is why the row is about the practice
    // rather than about this code: no stored row carries an invite, and the transport record — if
    // it is even switched on — keeps header NAMES and not values.
    const stored = JSON.stringify(vaultWithInvites.observe().rows);
    for (const code of issuedTo.keys()) {
      assert.ok(!stored.includes(code), `the vault retained ${code} against an object`);
    }
    vaultWithInvites.observeRequest({ at: 0, peer: "127.0.0.1", headers: ["x-hydra-invite"] });
    const transport = JSON.stringify(vaultWithInvites.observe().transport);
    assert.ok(transport.includes("x-hydra-invite"), "the transport record shape has changed");
    assert.ok(!transport.includes("inv-ana"), "the transport record now retains header VALUES");
  },

  "channel.activeAccount": async () => {
    // Driven through `cli/src/commands.ts` rather than through the plan, because the claim is
    // about what a CLIENT does. `sendMessage` is the only thing in this system that queues an
    // object, and every object it queues is scheduled into the window of the chain event it
    // just published — so the derivation is a property of the code path, and the harness has to
    // walk that path rather than a model of it.
    const BLOCK = 30_000;
    const GAP = 8 * 60_000;
    const T0 = 1_800_000_000_000;
    const window = jitterWindowMs({ blockMs: BLOCK });
    const rnd = prng(7);
    const client = init({ blockMs: BLOCK, invites: [] });
    open(client, "with-bob", publishBundle(init({ invites: [] }), 0));
    const chain = memoryChain();
    const events: number[] = [];
    for (let seq = 0; seq < 6; seq++) {
      const at = T0 + seq * GAP;
      await sendMessage(client, chain, "with-bob", "ephemeral", `message ${seq}`, at, rnd);
      events.push(at);
    }

    // Uploaded at the moment each object was scheduled for, so the vault's own arrival times
    // ARE the client's schedule. Uploading them all now would make this a test of an array.
    let tick = T0;
    // One invite per object, because cover spends them at the cover rate per message — the
    // same accounting `flush` refuses to start without.
    const invites = Array.from({ length: client.pending.length }, (_, i) => `w-${i}`);
    const vault = new Vault({ invites: [...invites], buckets: BUCKETS, now: () => tick });
    for (const p of [...client.pending].sort((a, b) => a.uploadAt - b.uploadAt)) {
      tick = p.uploadAt;
      const body = new Uint8Array(Buffer.from(p.bodyB64, "base64"));
      const res = vault.handle({
        op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: p.id, body, invite: invites.shift(),
      });
      assert.equal(res.ok, true, `upload failed: ${JSON.stringify(res)}`);
    }

    // The operator's side. Arrival is the deadline minus the published TTL — `blob.arrival`,
    // nothing more — and the events are the chain's, which names the account that published
    // each one.
    const arrivals = vault.observe().rows.map((r) => Number(r["blob.expiry"]) - DEFAULT_TTL_MS);
    assert.equal(arrivals.length, client.pending.length);
    const coveredBy = (times: readonly number[]) =>
      arrivals.filter((a) => times.some((e) => a >= e && a < e + window)).length;

    // Every object, without exception. Not "most" and not a distribution — the client cannot
    // upload outside the window, so this is the shape of the disclosure rather than a measure
    // of it, and a fraction below one would mean the client had changed.
    assert.equal(coveredBy(events), arrivals.length,
      "an upload landed outside every window of the account that caused it");

    // And a stranger publishing as often over the same span covers only what coincides. The
    // gap between the two is the whole derivation.
    const other = Array.from({ length: events.length }, () => T0 + rnd() * (6 * GAP))
      .sort((a, b) => a - b);
    assert.ok(coveredBy(other) < arrivals.length,
      `a stranger's windows covered all ${arrivals.length} uploads too — with a four-minute `
      + "window and six events this is possible by chance, so reseed rather than believing it");
  },

  "channel.author": async () => {
    // Two records, one join key. The vault's side gives a set of blobs per channel — that is
    // `read.channelSet`, measured in `i3-batch-membership.test.ts`. The chain's side gives a set
    // of events per publishing account, because the transaction names the sender. Matching them
    // needs no link between any individual upload and any individual event, which is the only
    // thing jitter and cover make hard.
    const invites = Array.from({ length: 400 }, (_, i) => `d-${i}`);
    const vault = freshVault();
    const random = () => 0.5;

    const counts = { quiet: 2, busy: 7 };
    const chain = new Map<string, number>();
    const objects = new Map<string, number>();
    for (const [who, n] of Object.entries(counts)) {
      const channel = openChannel(derive(VAULT_DOMAIN,
        rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(n + 80), who)))), who);
      const config = { channel, author: ephemeral(), blockMs: 30_000 };
      const messages = Array.from({ length: n }, (_, seq) =>
        send(config, new TextEncoder().encode(`${who} ${seq}`), seq, seq * 90_000, random));
      chain.set(who, messages.length);
      let stored = 0;
      for (const m of messages) {
        vault.handle({
          op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: m.blobId, body: m.body,
          invite: invites.shift(),
        });
        stored++;
      }
      for (const d of cover(config, messages, random)) {
        const body = coverBody(channel, d.bucket, d.index, d.salt);
        vault.handle({
          op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: coverId(body), body,
          invite: invites.shift(),
        });
        stored++;
      }
      objects.set(who, stored);
    }

    // The derivation: divide out the published cover rate and read the message count back.
    for (const [who, stored] of objects) {
      const implied = stored / (COVER_RATE + 1);
      assert.equal(implied, chain.get(who),
        `the object count no longer divides back to the message count for ${who}`);
    }
    // And the counts are distinct, so the join is exact rather than a hint.
    assert.equal(new Set(chain.values()).size, Object.keys(counts).length);
  },

  "handshake.opener": async () => {
    // Two records and a clock. The mailbox write says somebody opened a conversation with this
    // person; the chain says which account published a pointer moments later. Neither names the
    // opener; together they do.
    const openers = ["a", "b", "c"];
    const written = new Map<string, number>();
    const chain: { author: string; at: number }[] = [];
    let clock = 0;
    const transport: Transport = {
      async put(id) { written.set(id, clock); return true; },
      async get(ids) {
        return new Map([...written.keys()].filter((k) => ids.includes(k)).map((k) => [k, new Uint8Array(0)]));
      },
    };
    const bobKeyLocal = bundleFor(bob, 0, 0).identityKey;
    const truth = new Map<string, string>();
    for (const [i, who] of openers.entries()) {
      clock = i * 3_600_000;
      const before = new Set(written.keys());
      const sender = derive(VAULT_DOMAIN,
        rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(110 + i), who))));
      await postPrekey(transport, bobKeyLocal, initiate(sender, bundleFor(bob, 0, i)).message);
      truth.set([...written.keys()].find((k) => !before.has(k))!, who);
      chain.push({ author: who, at: clock + 5_000 });
    }
    // The derivation: for each write, the nearest publish after it.
    for (const [slot, at] of written) {
      const nearest = chain.filter((e) => e.at >= at).sort((x, y) => x.at - y.at)[0];
      assert.equal(nearest.author, truth.get(slot),
        "the nearest publish is no longer the opener; the write must be scheduled now");
    }
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
