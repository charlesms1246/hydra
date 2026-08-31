/**
 * Forward secrecy, measured against the file it is supposed to protect.
 *
 * `decisions/0020` settled the shape — store and delete, because a key you can regenerate is a
 * key you have not deleted — and fixed it for prekeys. Message keys stayed derivable: a channel
 * was one secret, every message sealed under it, and the secret sat in the state file. Taking the
 * device at message fifty opened all fifty.
 *
 * The adversary here is exactly that and nothing more exotic: **someone who has the state file
 * and the vault's stored objects.** They are the two things that actually exist. The test sweeps
 * every secret in the file against an old message's ciphertext and requires all of them to fail.
 *
 * WHAT IS NOT CLAIMED. This is the symmetric half of the Double Ratchet, so there is no
 * post-compromise security: an attacker who takes the file at message fifty reads fifty-one
 * onwards. That needs a Diffie-Hellman step per ratchet and a header saying which key was used,
 * and a header is a new thing for the vault operator to look at. Named in
 * `handshake/src/ratchet.ts`, not implied here.
 *
 * AND THE TRANSCRIPT IS IN THE SAME FILE. The client keeps the plaintext it has read, so an
 * attacker with the file reads the past from there rather than from the vault. What changed is
 * that **deleting it now works**: before, any deleted message could be re-derived and re-fetched,
 * so deletion was theatre.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { init, open, accept, publishBundle, sendMessage, flush, readChannel }
  from "../../cli/src/commands.ts";
import { memoryChain } from "../../cli/src/chain.ts";
import { Vault, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { openForChannel } from "../../vault-client/src/blobs.ts";
import { newChain, keyFor, packChain, forgetOldSkipped } from "../../handshake/src/ratchet.ts";
import { derive, rootSeed, entropyFrom, fromTestVector, subKey, expose, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import type { State } from "../../cli/src/state.ts";

const BLOCK = 30_000;
const T0 = 1_800_000_000_000;
const WHERE = "test";

const root = (n: number) =>
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(n), "ratchet"))));

const bytesOf = (s: ReturnType<typeof root>) => Buffer.from(expose(s, VAULT_DOMAIN)).toString("hex");

async function stack(n = 2000) {
  const invites = Array.from({ length: n }, (_, i) => `r-${i}`);
  const v = new Vault({ invites: [...invites], buckets: BUCKETS });
  const { url, server } = await serve(v, 0, { rateLimit: { mode: "none" } });
  const alice = init({ vaultUrl: url, blockMs: BLOCK, invites: invites.slice(0, n / 2) });
  const bob = init({ vaultUrl: url, blockMs: BLOCK, invites: invites.slice(n / 2) });
  accept(bob, "alice", open(alice, "bob", publishBundle(bob, 0)));
  return { alice, bob, v, server, chain: memoryChain() };
}

// ---------------------------------------------------------------------------
// The chain itself
// ---------------------------------------------------------------------------

test("the same sequence gives the same key whether it was stepped to or skipped over", () => {
  // THE BUG THIS PINS, and it cost an afternoon. `packChain` and `unpackChain` are not inverses —
  // a Secret is only reachable through the entropy adapters, so unpacking DERIVES rather than
  // restores. That is fine while everything is packed equally often, and the first version was
  // not: a key taken straight off the chain came back as a Secret, and the same key skipped and
  // stored came back through one more round trip. Two keys, one sequence number, and every
  // message failing to authenticate with both ends holding identical chains.
  const seed = subKey(root(3), "chain");
  const walked = newChain(seed);
  const jumped = newChain(seed);

  // One walks 0,1,2. The other jumps to 2 and comes back for 0 and 1 out of the skipped set.
  const direct = [0, 1, 2].map((n) => bytesOf(keyFor(walked, n, WHERE)!));
  const two = bytesOf(keyFor(jumped, 2, WHERE)!);
  const zero = bytesOf(keyFor(jumped, 0, WHERE)!);
  const one = bytesOf(keyFor(jumped, 1, WHERE)!);
  assert.deepEqual([zero, one, two], direct,
    "a skipped key differs from the same key stepped to — the two paths are not packed alike");
});

test("a key is gone once it is used, and every sequence has its own", () => {
  const chain = newChain(subKey(root(4), "chain"));
  const keys = [0, 1, 2, 3].map((n) => bytesOf(keyFor(chain, n, WHERE)!));
  assert.equal(new Set(keys).size, 4, "two sequences shared a message key");
  for (const n of [0, 1, 2, 3]) {
    assert.equal(keyFor(chain, n, WHERE), null,
      `sequence ${n} handed out its key twice — nothing was deleted`);
  }
  // And the chain key itself has moved on, so the file no longer contains what made them.
  assert.equal(chain.next, 4);
  assert.deepEqual(chain.skipped, {});
});

test("a late message is still readable, because uploads are late on purpose", () => {
  // An upload lands up to eight block intervals after its own chain event, so a reader routinely
  // sees message 7 before message 6. Advancing past 6 without keeping its key would make a late
  // message permanently unreadable — forward secrecy indistinguishable from data loss.
  const chain = newChain(subKey(root(5), "chain"));
  const seven = bytesOf(keyFor(chain, 7, WHERE)!);
  assert.equal(Object.keys(chain.skipped).length, 7);
  const six = keyFor(chain, 6, WHERE);
  assert.ok(six, "the key for a message that had not arrived yet was thrown away");
  assert.notEqual(bytesOf(six), seven);
  assert.equal(Object.keys(chain.skipped).length, 6, "using a skipped key did not consume it");
});

test("skipped keys are bounded, because a kept key is a key not deleted", () => {
  const chain = newChain(subKey(root(6), "chain"));
  keyFor(chain, 40, WHERE);
  assert.equal(Object.keys(chain.skipped).length, 40);
  assert.equal(forgetOldSkipped(chain, 10), 30);
  assert.deepEqual(Object.keys(chain.skipped).map(Number).sort((a, b) => a - b),
    Array.from({ length: 10 }, (_, i) => 30 + i),
    "the wrong end of the skipped set was dropped — the recent ones are the ones worth keeping");
});

test("an absurd sequence number does not spin the chain", () => {
  // Any stranger can write a plausible-looking prekey message into a mailbox slot, and any
  // sequence number can be claimed. Without a bound this walks for as long as the number says.
  const chain = newChain(subKey(root(7), "chain"));
  assert.equal(keyFor(chain, 10_000_000, WHERE), null);
  assert.equal(chain.next, 0, "the chain advanced on a sequence number it refused");
});

// ---------------------------------------------------------------------------
// Against the real client
// ---------------------------------------------------------------------------

/** Everything secret in a channel's stored state, as `Secret`s to try. */
const everySecret = (state: State, name: string) => {
  const c = state.channels[name];
  const hexes = [
    c.addressSendHex, c.addressRecvHex, c.send.chainHex, c.recv.chainHex,
    ...Object.values(c.send.skipped), ...Object.values(c.recv.skipped),
  ];
  return hexes.map((h) => derive(VAULT_DOMAIN,
    rootSeed(entropyFrom(fromTestVector(new Uint8Array(Buffer.from(h, "hex")), "seized")))));
};

