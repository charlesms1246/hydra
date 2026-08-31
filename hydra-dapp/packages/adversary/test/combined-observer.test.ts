/**
 * One party with both views: the vault's traffic and the chain's.
 *
 * Every harness in this directory models one observer. The upload/event correlation is measured
 * against a vault operator who does not know who published anything; the sender disclosure is
 * measured against a chain reader who cannot see the vault. Nobody had modelled the party who
 * has both, and there is nothing exotic about them — a vault operator with a browser is one.
 *
 * WHAT EACH SIDE ALREADY GIVES UP, both measured elsewhere and both published:
 *
 *   chain    who published each pointer, and when       (1.000, `live-authorship.test.ts`)
 *   vault    which blobs form one channel               (1.000, `i3-batch-membership.test.ts`)
 *   vault    which upload belongs to which event        (0.2,   `i3-cover-traffic.test.ts`)
 *
 * The third number is the one every cover figure rests on, and it is about matching ITEMS: this
 * upload to that event. The combined observer does not have to do that. They hold two
 * partitions of the same conversation — a set of blobs per channel, and a set of events per
 * author — and matching SETS is a different and much easier problem. Cardinality alone is often
 * enough, and no amount of jitter or cover touches it, because cover is per event and therefore
 * proportional.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { send, cover, openChannel } from "../../client/src/session.ts";
import { readSet } from "../../client/src/read.ts";
import { Vault, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";
import { coverBody, coverId } from "../../channel/src/cover.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { ephemeral } from "../../handshake/src/authorship.ts";

const BLOCK = 30_000;

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

type Person = { name: string; counts: number; start: number };

/**
 * A world with several people talking, and the two records it leaves.
 *
 * `chainBySender` is what a chain reader gets: event times, grouped by the account that
 * published them, because the transaction says so. `blobsByChannel` is what the vault operator
 * gets: upload times grouped by channel, because a read batch is a channel.
 */
function world(people: readonly Person[], random: () => number) {
  const invites = Array.from({ length: 2000 }, (_, i) => `w-${i}`);
  const vault = new Vault({ invites: [...invites], buckets: BUCKETS });

  const chainBySender = new Map<string, number[]>();
  const blobsByChannel = new Map<string, string[]>();
  const uploadedAt = new Map<string, number>();

  for (const person of people) {
    const channel = openChannel(derive(VAULT_DOMAIN,
      rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(person.counts + 70), person.name)))),
      person.name);
    const config = { channel, author: ephemeral(), blockMs: BLOCK };
    const messages = Array.from({ length: person.counts }, (_, seq) =>
      send(config, new TextEncoder().encode(`${person.name} ${seq}`), seq,
        person.start + seq * BLOCK * 3, random));

    chainBySender.set(person.name, messages.map((m) => m.publishedAt));

    const mine: string[] = [];
    for (const m of messages) {
      vault.handle({
        op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: m.blobId, body: m.body,
        invite: invites.shift(),
      });
      uploadedAt.set(m.blobId, m.uploadAt);
      mine.push(m.blobId);
    }
    for (const d of cover(config, messages, random)) {
      const body = coverBody(channel, d.bucket, d.index);
      const id = coverId(body);
      vault.handle({
        op: "upload", endpoint: ENCRYPTED_ENDPOINT, id, body, invite: invites.shift(),
      });
      uploadedAt.set(id, d.at);
      mine.push(id);
    }

    // The operator learns this grouping from one read batch — see `i3-batch-membership`.
    const seen = messages.map((m) => ({ seq: m.seq, pointer: m.pointer as unknown as Uint8Array }));
    const batch = new Set(readSet(channel, seen));
    blobsByChannel.set(person.name, mine.filter((id) => batch.has(id)));
  }
  return { chainBySender, blobsByChannel, uploadedAt };
}

/**
 * Match channels to authors by SET SIZE.
 *
 * The whole attack. A channel of n messages produces n * (coverRate + 1) objects, because cover
 * is per event; an author of n messages produces n chain events. Dividing gives the message
 * count back, and the count is a fingerprint.
 */
function bySetSize(w: ReturnType<typeof world>, coverRate: number): Map<string, string> {
  const out = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const [sender, events] of w.chainBySender) sizes.set(sender, events.length);
  for (const [channel, blobs] of w.blobsByChannel) {
    const implied = blobs.length / (coverRate + 1);
    const match = [...sizes].filter(([, n]) => n === implied).map(([s]) => s);
    if (match.length === 1) out.set(channel, match[0]);
  }
  return out;
}

