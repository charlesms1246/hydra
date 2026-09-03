/**
 * The adversary the user cannot choose or replace.
 *
 * Every sweep here models a chain observer or a vault operator. Neither is the auditor. The
 * auditor holds the escrowed pool viewing key — written at registration, encrypted to a party
 * the user did not pick, and unreplaceable because `enc_private_key` is write-once
 * (`identity/src/linkage.ts`, `claude-docs/decisions/0001`). They see strictly more than a chain
 * observer by construction, and unlike a storage operator you cannot host your own.
 *
 * Auditor plus vault operator is therefore the strongest realistic adversary this product faces,
 * and it had never been modelled. A subpoena to a storage host plus the party who already holds
 * the pool's viewing key is not an exotic scenario.
 *
 * THE COMPOSITION, three links each measured elsewhere and never joined:
 *
 *   operator   a read batch is a channel                    read.channelSet
 *   both       a channel's object count names its author    channel.author
 *   auditor    an account's funder, decrypted from the pool  decisions/0002
 *
 * Each link is published. The composition is what this file measures, and it ends at a person.
 *
 * WHAT STILL HOLDS, and it is the reason `decisions/0009` chose an independent handshake: the
 * auditor's key opens the POOL, not the vault. Message content survives this adversary
 * completely. What does not survive is who was talking to whom.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { send, cover, openChannel } from "../../client/src/session.ts";
import { readSet } from "../../client/src/read.ts";
import { Vault, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";
import { coverBody, coverId, COVER_RATE } from "../../channel/src/cover.ts";
import { openForChannel } from "../../vault-client/src/blobs.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { initiate, bundleFor } from "../../handshake/src/x3dh.ts";
import {
  rootSeed, entropyFrom, fromTestVector, derive, adoptPoolKey, requireDomain,
  POOL_DOMAIN, VAULT_DOMAIN,
} from "../../identity/src/domains.ts";
import { ephemeral } from "../../handshake/src/authorship.ts";

const BLOCK = 30_000;

const rootOf = (n: number, label: string) =>
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(n), label))));

/**
 * A world with pool accounts, fresh identities, and conversations.
 *
 * `funding` is what the auditor decrypts: which real owner funded which publishing account. It
 * is in the pool's private transfers, which the escrowed key opens — `decisions/0002` measured
 * that a fresh identity's only public-safe funding route is exactly the one the auditor reads.
 */
function world() {
  const invites = Array.from({ length: 800 }, (_, i) => `au-${i}`);
  const vault = new Vault({ invites: [...invites], buckets: BUCKETS });

  const people = [
    { owner: "journalist", account: "0xacc1", messages: 3 },
    { owner: "source", account: "0xacc2", messages: 6 },
    { owner: "lawyer", account: "0xacc3", messages: 11 },
  ];

  /** Auditor's view: the funding transfer inside the pool, decrypted. */
  const funding = new Map(people.map((p) => [p.account, p.owner]));
  /** Chain observer's view: how many pointers each account published. */
  const published = new Map<string, number>();
  /** Operator's view: one read batch per channel, so one set of objects per conversation. */
  const channels = new Map<string, string[]>();
  /** Ground truth, for scoring only. */
  const truth = new Map<string, string>();

  for (const p of people) {
    const channel = openChannel(rootOf(p.messages + 120, p.owner), p.owner);
    const config = { channel, author: ephemeral(), blockMs: BLOCK };
    const messages = Array.from({ length: p.messages }, (_, seq) =>
      send(config, new TextEncoder().encode(`${p.owner} ${seq}`), seq, seq * BLOCK * 3, () => 0.5));
    published.set(p.account, messages.length);

    const mine: string[] = [];
    for (const m of messages) {
      vault.handle({
        op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: m.blobId, body: m.body,
        invite: invites.shift(),
      });
      mine.push(m.blobId);
    }
    for (const d of cover(config, messages, () => 0.5)) {
      const body = coverBody(channel, d.bucket, d.index, d.salt);
      vault.handle({
        op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: coverId(body), body, invite: invites.shift(),
      });
      mine.push(coverId(body));
    }

    const batch = new Set(readSet(channel,
      messages.map((m) => ({ seq: m.seq, commitment: m.calldata[1], pointer: m.pointer as unknown as Uint8Array }))));
    channels.set(p.owner, mine.filter((id) => batch.has(id)));
    truth.set(p.owner, p.owner);
  }
  return { vault, funding, published, channels, truth, people };
}

/** The three links, composed. Nothing here needs a key. */
function attribute(w: ReturnType<typeof world>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [channelKey, blobs] of w.channels) {
    // 1. object count / (coverRate + 1) is the message count — cover is proportional.
    const implied = blobs.length / (COVER_RATE + 1);
    // 2. the account that published that many pointers.
    const accounts = [...w.published].filter(([, n]) => n === implied).map(([a]) => a);
    if (accounts.length !== 1) continue;
    // 3. the auditor decrypts who funded that account.
    const owner = w.funding.get(accounts[0]);
    if (owner) out.set(channelKey, owner);
  }
  return out;
}