test("no key left in the state file opens a message already read", async () => {
  const s = await stack();
  try {
    // Twenty messages one way, all read.
    for (let i = 0; i < 20; i++) {
      await sendMessage(s.alice, s.chain, "bob", `message ${i}`, T0 + i * BLOCK);
      await flush(s.alice, T0 + (i + 20) * BLOCK);
    }
    const read = await readChannel(s.bob, s.chain, "alice");
    assert.equal(read.length, 20);

    // The adversary: bob's file as it stands, plus the vault's objects. Message 5's ciphertext
    // is still in the vault — content-addressed storage does not forget.
    const early = read[5];
    // Padded to the read floor, because the encrypted endpoint refuses a batch narrower than
    // eight — the `read.target` defence, working on the adversary as much as on a client.
    const stored = s.v.handle({
      op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: read.slice(0, 8).map((m) => m.id),
    });
    assert.ok(stored.ok && stored.op === "fetch");
    const body = stored.found.get(early.id)!;
    assert.ok(body.length > 0, "the vault no longer has the object, so this proves nothing");

    for (const secret of everySecret(s.bob, "alice")) {
      assert.throws(() => openForChannel(secret, body),
        "a secret still in the state file opened a message read fifteen messages ago");
    }
    // And the ratchet refuses to make the key again.
    assert.equal(keyFor(s.bob.channels.alice.recv, 5, WHERE), null);

    // The words survive only in the transcript, which is the point of keeping one — and why
    // deleting from it is now a real deletion rather than theatre.
    assert.equal(early.text, "message 5");
  } finally { s.server.close(); }
});

test("two messages never seal under one key", async () => {
  const s = await stack();
  try {
    // The regression guard for `SessionConfig.content` being optional: a client that forgot to
    // pass a ratchet key would seal everything under the addressing key and every test above
    // would still pass.
    for (let i = 0; i < 3; i++) {
      await sendMessage(s.alice, s.chain, "bob", "the same words every time", T0 + i * BLOCK);
    }
    const real = s.alice.pending.filter((p) => p.real);
    assert.equal(real.length, 3);
    assert.equal(new Set(real.map((p) => p.bodyB64)).size, 3,
      "identical plaintext produced identical ciphertext — the content key is not advancing");
    // Deterministic encryption within a channel is a known cost of content addressing
    // (`decisions/0004`), and the ratchet is what limits it to a single sequence number.
  } finally { s.server.close(); }
});

test("the agreed material is not in the file, because keeping it would undo all of this", async () => {
  const s = await stack();
  try {
    const dumped = JSON.stringify(s.alice.channels.bob);
    assert.ok(!dumped.includes("materialHex"), "the agreed material is stored again");
    // The chain key is there, and it must be: it is what opens the NEXT message. What must not
    // be there is anything that regenerates the chain from its beginning.
    assert.ok(dumped.includes("chainHex"));
    assert.equal(s.alice.channels.bob.send.next, 0);
    await sendMessage(s.alice, s.chain, "bob", "one", T0);
    assert.equal(s.alice.channels.bob.send.next, 1, "sending did not advance the chain");
  } finally { s.server.close(); }
});
