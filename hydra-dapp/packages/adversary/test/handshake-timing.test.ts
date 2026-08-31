/**
 * Opening a conversation, as two records that happen at the same moment.
 *
 * `decisions/0013` put the prekey inbox on the derivable table: an observer holding a published
 * identity key sees that someone is reachable, how many first messages wait for them, and when
 * the mailbox is written to. `inbox.sender` says the vault cannot tell who wrote — the slot is
 * addressed by its recipient, and nothing about the sender decides where it lands.
 *
 * That is true of the vault ALONE. The chain names whoever published a pointer
 * (`live-authorship.test.ts`, 1.000), and opening a conversation does both things: a write to
 * the recipient's mailbox, and then a first message whose pointer goes on chain. If those two
 * happen close together, the observer with both records does not need the vault to name the
 * sender — the chain names them, and the clock joins the two.
 *
 * MESSAGE UPLOADS ARE DEFENDED AND THIS WRITE IS NOT. Every message upload is scheduled into a
 * jitter window with decoys around it; `postPrekey` writes immediately. That asymmetry is what
 * this file measures.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initiate, bundleFor } from "../../handshake/src/x3dh.ts";
import { inboxSlots, postPrekey, INBOX_SLOTS } from "../../handshake/src/inbox.ts";
import type { Transport } from "../../handshake/src/inbox.ts";
import { jitterWindowMs, MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

const BLOCK = 30_000;
const cfg = { blockMs: BLOCK };

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const rootOf = (n: number, label: string) =>
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(n), label))));

const recipient = rootOf(91, "recipient");
const recipientKey = bundleFor(recipient, 0, 0).identityKey;

/** A transport that records when each slot was written, which is what the operator sees. */
function timedTransport(clock: () => number) {
  const writtenAt = new Map<string, number>();
  const transport: Transport = {
    async put(id) { writtenAt.set(id, clock()); return true; },
    async get(ids) { return new Map([...writtenAt.keys()].filter((k) => ids.includes(k)).map((k) => [k, new Uint8Array(0)])); },
  };
  return { transport, writtenAt };
}

/**
 * Several people open conversations with the same recipient.
 *
 * Each writes a slot and then publishes a first pointer on chain. The gap between the two is
 * what a client controls; everything else here is the observer's arithmetic.
 */
async function openings(count: number, gapMs: number, spreadMs: number, random: () => number) {
  const { transport, writtenAt } = timedTransport(() => now);
  let now = 0;
  const chain: { author: string; at: number }[] = [];
  const truth = new Map<string, string>();

  for (let i = 0; i < count; i++) {
    now = Math.floor(random() * spreadMs);
    const author = `author-${i}`;
    const before = new Set(writtenAt.keys());
    await postPrekey(transport, recipientKey, initiate(rootOf(100 + i, author), bundleFor(recipient, 0, i)).message, random2(random));
    const slot = [...writtenAt.keys()].find((k) => !before.has(k))!;
    truth.set(slot, author);
    chain.push({ author, at: now + gapMs });
  }
  return { writtenAt, chain, truth };
}

const random2 = (r: () => number) => (n: number) => Math.floor(r() * n);

/** The attack: for each mailbox write, the chain publish nearest after it. */
function nearestAuthor(
  writtenAt: Map<string, number>,
  chain: { author: string; at: number }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [slot, at] of writtenAt) {
    let best = "";
    let gap = Infinity;
    for (const e of chain) {
      const d = e.at - at;
      if (d >= 0 && d < gap) { gap = d; best = e.author; }
    }
    out.set(slot, best);
  }
  return out;
}

const accuracy = (guess: Map<string, string>, truth: Map<string, string>): number => {
  let right = 0;
  for (const [slot, author] of truth) if (guess.get(slot) === author) right++;
  return right / truth.size;
};

test("THE FINDING: an immediate write names the opener via the chain", async () => {
  // What the CLI does today: `hydra invite` writes the slot, `hydra send` publishes moments
  // later. The observer never asks the vault who wrote — the chain says, and the clock joins.
  const random = lcg(3);
  let total = 0;
  const TRIALS = 40;
  for (let t = 0; t < TRIALS; t++) {
    const { writtenAt, chain, truth } = await openings(6, 5_000, 6 * 60 * 60 * 1000, random);
    total += accuracy(nearestAuthor(writtenAt, chain), truth);
  }
  const rate = total / TRIALS;
  assert.ok(rate > 0.9,
    `the nearest-publish attack identified the opener ${(rate * 100).toFixed(0)}% of the time; `
    + "if this has dropped, the write is being scheduled and this file is stale");
});

test("the defence message uploads already have would blunt it", async () => {
  // Not a proposal in code — a measurement of what the existing mechanism is worth here. If the
  // mailbox write were scheduled into the same jitter window an upload gets, the gap between
  // write and publish would be minutes of uniform noise rather than seconds.
  const random = lcg(5);
  const window = jitterWindowMs(cfg);
  assert.equal(window, MIN_JITTER_BLOCKS * BLOCK);

  let immediate = 0;
  let jittered = 0;
  const TRIALS = 40;
  for (let t = 0; t < TRIALS; t++) {
    // Openers arrive within one jitter window of each other — the case that matters, because
    // conversations hours apart are separable by the clock no matter what.
    const a = await openings(6, 5_000, window, random);
    immediate += accuracy(nearestAuthor(a.writtenAt, a.chain), a.truth);

    const b = await openings(6, 5_000, window, random);
    // Move each write to a uniform point in the window before its own publish.
    const shifted = new Map([...b.writtenAt].map(([slot, at]) =>
      [slot, at - Math.floor(random() * window)]));
    jittered += accuracy(nearestAuthor(shifted, b.chain), b.truth);
  }
  assert.ok(immediate / TRIALS > jittered / TRIALS,
    `scheduling the write did not help: ${(immediate / TRIALS).toFixed(2)} vs `
    + `${(jittered / TRIALS).toFixed(2)}`);
});

test("conversations far apart are separable whatever the client does", async () => {
  // The boundary. If nobody else opens a conversation with this recipient for hours, the only
  // publish anywhere near the write is the right one, and no jitter within a window fixes that.
  // What would is other people opening conversations — an anonymity set the client cannot make
  // for itself.
  const random = lcg(7);
  const { writtenAt, chain, truth } = await openings(1, 5_000, 1, random);
  assert.equal(accuracy(nearestAuthor(writtenAt, chain), truth), 1);
  assert.equal(truth.size, 1);
});

test("the mailbox holds enough slots for the crowd this needs", () => {
  // Stated because the previous test's mitigation is other people. A mailbox that ran out would
  // cap the anonymity set at whatever fits.
  assert.ok(INBOX_SLOTS >= 32, `${INBOX_SLOTS} slots is a small crowd to hide in`);
  assert.equal(new Set(inboxSlots(recipientKey)).size, INBOX_SLOTS);
});