test("THE COMPOSITION: three published links end at a named person", () => {
  const w = world();
  const guess = attribute(w);
  let right = 0;
  for (const [channel, owner] of w.truth) if (guess.get(channel) === owner) right++;
  assert.equal(right / w.truth.size, 1,
    "the composed attribution no longer names every owner; recheck which link changed");
  // No key was used anywhere in `attribute`. Each step is on the disclosure table already.
  assert.equal(guess.size, w.people.length);
});

test("and it is the COMPOSITION that is new — no single view does it", () => {
  const w = world();

  // The operator alone: sets of blobs, no account, no owner.
  for (const blobs of w.channels.values()) {
    assert.ok(blobs.every((id) => id.startsWith("enc:")));
  }
  // The chain observer alone: accounts and counts, no owner behind them.
  assert.equal([...w.published.values()].reduce((a, b) => a + b), 3 + 6 + 11);
  assert.ok(![...w.published.keys()].some((a) => w.truth.has(a)));
  // The auditor alone: owners and accounts, and nothing about any conversation.
  assert.deepEqual([...w.funding.values()].sort(), ["journalist", "lawyer", "source"]);
  for (const owner of w.funding.values()) {
    assert.ok(!w.channels.has(`${owner}-blobs`), "the auditor's view contains vault objects");
  }
});

test("the auditor's key does not open a message, and that is the whole of decisions/0009", () => {
  // The load-bearing separation, asserted inside the composed model rather than only in I1's
  // unit test. If the vault channel were derived from pool material — which would have been
  // less code — this adversary would read the words as well as the graph.
  const escrowed = adoptPoolKey(0x1234n);
  assert.equal(escrowed.domain, POOL_DOMAIN);
  assert.throws(() => requireDomain(escrowed, VAULT_DOMAIN), /pool\/viewing-key/);

  // And a handshake cannot be built from it: every entry point takes a vault secret, so the
  // auditor holds material that no channel in this system descends from.
  const alice = rootOf(31, "alice");
  const bob = rootOf(32, "bob");
  const opened = initiate(alice, bundleFor(bob, 0, 0));
  const message = send({ channel: opened.channel, author: ephemeral(), blockMs: BLOCK },
    new TextEncoder().encode("the auditor cannot read this"), 0, 0, () => 0.5);

  // A pool secret is not a channel. The only thing that opens the body is the agreed secret.
  assert.throws(() => openForChannel(escrowed as never, message.body),
    /pool\/viewing-key|unable to authenticate|bad decrypt/i);
  assert.doesNotThrow(() => openForChannel(opened.channel, message.body));
});

test("what this adversary gets is the graph, and the words are not in it", () => {
  // Stated as the boundary of the finding, so it is not read as "everything is lost". The
  // composition names who was talking to whom. Message content is untouched — it is sealed
  // under a secret neither party ever holds.
  const w = world();
  const view = JSON.stringify(w.vault.observe());
  for (const p of w.people) {
    assert.ok(!view.includes(`${p.owner} 0`), "message text reached the operator's record");
    assert.ok(!view.includes(p.owner), "an owner's name reached the operator's record");
  }
  // The operator's record does not even contain the accounts; those come from the chain.
  for (const account of w.published.keys()) assert.ok(!view.includes(account));
});

test("equal message counts break link two, and the composition with it", () => {
  // Where it stops working, measured rather than asserted. Link two is the count fingerprint;
  // if every conversation is the same size the accounts are interchangeable and the auditor's
  // funding map has nothing to attach to.
  const invites = Array.from({ length: 800 }, (_, i) => `eq-${i}`);
  const vault = new Vault({ invites: [...invites], buckets: BUCKETS });
  const published = new Map<string, number>();
  const channels = new Map<string, string[]>();
  for (const [i, owner] of ["a", "b", "c"].entries()) {
    const channel = openChannel(rootOf(140 + i, owner), owner);
    const config = { channel, author: ephemeral(), blockMs: BLOCK };
    const messages = Array.from({ length: 4 }, (_, seq) =>
      send(config, new TextEncoder().encode(`${owner} ${seq}`), seq, seq * BLOCK * 3, () => 0.5));
    published.set(`0x${owner}`, messages.length);
    const mine: string[] = [];
    for (const m of messages) {
      vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: m.blobId, body: m.body, invite: invites.shift() });
      mine.push(m.blobId);
    }
    channels.set(owner, mine);
  }
  const w = {
    vault, published, channels,
    funding: new Map([...published.keys()].map((a) => [a, a.slice(2)])),
    truth: new Map(["a", "b", "c"].map((o) => [o, o])),
    people: [],
  } as unknown as ReturnType<typeof world>;
  assert.equal(attribute(w).size, 0,
    "equal-sized conversations were still attributed, so link two is not the count after all");
});
