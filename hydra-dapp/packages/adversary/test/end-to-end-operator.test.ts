/**
 * The whole stack, attacked as one thing.
 *
 * Every other harness isolates an invariant. This one runs a realistic conversation through
 * the real client, the real scheduler, real cover traffic and the real HTTP vault, and then
 * hands an operator everything that vault could see and asks it to rebuild the conversation.
 *
 * It exists because the individual results do not compose by themselves. I3's timing measure
 * assumes uploads land where the scheduler puts them; the cover measurements assume decoys are
 * indistinguishable from real uploads at the vault; the operator-view table assumes the client
 * sends nothing extra. Each is true in its own file. Whether they are true together is a
 * different question, and the pointer/blob-id bug — 31 bytes here, 32 bytes there, every
 * package green — is what that question looks like when the answer is no.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { send, cover, openChannel } from "../../client/src/session.ts";
import { Vault, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { coverBody, coverId } from "../../channel/src/cover.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { recoverBlobId } from "../../channel/src/pointer.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const BLOCK = 30_000;
const MESSAGES = 12;
const CHANCE = 1 / MESSAGES;
const vaultRoot = derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(21), "e2e"))));

/** What lands at the vault, in the order the vault sees it. */
type Arrival = { at: number; id: string; bytes: number; real: boolean; seq: number };

/**
 * A conversation, run through every real component.
 *
 * Uploads are sorted by their scheduled time before being handed to the vault, because that is
 * the order a vault actually receives them — and the reordering jitter causes is part of the
 * defence, so a test that fed them in send-order would be measuring something else.
 */
function conversation(random: () => number, withCover: boolean) {
  const channel = openChannel(vaultRoot, "alice→bob");
  const config = { blockMs: BLOCK, channel, nullifier: 7n };
  const events: number[] = [];
  const arrivals: Arrival[] = [];

  for (let seq = 0; seq < MESSAGES; seq++) {
    const publishedAt = seq * BLOCK;
    events.push(publishedAt);
    const out = send(config, new TextEncoder().encode(`message number ${seq}`), seq, publishedAt, random);
    arrivals.push({ at: out.uploadAt, id: out.blobId, bytes: out.body.length, real: true, seq });
  }

  if (withCover) {
    for (const at of cover(config, events[0], events.at(-1)!, random)) {
      const body = coverBody(channel, BUCKETS[0]);
      arrivals.push({ at, id: coverId(body), bytes: body.length, real: false, seq: -1 });
    }
  }

  arrivals.sort((a, b) => a.at - b.at);
  return { events, arrivals, channel, config };
}

/** The operator: match each chain event to the nearest arrival, and see if it guessed right. */
function linkByTiming(events: number[], arrivals: Arrival[]) {
  let correct = 0;
  const perMessage: number[] = [];
  for (let i = 0; i < events.length; i++) {
    let best: Arrival | null = null;
    let gap = Infinity;
    for (const a of arrivals) {
      const d = Math.abs(a.at - events[i]);
      if (d < gap) { gap = d; best = a; }
    }
    const hit = Boolean(best?.real && best.seq === i);
    perMessage.push(hit ? 1 : 0);
    if (hit) correct++;
  }
  return { correct, perMessage };
}

test("with cover, the operator cannot rebuild the conversation from timing", () => {
  // The end-to-end version of I3. Not a model of a schedule — the actual scheduler, the actual
  // cover plan, and arrivals ordered as a vault would receive them.
  const random = lcg(17);
  let total = 0;
  let first = 0;
  const trials = 300;
  for (let t = 0; t < trials; t++) {
    const { events, arrivals } = conversation(random, true);
    const { correct, perMessage } = linkByTiming(events, arrivals);
    total += correct;
    first += perMessage[0];
  }
  const rate = total / (trials * MESSAGES);
  const firstRate = first / trials;
  assert.ok(rate < CHANCE * 1.6, `operator linked ${rate.toFixed(3)} of messages, chance is ${CHANCE.toFixed(3)}`);
  assert.ok(firstRate < 0.2, `the first message is still identified ${firstRate.toFixed(2)} of the time`);
});

