/**
 * Two people hold a conversation — Phase 4's first acceptance clause, minus the desktop shell.
 *
 * Everything up to now proved halves. The sender could seal, pad, point, commit, schedule and
 * upload; the operator could be shown to learn nothing; and `readPublic`'s comment said the
 * encrypted class "is opened elsewhere" while **nowhere opened it**. A platform that can send
 * and cannot receive has not been tested end to end, it has been tested end to middle.
 *
 * So this drives the whole loop through the real HTTP vault: alice sends three messages, bob
 * fetches a padded batch, picks his out of it, opens them, and reads the text back. Then the
 * ways it must fail — the wrong channel, altered bytes, a vault that files a blob under an id
 * it does not hash to.
 *
 * NOTHING IS SHARED OUT OF BAND. Bob used to be handed alice's channel secret, because
 * `openChannel` derives from one party's vault root and the other party cannot compute it —
 * every guarantee here was conditional on a step nobody had written. The two of them now run
 * X3DH: alice reads bob's published bundle, agrees a secret against keys he generated while
 * offline, and the wrap rides in the vault. Bob's channel secret below is computed from his own
 * root and the prekey message, never copied from alice's.
 *
 * What is still unbuilt is DELIVERY. The prekey message is handed to bob in-process here,
 * because a mailbox a stranger can address without already sharing a secret is a disclosure the
 * vault operator gets to see, and that has not been designed. `decisions/0009` says so.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { send, openChannel } from "../../client/src/session.ts";
import { initiate, respond, bundleFor } from "../../handshake/src/x3dh.ts";
import { readSet, select, MIN_READ_BATCH } from "../../client/src/read.ts";
import { Vault, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { openForChannel, plaintextOf, encryptedIdFor } from "../../vault-client/src/blobs.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, expose, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { ephemeral } from "../../handshake/src/authorship.ts";
import { unframe, FRAME_HEADER } from "../../handshake/src/authorship.ts";

const BLOCK = 30_000;
const config = (channel: ReturnType<typeof openChannel>) =>
  ({ channel, author: ephemeral(), blockMs: BLOCK });

const aliceRoot = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(3), "alice"))));
const bobRoot = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(5), "bob"))));

// Alice reads what bob published and agrees a secret with him while he is offline. The
// ephemeral key and the channel material are random, as they are in use — a fixed seed here
// would make the whole file a test of one pair of values.
const opening = initiate(aliceRoot, bundleFor(bobRoot, 0, 0));
const channel = opening.channel;
/** Bob's, computed from HIS root and the prekey message. Never copied from alice's. */
const bobChannel = respond(bobRoot, opening.message).channel;

/**
 * Long enough to be searched for.
 *
 * The third was "ok" and this file failed about one run in twenty on it: the leak check greps
 * the ciphertext for each plaintext, and a two-byte string turns up in a kilobyte of
 * random-looking bytes by chance roughly 5% of the time. Nothing was leaking; the canary was
 * too short to be a canary. Message LENGTHS are covered properly by the padding test below,
 * which runs 0, 1, 17, 900 and 991 bytes, so nothing is lost by making these searchable.
 */
const TEXTS = ["hello there", "the second one, which is longer than the first", "ok, understood"];

/** Alice's side: seal, point, commit, schedule — and the bytes that go to the vault. */
const outgoing = TEXTS.map((t, seq) =>
  send(config(channel), new TextEncoder().encode(t), seq, seq * BLOCK, () => 0.5));

async function withVault(fn: (url: string, vault: Vault) => Promise<void>) {
  const vault = new Vault({ invites: TEXTS.map((_, i) => `inv-${i}`), buckets: BUCKETS });
  const { url, server } = await serve(vault);
  try {
    for (const [i, m] of outgoing.entries()) {
      const res = await fetch(`${url}${ENCRYPTED_ENDPOINT}/${m.blobId}`, {
        method: "PUT", headers: { "x-hydra-invite": `inv-${i}` }, body: m.body,
      });
      assert.equal(res.status, 201, `the vault refused an upload: ${await res.text()}`);
    }
    await fn(url, vault);
  } finally {
    server.close();
  }
}

/** Bob's side: the pointers he read off the chain are all he has to start from. */
const seen = outgoing.map((m, seq) =>
  ({ seq, commitment: m.calldata[1], pointer: m.pointer as unknown as Uint8Array }));

async function fetchBatch(url: string, ids: string[]): Promise<Map<string, Uint8Array>> {
  const res = await fetch(`${url}${ENCRYPTED_ENDPOINT}`, {
    method: "POST", body: JSON.stringify(ids),
  });
  const body = await res.json() as { found: Record<string, string> };
  return new Map(Object.entries(body.found)
    .map(([k, v]) => [k, new Uint8Array(Buffer.from(v, "base64"))]));
}

test("bob's channel secret is his own arithmetic, not a copy of alice's", () => {
  // The check that the stub is actually gone. If this file ever goes back to sharing a secret,
  // the conversation still works and only this test notices.
  const mine = Buffer.from(expose(channel, VAULT_DOMAIN));
  const his = Buffer.from(expose(bobChannel, VAULT_DOMAIN));
  assert.deepEqual(his, mine, "the two sides did not agree");
  // And a third party holding everything that travelled — the bundle and the prekey message —
  // does not get there, which is what makes the agreement worth anything.
  const mallory = derive(VAULT_DOMAIN,
    rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(6), "mallory"))));
  assert.throws(() => respond(mallory, opening.message), /unable to authenticate|bad decrypt/i);
});

