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
import { coverBody, coverId, COVER_RATE, NO_CHAIN } from "../../channel/src/cover.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { recoverBlobId } from "../../channel/src/pointer.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { ephemeral } from "../../handshake/src/authorship.ts";

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
  const config = { blockMs: BLOCK, channel, author: ephemeral() };
  const events: number[] = [];
  const arrivals: Arrival[] = [];

  const sent = [];
  for (let seq = 0; seq < MESSAGES; seq++) {
    const publishedAt = seq * BLOCK;
    events.push(publishedAt);
    const out = send(config, new TextEncoder().encode(`message number ${seq}`), seq, publishedAt, random);
    sent.push(out);
    arrivals.push({ at: out.uploadAt, id: out.blobId, bytes: out.body.length, real: true, seq });
  }

  if (withCover) {
    // Derived from the messages, so each decoy is the size of something it could be hiding.
    for (const decoy of cover(config, sent, random)) {
      const body = coverBody(channel, decoy.bucket, decoy.index, decoy.salt);
      arrivals.push({ at: decoy.at, id: coverId(body), bytes: body.length, real: false, seq: -1 });
    }
  }

  arrivals.sort((a, b) => a.at - b.at);
  return { events, arrivals, channel, config, sent };
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
        : coverBody(channel, BUCKETS[0], a.seq >= 0 ? a.seq : i, NO_CHAIN);
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
  // The MESSAGES THEMSELVES, not a re-send of the same text. `send` is no longer reproducible:
  // every message carries a fresh blind inside the sealed frame, and `sealForChannel` derives
  // its nonce from the plaintext — so identical words now produce a different ciphertext and a
  // different id every time. Re-sending to recover a pointer used to work and quietly stopped.
  const { arrivals, sent, channel } = conversation(lcg(31), true);
  const real = arrivals.filter((a) => a.real);
  const stored = new Set(arrivals.map((a) => a.id));

  for (const out of sent) {
    const a = real.find((r) => r.seq === out.seq)!;
    const recovered = Buffer.from(recoverBlobId(channel, out.pointer, out.seq)).toString("hex");
    assert.equal(`enc:${recovered}`, a.id, `message ${out.seq} is unreachable from its pointer`);
    assert.ok(stored.has(a.id));
  }
});

// ---------------------------------------------------------------------------
// Mixed message sizes, through the real client and the real vault
// ---------------------------------------------------------------------------

/** A conversation where the messages are not all the same size — the realistic case. */
function mixedConversation(random: () => number, withCover: boolean) {
  const channel = openChannel(vaultRoot, "alice→bob");
  const config = { blockMs: BLOCK, channel, author: ephemeral() };
  // One long message among short ones. Before cover carried its bucket, this was the message
  // an operator could pick out by size alone, every time.
  const sizes = [40, 60, 20_000, 55, 30, 45, 70, 25];
  const sent = sizes.map((n, seq) =>
    send(config, new Uint8Array(n).fill(seq + 1), seq, seq * BLOCK, random));
  const arrivals: Arrival[] = sent.map((out, seq) => ({
    at: out.uploadAt, id: out.blobId, bytes: out.body.length, real: true, seq,
  }));
  if (withCover) {
    for (const decoy of cover(config, sent, random)) {
      const body = coverBody(channel, decoy.bucket, decoy.index, decoy.salt);
      arrivals.push({ at: decoy.at, id: coverId(body), bytes: body.length, real: false, seq: -1 });
    }
  }
  arrivals.sort((a, b) => a.at - b.at);
  return { events: sizes.map((_, i) => i * BLOCK), arrivals, sent, channel, config };
}

test("the odd-sized message is not alone in its size band", () => {
  // The composition check for the bucket fix. An operator's first move is to sort by size, so
  // what matters is how many candidates remain after it does.
  const { arrivals, sent } = mixedConversation(lcg(41), true);
  const large = sent[2].body.length;
  const inBand = arrivals.filter((a) => a.bytes === large);
  assert.ok(inBand.length > 1, "the large message is the only upload of its size");
  assert.equal(inBand.filter((a) => a.real).length, 1);
  assert.equal(inBand.filter((a) => !a.real).length, COVER_RATE,
    `the large message got ${inBand.filter((a) => !a.real).length} decoys, expected ${COVER_RATE}`);
});

test("an operator that sorts by size first still cannot pick the odd message out", () => {
  // Scored the way the attack actually runs: restrict to the size band, then match on timing.
  // Without cover in that band the answer is 1.000 — that is what this is defending against.
  const random = lcg(43);
  let hits = 0;
  const trials = 400;
  for (let t = 0; t < trials; t++) {
    const { arrivals, sent } = mixedConversation(random, true);
    const large = sent[2].body.length;
    const band = arrivals.filter((a) => a.bytes === large);
    let best: Arrival | null = null;
    let gap = Infinity;
    for (const a of band) {
      const d = Math.abs(a.at - 2 * BLOCK);
      if (d < gap) { gap = d; best = a; }
    }
    if (best?.real) hits++;
  }
  const rate = hits / trials;
  assert.ok(rate < 0.35, `the odd-sized message is identified ${rate.toFixed(3)} of the time`);
});

test("without the bucket carried, the same attack succeeds every time", () => {
  // The teeth. Reproduces the defect by covering everything in the smallest band, which is what
  // the old API made natural — and shows the attack going to 1.000.
  const random = lcg(43);
  const { arrivals, sent } = mixedConversation(random, false);
  const channel = openChannel(vaultRoot, "alice→bob");
  // Cover, but all of it in the wrong band.
  for (let i = 0; i < COVER_RATE * sent.length; i++) {
    const body = coverBody(channel, BUCKETS[0], 0, NO_CHAIN);
    arrivals.push({ at: random() * 8 * BLOCK, id: coverId(body), bytes: body.length, real: false, seq: -1 });
  }
  const large = sent[2].body.length;
  const band = arrivals.filter((a) => a.bytes === large);
  assert.equal(band.length, 1, "mis-banded cover should leave the large message alone");
  assert.equal(band[0].real, true, "and the single candidate is the message itself");
});

test("every message the client sends is uploadable and findable, mixed sizes included", () => {
  // The defence must not break the product. Every size still round-trips through the vault.
  const { arrivals, sent, channel } = mixedConversation(lcg(47), true);
  const vault = new Vault({ invites: arrivals.map((_, i) => `mx-${i}`), buckets: BUCKETS });
  let i = 0;
  for (const out of sent) {
    const res = vault.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: out.blobId, body: out.body, invite: `mx-${i++}`,
    });
    assert.equal(res.ok, true, `a ${out.body.length}-byte upload was refused`);
  }
  for (const [seq, out] of sent.entries()) {
    const recovered = Buffer.from(recoverBlobId(channel, out.pointer, seq)).toString("hex");
    assert.equal(`enc:${recovered}`, out.blobId, `message ${seq} is unreachable from its pointer`);
  }
});