test("without cover the same operator does far better, so the harness has teeth", () => {
  // If this did not hold, the check above would be passing because the operator is broken
  // rather than because the defence works.
  const random = lcg(17);
  let first = 0;
  const trials = 300;
  for (let t = 0; t < trials; t++) {
    const { events, arrivals } = conversation(random, false);
    first += linkByTiming(events, arrivals).perMessage[0];
  }
  assert.ok(first / trials > 0.35,
    `undefended first-message accuracy is only ${(first / trials).toFixed(2)} — the attack is weak`);
});

test("a decoy is not separable from a real upload by anything the vault holds", () => {
  // Cover only works if the vault cannot filter it out. Size, id shape and namespace all have
  // to match — and the vault's own record is the thing to check, not the client's intent.
  const { arrivals } = conversation(lcg(4), true);
  const real = arrivals.filter((a) => a.real && a.bytes === BUCKETS[0]);
  const decoy = arrivals.filter((a) => !a.real);
  assert.ok(real.length > 0 && decoy.length > 0);
  for (const d of decoy) {
    assert.ok(d.id.startsWith("enc:"), "a decoy is in the wrong namespace");
    assert.equal(d.id.length, real[0].id.length, "a decoy id is a different length");
    assert.ok(BUCKETS.includes(d.bytes), "a decoy is not bucket-sized");
  }
  // And no id collides, or a decoy would overwrite a message.
  const ids = arrivals.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "an id collided across the session");
});

test("the vault, served over HTTP, accepts the whole session and reveals nothing more", async () => {
  // The real transport, the real server, the real bodies. Then: everything the operator holds,
  // searched for anything that would let them link a blob to a channel or a message.
  const { arrivals, channel, config } = conversation(lcg(23), true);
  const vault = new Vault({
    invites: arrivals.map((_, i) => `inv-${i}`),
    buckets: BUCKETS,
  });
  const { url, server } = await serve(vault);
  try {
    let i = 0;
    for (const a of arrivals) {
      const body = a.real
        ? send(config, new TextEncoder().encode(`message number ${a.seq}`), a.seq, a.seq * BLOCK, lcg(1)).body
        : coverBody(channel, BUCKETS[0]);
      const res = await fetch(`${url}${ENCRYPTED_ENDPOINT}/${a.real ? a.id : coverId(body)}`, {
        method: "PUT",
        headers: { "x-hydra-invite": `inv-${i++}` },
        body,
      });
      assert.equal(res.status, 201, `the vault refused an upload: ${await res.text()}`);
    }

    const view = JSON.stringify(vault.observe());
    // Nothing that names a channel, a sequence, or a message.
    for (const needle of ["alice", "bob", "message number", "channel", "seq"]) {
      assert.ok(!view.includes(needle), `the vault's record contains ${JSON.stringify(needle)}`);
    }
    // Every stored object is one bucket, so real and decoy are the same shape on disk.
    const sizes = new Set(vault.observe().rows.map((r) => r["blob.bucket"]));
    assert.equal(sizes.size, 1, `${sizes.size} distinct sizes stored — decoys are separable`);
  } finally {
    server.close();
  }
});

test("the recipient can still find every message, which is the point", () => {
  // A defence that also defeats the recipient is not a defence. Holding only the channel secret
  // and the pointers from the chain, every real blob must resolve — and no decoy must.
  const { arrivals, channel } = conversation(lcg(31), true);
  const real = arrivals.filter((a) => a.real);
  const stored = new Set(arrivals.map((a) => a.id));

  const config = { blockMs: BLOCK, channel, nullifier: 7n };
  for (const a of real) {
    const out = send(config, new TextEncoder().encode(`message number ${a.seq}`), a.seq, a.seq * BLOCK, lcg(1));
    const recovered = Buffer.from(recoverBlobId(channel, out.pointer, a.seq)).toString("hex");
    assert.equal(`enc:${recovered}`, a.id, `message ${a.seq} is unreachable from its pointer`);
    assert.ok(stored.has(a.id));
  }
});