test("alice sends, bob reads it back, through the real vault over HTTP", async () => {
  await withVault(async (url) => {
    const ids = readSet(bobChannel, seen);
    // The batch is padded past what he wants, because asking for one id names the message.
    assert.ok(ids.length >= MIN_READ_BATCH);
    const batch = await fetchBatch(url, ids);
    // The decoy ids miss, which is what makes the padding free: a miss looks like a message
    // that has not been sent yet.
    assert.equal(batch.size, TEXTS.length, "the decoys hit something, or a real message missed");

    const read = seen.map((s) => {
      const bytes = select(batch, bobChannel, s);
      assert.ok(bytes, `bob could not find message ${s.seq} in his own batch`);
      // Unframed: what is sealed is `[mode][signature][blind][plaintext]`, so the bytes that
      // come out of the blob are not the message. See `handshake/src/authorship.ts`.
      return new TextDecoder().decode(
        unframe(plaintextOf(openForChannel(bobChannel, bytes))).plaintext);
    });
    assert.deepEqual(read, TEXTS, "the conversation did not survive the round trip");
  });
});

test("the padding comes off exactly, whatever the message length", () => {
  // The length prefix is inside the sealed region, so this is the check that it is being read
  // back rather than the plaintext being whatever survived the bucket. The authorship frame sits
  // inside that region too, and the largest case shrank by its size — a message is now the
  // bucket minus the frame, which is the storage cost of being able to answer "who wrote this".
  for (const n of [0, 1, 17, 800, 991 - FRAME_HEADER]) {
    const m = send(config(channel), new Uint8Array(n).fill(0xab), 0, 0, () => 0.5);
    const out = unframe(plaintextOf(openForChannel(channel, m.body))).plaintext;
    assert.equal(out.length, n, `a ${n}-byte message came back ${out.length} bytes`);
    assert.ok(out.every((b) => b === 0xab));
    // And it was one bucket on the wire regardless.
    assert.equal(m.body.length, BUCKETS[0]);
  }
});

test("another channel's holder gets nothing, not garbage", () => {
  // GCM's tag is what makes this a refusal rather than a plausible-looking wrong answer. A
  // mode without one would hand the wrong reader bytes and no reason to doubt them.
  const other = openChannel(derive(VAULT_DOMAIN,
    rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(4), "mallory")))), "alice→bob");
  assert.throws(() => openForChannel(other, outgoing[0].body), /unable to authenticate|bad decrypt/i);
  // Same root, different channel id — the case that matters more, because it is the one a bug
  // in channel derivation would produce.
  assert.throws(() => openForChannel(openChannel(aliceRoot, "alice→carol"), outgoing[0].body),
    /unable to authenticate|bad decrypt/i);
});

test("a body the operator altered fails to open, wherever it was altered", () => {
  for (const at of [0, 11, 12, 500, outgoing[0].body.length - 1]) {
    const tampered = new Uint8Array(outgoing[0].body);
    tampered[at] ^= 0xff;
    assert.throws(() => openForChannel(channel, tampered),
      /unable to authenticate|bad decrypt/i, `a flipped bit at ${at} was not detected`);
  }
});

test("a vault that files a blob under someone else's id is caught", async () => {
  // The attack decryption alone cannot see. Every message in a channel opens under the same
  // key, so a vault that returns message 2's bytes for message 0's id produces real plaintext —
  // bob reads a message alice did send, in the wrong place, with nothing wrong. Content
  // addressing is the binding, and it is only a binding because `select` checks it.
  await withVault(async (url) => {
    const batch = await fetchBatch(url, readSet(channel, seen));
    const swapped = new Map(batch);
    swapped.set(outgoing[0].blobId, batch.get(outgoing[1].blobId)!);
    assert.throws(() => select(swapped, channel, seen[0]), /does not hash to/);
    // Without the check it would have opened cleanly, which is why the check exists.
    const substituted = swapped.get(outgoing[0].blobId)!;
    assert.doesNotThrow(() => openForChannel(channel, substituted));
    assert.notEqual(encryptedIdFor(substituted), outgoing[0].blobId);
  });
});

test("a message never appears in the clear on the wire or at rest", async () => {
  await withVault(async (_url, vault) => {
    const stored = JSON.stringify(vault.observe());
    for (const t of TEXTS) assert.ok(!stored.includes(t), `the vault's record contains ${t}`);
    // Each canary is long enough that a chance appearance in a kilobyte of ciphertext is
    // vanishingly unlikely; see the note on TEXTS. Asserted so a future edit cannot quietly
    // shorten one back into a coin flip.
    for (const t of TEXTS) assert.ok(t.length >= 8, `"${t}" is too short to be a leak canary`);
    for (const m of outgoing) {
      const hay = Buffer.from(m.body).toString("latin1");
      for (const t of TEXTS) assert.ok(!hay.includes(t), `${t} is readable in the uploaded body`);
    }
  });
});