/** Match by when the traffic happened: the earliest upload against the earliest event. */
function byTime(w: ReturnType<typeof world>): Map<string, string> {
  const firstEvent = [...w.chainBySender]
    .map(([s, e]) => [s, Math.min(...e)] as const)
    .sort((a, b) => a[1] - b[1]);
  const firstUpload = [...w.blobsByChannel]
    .map(([c, ids]) => [c, Math.min(...ids.map((id) => w.uploadedAt.get(id)!))] as const)
    .sort((a, b) => a[1] - b[1]);
  return new Map(firstUpload.map(([c], i) => [c, firstEvent[i][0]]));
}

const accuracy = (guess: Map<string, string>, people: readonly Person[]): number => {
  let right = 0;
  for (const p of people) if (guess.get(p.name) === p.name) right++;
  return right / people.length;
};

const COVER_RATE = 4;

test("THE FINDING: matching sets by size links every channel to its author", () => {
  // Realistic: people send different numbers of messages. Nothing here matches an upload to an
  // event — the 0.2 figure is untouched and irrelevant, because the attack never asks that
  // question.
  const people: Person[] = [
    { name: "a", counts: 3, start: 0 },
    { name: "b", counts: 5, start: 0 },
    { name: "c", counts: 8, start: 0 },
    { name: "d", counts: 12, start: 0 },
  ];
  const w = world(people, lcg(3));
  assert.equal(accuracy(bySetSize(w, COVER_RATE), people), 1,
    "set-size matching no longer links channels to authors; recheck what changed");
});

test("cover does not help, because cover is proportional", () => {
  // The reason the defence is irrelevant rather than merely weak. Cover is `coverRate` decoys
  // PER EVENT, so a channel's object count is the message count times a public constant. The
  // padding scales with the thing it is hiding.
  const people: Person[] = [{ name: "a", counts: 7, start: 0 }, { name: "b", counts: 2, start: 0 }];
  const w = world(people, lcg(5));
  for (const [channel, blobs] of w.blobsByChannel) {
    const events = w.chainBySender.get(channel)!.length;
    assert.equal(blobs.length, events * (COVER_RATE + 1),
      "the object count is no longer a fixed multiple of the message count");
  }
});

test("equal message counts defeat the size attack, and timing finishes the job", () => {
  // The case that should be hardest: everyone sends the same number of messages, so cardinality
  // says nothing. Conversations that happen at different times are still separable, because an
  // upload cannot precede its own event and a jitter window is minutes while a conversation is
  // days.
  const people: Person[] = [
    { name: "a", counts: 4, start: 0 },
    { name: "b", counts: 4, start: 40 * BLOCK * 24 },
    { name: "c", counts: 4, start: 80 * BLOCK * 24 },
  ];
  const w = world(people, lcg(7));
  assert.equal(bySetSize(w, COVER_RATE).size, 0, "sizes were meant to be indistinguishable here");
  assert.equal(accuracy(byTime(w), people), 1,
    "conversations days apart are no longer separable by when they happened");
});

test("simultaneous conversations of equal size are where it finally fails", () => {
  // The boundary, stated so the finding is not overclaimed. Same count, same window: neither
  // cardinality nor first-event ordering separates them, and the observer is back to matching
  // items — which is the problem the published 0.2 is about.
  const people: Person[] = [
    { name: "a", counts: 4, start: 0 },
    { name: "b", counts: 4, start: 0 },
    { name: "c", counts: 4, start: 0 },
  ];
  const w = world(people, lcg(11));
  assert.equal(bySetSize(w, COVER_RATE).size, 0);
  const timed = accuracy(byTime(w), people);
  assert.ok(timed < 1,
    `even simultaneous equal-size conversations were matched ${timed} of the time`);
});

test("neither view alone does this", () => {
  // Worth pinning: this is a property of holding BOTH records, not a new weakness in either.
  const people: Person[] = [
    { name: "a", counts: 3, start: 0 },
    { name: "b", counts: 9, start: 0 },
  ];
  const w = world(people, lcg(13));

  // The chain alone: counts per author, and no blobs to attach them to.
  assert.deepEqual([...w.chainBySender].map(([s, e]) => [s, e.length]), [["a", 3], ["b", 9]]);
  // The vault alone: sets of blobs with no author to attach them to. The sizes are there, but
  // there is nothing on this side that says whose they are.
  for (const [, blobs] of w.blobsByChannel) {
    assert.ok(blobs.every((id) => id.startsWith("enc:")));
  }
  // Together, the sizes are a join key.
  assert.equal(accuracy(bySetSize(w, COVER_RATE), people), 1);
});
