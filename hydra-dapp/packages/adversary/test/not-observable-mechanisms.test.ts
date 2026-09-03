/**
 * Every "cannot see" claim, checked against the code that makes it so.
 *
 * `read.target` sat in `NOT_OBSERVABLE` giving the reason "clients fetch their whole channel
 * set" while no client did. The reason read like an explanation and was a wish; the
 * operator-view test batched by hand, so it proved the *server* accepted batches rather than
 * that any *client* sent one. That is the failure mode this file exists to prevent, and it is
 * not a failure of care — a prose `why` is exactly the place a claim quietly stops being true.
 *
 * So each guarantee names a mechanism, every mechanism has an assertion here, and the mapping
 * is checked **in both directions**. A row with no assertion fails. An assertion with no row
 * fails. Neither can be added alone, and a guarantee cannot be weakened without something here
 * going red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { NOT_OBSERVABLE, whyOf } from "../../vault-server/src/observations.ts";
import type { Mechanism } from "../../vault-server/src/observations.ts";
import { Vault, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { connect } from "node:tls";
import { MIN_READ_BATCH } from "../../client/src/read.ts";
import { sealForChannel, wireBytes } from "../../vault-client/src/blobs.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { channelSecret, pointerFor, blobIdFrom, recoverBlobId } from "../../channel/src/pointer.ts";
import { readSet } from "../../client/src/read.ts";
import { inboxSlots, encodePrekey, decodePrekey } from "../../handshake/src/inbox.ts";
import { initiate, respond, bundleFor } from "../../handshake/src/x3dh.ts";
import { ephemeral, signedBy, unframe } from "../../handshake/src/authorship.ts";
import { send } from "../../client/src/session.ts";
import { openForChannel, plaintextOf } from "../../vault-client/src/blobs.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..", "..", "vault-server", "src");
const root = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(15), "mechanisms"))));
const chan = channelSecret(root, "alice→bob");
const bytes = (b: Parameters<typeof wireBytes>[0]) => wireBytes(b) as unknown as Uint8Array;

/**
 * Every module reachable from an entry point, following relative imports.
 *
 * Transitive on purpose. Checking direct imports only is what let the server acquire identity
 * through a single hop, and nothing failed.
 */
function reachableFrom(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  let src = "";
  try {
    src = readFileSync(entry, "utf8");
  } catch {
    return seen;
  }
  for (const m of src.matchAll(/from "(\.[^"]+\.ts)"/g)) {
    reachableFrom(join(dirname(entry), m[1]), seen);
  }
  return seen;
}

/** grep exits 1 on no match, which is usually the passing case here. */
/**
 * Grep the CODE, not the comments.
 *
 * Every one of these patterns is about what the server DOES, and a comment is not a thing the
 * server does. Run over comments too, the guards fail on prose that explains why the code is
 * correct — which punishes the explanation and teaches the next person to delete it.
 *
 * That has now happened three times in this file. The `x3dh-authenticates-not-vault` grep already
 * carries a note about its first version matching this project's own disclosure table and a
 * comment reading "unauthenticated reads"; it then matched a comment recording a header RENAME
 * away from the very word it was looking for. The `no-channel-field` and `no-accounts` greps
 * matched doc comments saying there is no such field.
 *
 * Fixing it in the helper rather than in each pattern, because the next one will do it again.
 */
function grep(pattern: string, path: string): string[] {
  const stripped = (line: string): string => line.replace(/^[^:]*:\d+:/, "").trimStart();
  try {
    return execFileSync("/usr/bin/grep", ["-rn", "--include=*.ts", "-E", pattern, path],
      { encoding: "utf8" }).split("\n").filter(Boolean)
      // A line whose match is inside a comment is not the server doing anything.
      .filter((l) => !/^(\/\/|\*|\/\*)/.test(stripped(l)));
  } catch {
    return [];
  }
}

/**
 * One assertion per mechanism. Keyed by the same union the guarantees use, so a typo is a
 * compile error rather than a silently absent check.
 */

/**
 * TWO WORLDS, ONE RECORD — the shape several of these mechanisms want and only some of them had.
 *
 * A name-and-shape check ("no field is called `channel`", "no identifier matching `account`")
 * stands in for an invariance property, and it passes if the field is renamed or if the secret
 * leaks through a VALUE rather than a name. `read.channelSet` is the standing warning here: it
 * was published as something the operator could not see until a harness recovered both channels
 * of a two-channel session exactly.
 *
 * So: run the same traffic twice, differing only in the secret, and require the operator's record
 * to be identical. Blob ids are content hashes and must differ — if they did not, two worlds
 * would be linkable by equality, which is a worse leak than the one being tested — so they are
 * normalised to their position. Everything else must match exactly.
 *
 * What that catches which a grep cannot: an identity or a channel arriving through a field nobody
 * thought to name, a count that differs, a bucket that differs, an ordering that differs.
 */
/**
 * The field names in a type block, with comments and blank lines stripped.
 *
 * The greps below are about what a request or a record CARRIES. Run over the raw block they also
 * read the prose, so a comment saying "nothing here names a channel" fails "nothing here names a
 * channel". Both of these fired on exactly that.
 */
const fieldsOf = (block: string): string =>
  block.split("\n")
    .filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l))
    .join("\n");

function recordUnder(traffic: (vault: Vault, invites: string[]) => void): {
  ids: string[]; normalised: string; keys: string[];
} {
  const invites = Array.from({ length: 16 }, (_, i) => `w-${i}`);
  // A FIXED CLOCK, because arrival time is a real disclosure that depends on WHEN you upload and
  // not on the secret. Two worlds run a millisecond apart differ in `blob.expiry` and in nothing
  // else, which is the harness measuring itself — the first run of this caught exactly that.
  let tick = 1_800_000_000_000;
  const vault = new Vault({ invites, buckets: BUCKETS, observeReads: true, now: () => (tick += 1000) });
  traffic(vault, invites);
  const o = vault.observe();
  const ids = o.rows.map((r) => String(r["blob.id"]));
  // Ids out, positions in. Everything else — class, bucket, expiry, reads, totals — stays.
  const normalised = JSON.stringify(o, (k, v) =>
    k === "blob.id" ? "<id>"
      : typeof v === "string" && ids.includes(v) ? `<id:${ids.indexOf(v)}>`
        : typeof v === "bigint" ? String(v) : v);
  return { ids, normalised, keys: vault.observedKeys() };
}

/** Assert two worlds are indistinguishable in the record, and distinguishable in their ids. */
function indistinguishable(
  a: ReturnType<typeof recordUnder>, b: ReturnType<typeof recordUnder>, what: string,
): void {
  assert.equal(a.normalised, b.normalised,
    `the operator's record differs with ${what} — it is observable after all`);
  assert.deepEqual(a.keys, b.keys, `the capture's observable set differs with ${what}`);
  // And the ids must NOT be equal, or the two worlds are linkable by the thing that was supposed
  // to be a hash of unrelated bytes.
  assert.notDeepEqual(a.ids, b.ids, `two worlds produced identical blob ids`);
}

const MECHANISMS: Record<Mechanism, () => void | Promise<void>> = {
  "no-key-in-server": () => {
    // The server holds no key, so it cannot decrypt regardless of intent. Checked as an absence
    // in the code rather than as a property of a run: a run only exercises the paths it took,
    // and this has to hold for the ones it did not.
    //
    // Followed TRANSITIVELY, because a direct-import check is not enough and I proved it — the
    // server imported one constant from the client, the client imports identity, and the
    // server's module graph quietly contained the package whose absence is the whole claim.
    const reached = reachableFrom(join(SERVER_SRC, "server.ts"));
    const viaIdentity = [...reached].filter((f) => f.includes("/identity/"));
    assert.deepEqual(viaIdentity, [],
      `vault-server reaches the identity package, where keys live:\n${viaIdentity.join("\n")}`);
    assert.deepEqual(grep("createDecipheriv|createCipheriv|expose\\(|Secret<", SERVER_SRC), [],
      "vault-server references cipher or secret machinery");
  },

  "no-channel-field": () => {
    // Nothing an upload carries names a channel — not the request, not the stored record. If
    // it did, the operator would group blobs by conversation without decrypting anything.
    //
    // THE GREP IS THE SECOND LAYER. It catches a future refactor introducing a field literally
    // called `channel`, which a capture cannot — but on its own it passes if the field is renamed
    // and says nothing about the channel leaking through a VALUE. The first layer is two worlds.
    const src = readFileSync(join(SERVER_SRC, "server.ts"), "utf8");
    const upload = src.match(/export type UploadRequest = \{[\s\S]*?\n\};/);
    const stored = src.match(/type Stored = \{[\s\S]*?\n\};/);
    assert.ok(upload && stored);
    for (const shape of [upload[0], stored[0]]) {
      // FIELD NAMES, NOT PROSE. This matched the whole block including doc comments, so a comment
      // explaining WHY there is no channel field failed the test that there is no channel field.
      // A guard that a correct explanation can break is a guard that punishes explaining.
      assert.ok(!/channel/i.test(fieldsOf(shape)),
        `a channel field appeared in:\n${fieldsOf(shape)}`);
    }

    // The same words, sent under two different channels. Everything the operator holds must be
    // identical except the ids, which are hashes of different ciphertexts.
    const words = new TextEncoder().encode("meet me at eight");
    const world = (label: string) => (vault: Vault, invites: string[]) => {
      const channel = channelSecret(root, label);
      for (const n of [0, 1, 2]) {
        const blob = sealForChannel(channel, new Uint8Array([...words, n]));
        vault.handle({
          op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id,
          body: bytes(blob), invite: invites.shift()!,
        });
      }
    };
    indistinguishable(recordUnder(world("alice→bob")), recordUnder(world("alice→carol")),
      "which channel the blobs belong to");
  },

  "min-read-batch": () => {
    // The mechanism that was missing. Asserted at the server, because that is where it is
    // enforced — a client-side habit would leave the guarantee resting on every caller.
    const vault = new Vault({ buckets: BUCKETS });
    const narrow = vault.handle({
      op: "fetch", endpoint: ENCRYPTED_ENDPOINT,
      ids: Array.from({ length: MIN_READ_BATCH - 1 }, (_, i) => `enc:${i}`),
    });
    assert.equal(narrow.ok, false, "the server served a read narrow enough to name its target");
    assert.ok(MIN_READ_BATCH >= 8, `a floor of ${MIN_READ_BATCH} is too low to hide a target`);
  },

  "invite-destroyed": () => {
    // Redemption consumes the token, and nothing writes it beside the object it admitted. An
    // invite retained and linked to what it created is exactly the record that would undo this.
    const vault = new Vault({ invites: ["burn-me"], buckets: BUCKETS });
    const blob = sealForChannel(chan, new TextEncoder().encode("who sent this?"));
    assert.equal(vault.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id, body: bytes(blob), invite: "burn-me",
    }).ok, true);
    assert.ok(!JSON.stringify(vault.observe()).includes("burn-me"),
      "the redeemed invite survives in the vault's record");
    // Consumed, not merely unrecorded: a second use is refused.
    const second = sealForChannel(chan, new TextEncoder().encode("again"));
    assert.equal(vault.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: second.id, body: bytes(second), invite: "burn-me",
    }).ok, false);
    // And the stored shape has no field an uploader could be recorded in.
    const src = readFileSync(join(SERVER_SRC, "server.ts"), "utf8");
    assert.ok(!/type Stored = \{[^}]*(invite|uploader|peer)/s.test(src));
  },

  "inbox-not-content-addressed": () => {
    // A channel blob's id is the hash of its bytes and `select` refuses a mismatch. An inbox
    // slot is addressed by its RECIPIENT, so that check cannot apply and anyone may write
    // anything into a slot — which is exactly what makes delivery to a stranger possible.
    //
    // The claim is that this does not let the operator attribute a message to a sender. Two
    // parts: the slot id does not depend on the sender at all, and the message that arrives is
    // authenticated by X3DH rather than by the vault.
    const alice = derive(VAULT_DOMAIN,
      rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(21), "inbox-alice"))));
    const carol = derive(VAULT_DOMAIN,
      rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(22), "inbox-carol"))));
    const bob = derive(VAULT_DOMAIN,
      rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(23), "inbox-bob"))));
    const bobKey = bundleFor(bob, 0, 0).identityKey;

    // Two different senders, same recipient: the slots they may use are identical, so where a
    // message lands carries nothing about who wrote it.
    const fromAlice = initiate(alice, bundleFor(bob, 0, 0));
    const fromCarol = initiate(carol, bundleFor(bob, 0, 0));
    assert.deepEqual(inboxSlots(bobKey), inboxSlots(bobKey));
    for (const m of [fromAlice.message, fromCarol.message]) {
      const encoded = encodePrekey(m);
      assert.ok(BUCKETS.includes(encoded.length), "a prekey message is not padded to a bucket");
      // And nothing in the slot id is a function of the message or its sender.
      assert.ok(!inboxSlots(bobKey).some((id) => id.includes(
        Buffer.from(m.identityKey).toString("hex").slice(0, 16))));
    }
    // A stranger writing junk into a slot produces something the recipient discards, not
    // something the operator can attribute.
    assert.throws(() => decodePrekey(new Uint8Array(1024)), /too short|exceeds/);
  },

  "client-pads-read": () => {
    // The claim `min-read-batch` does NOT cover. The server refusing narrow reads is a floor;
    // this is the separate claim that a client asks for its whole channel set rather than
    // sailing along the floor with only the id it wants plus seven decoys. Split out because
    // the row used to rest both clauses on the server's assertion — one mechanism, two claims.
    const seen = [0, 1, 2].map((seq) => ({
      seq,
      pointer: pointerFor(chan, blobIdFrom(bytes(sealForChannel(chan, new Uint8Array([seq])))), seq),
    }));
    const batch = readSet(chan, seen as never);
    assert.ok(batch.length >= MIN_READ_BATCH);
    // Every message the client knows about is in it, not just the one it wants now.
    for (const s of seen) {
      const id = `enc:${Buffer.from(recoverBlobId(chan, s.pointer, s.seq)).toString("hex")}`;
      assert.ok(batch.includes(id), `message ${s.seq} is missing from the batch`);
    }
    // And it is wider than the set, so the wanted id is not the only real one in it.
    assert.ok(batch.length > seen.length, "the batch is exactly the channel set with no padding");
  },

  "no-accounts": () => {
    // TWO CLIENTS, ONE RECORD. The grep below catches a future refactor introducing an account
    // TYPE, which a capture cannot. It does not catch an identity arriving through something
    // nobody would call an account — and that is the live risk rather than a theoretical one now
    // that this server terminates TLS, because a reused connection is an identity that persists
    // across uploads and never matches `(user|account|login|session|principal|owner)`.
    const twoClients = (label: string) => (vault: Vault, invites: string[]) => {
      const channel = channelSecret(root, label);
      for (const n of [0, 1]) {
        const blob = sealForChannel(channel, new Uint8Array([7, n]));
        vault.handle({
          op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id,
          body: bytes(blob), invite: invites.shift()!,
        });
      }
    };
    indistinguishable(recordUnder(twoClients("device-one")), recordUnder(twoClients("device-two")),
      "which client uploaded");

    // The other half of `uploader.identity`. `invite-destroyed` proves the token is not kept;
    // this proves there is no identity for it to have been kept against. An account system
    // would make the invite's destruction beside the point.
    const src = readFileSync(join(SERVER_SRC, "server.ts"), "utf8");
    assert.deepEqual(grep("(user|account|login|session|principal|owner)\\s*[:=]", SERVER_SRC), [],
      "the vault-server has acquired something account-shaped");
    assert.ok(!/interface\s+\w*Account|type\s+\w*Account/.test(src));
    // And an upload request has no field an identity could travel in.
    const upload = src.match(/export type UploadRequest = \{[\s\S]*?\n\};/);
    assert.ok(upload);
    // Field names, not prose — see `fieldsOf`. This fired on a comment that explained why there
    // is no sender field.
    assert.ok(!/user|account|from|sender/i.test(fieldsOf(upload![0])),
      `an identity field appeared:\n${fieldsOf(upload![0])}`);
  },

  "x3dh-authenticates-not-vault": () => {
    // The other half of `inbox.sender`. `inbox-not-content-addressed` proves the ADDRESS carries
    // nothing about the sender; this proves the vault does not check who wrote, so a stranger's
    // object is refused by the recipient rather than attributed by the operator.
    // Grepped for CALLS, not for the words. The first version matched this project's own
    // disclosure table — which is stored in this directory and says the word "authenticates" —
    // and a comment reading "unauthenticated reads". A check that a codebase never mentions a
    // concept is not a check that it never does it.
    assert.deepEqual(
      grep("createVerify|\\bverify\\(|\\bsign\\(|x-hydra-(sig|auth)", SERVER_SRC), [],
      "the vault verifies something about who is writing");
    // A message from the wrong sender fails at `respond`, which is where authentication lives.
    const bob = derive(VAULT_DOMAIN,
      rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(24), "x3dh-bob"))));
    const mallory = derive(VAULT_DOMAIN,
      rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(25), "x3dh-mallory"))));
    const forged = initiate(mallory, bundleFor(mallory, 0, 0)).message;
    assert.throws(() => respond(bob, forged), /unable to authenticate|bad decrypt/i);
  },

  /**
   * Deniability, asserted as a property rather than described as one.
   *
   * The mechanism is that a deniable message's only authenticator is the AEAD tag under a
   * content key BOTH participants hold. So the check is not "there is no signature in the
   * frame" — that is a source check, and this file exists because a source check let
   * `read.target` be false for months. The check is that the counterparty can PRODUCE a message
   * indistinguishable from the author's, which is the thing a third party would have to
   * distinguish and cannot.
   */
  "shared-key-authenticator": () => {
    const root = (n: number) => derive(VAULT_DOMAIN,
      rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(n), "deniable"))));
    const channel = channelSecret(root(21), "either-of-us");
    const words = new TextEncoder().encode("meet me at eight");

    // Alice writes it deniably; bob, holding the same content key, writes the same thing.
    const config = { blockMs: 30_000, channel, author: ephemeral() };
    const hers = send(config, words, 0, 0, () => 0.5);
    const his = send(config, words, 0, 0, () => 0.5);

    // Both open under the shared key, and neither frame carries a signature to tell them apart.
    for (const body of [hers.body, his.body]) {
      const opened = unframe(plaintextOf(openForChannel(channel, body)));
      assert.equal(opened.signature, null,
        "a deniable message carried a signature, which would settle who wrote it");
      assert.deepEqual(Buffer.from(opened.plaintext), Buffer.from(words));
    }
    assert.equal(hers.body.length, his.body.length);

    // And the property is a CHOICE: the same call with a signing attribution is not deniable, so
    // this mechanism is about content that asked for it rather than about content that got it.
    const signed = send({ ...config, author: signedBy(root(21)) }, words, 0, 0, () => 0.5);
    assert.ok(unframe(plaintextOf(openForChannel(channel, signed.body))).signature,
      "a signed message came out deniable, so the choice does not reach the wire");
  },

  "no-session-tickets": async () => {
    // Resumption is the server recognising a client it has seen before — a durable link between
    // separate connections, which is the one thing TLS termination would otherwise hand it.
    //
    // CONNECTED TWICE rather than grepped for `SSL_OP_NO_TICKET`. An earlier version of this
    // checked the source for the flag, and this project has already been caught once by a source
    // check that matched its own disclosure table instead of its behaviour. The flag being
    // present is not the claim; the server refusing to resume is.
    const dir = await mkdtemp(join(tmpdir(), "hydra-tls-mech-"));
    try {
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
        "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
      ], { stdio: "ignore" });
      const v = new Vault({ buckets: BUCKETS });
      const { server, url } = await serve(v, 0, {
        tls: { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) },
      });
      const port = Number(new URL(url).port);
      try {
        const opts = { host: "127.0.0.1", port, rejectUnauthorized: false } as const;
        // Waited for on the `session` EVENT, not read at connect time. Under TLS 1.3 the ticket
        // arrives after the handshake finishes, so `getSession()` in the connect callback
        // returns something that cannot resume whatever the server is configured to do — which
        // made the first version of this test pass with tickets enabled. A check that cannot
        // fail is not a check, and this file exists because of that exact mistake elsewhere.
        const session = await new Promise<Buffer | null>((res) => {
          const c = connect(opts, () => { /* wait for the ticket, or give up */ });
          const done = setTimeout(() => { c.end(); res(null); }, 2000);
          c.once("session", (s) => { clearTimeout(done); c.end(); res(s); });
        });
        const reused = await new Promise<boolean>((res) => {
          const c = connect({ ...opts, session: session ?? undefined }, () => {
            const r = c.isSessionReused(); c.end(); res(r);
          });
        });
        // The claim is that the SERVER does not resume, not that node's client keeps nothing:
        // node emits a `session` blob of its own regardless, and asserting on that was checking
        // the client's cache rather than the server's behaviour. What matters is that offering
        // a real, freshly-issued session back does not get it accepted.
        assert.ok(session, "no session was offered at all, so this cannot distinguish anything");
        assert.equal(reused, false,
          "the server resumed a session, so two connections from one client are linkable");
      } finally {
        server.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  "pad-before-seal": () => {
    // Padding is inside the constructors, so a caller cannot skip it, and the server refuses a
    // body that is not exactly a bucket — which is the only place it can be enforced, since a
    // stored body has already disclosed its length.
    const sizes = new Set([1, 2, 500, 992].map((n) => bytes(sealForChannel(chan, new Uint8Array(n))).length));
    assert.equal(sizes.size, 1, `four message sizes produced ${sizes.size} wire sizes`);
    assert.equal([...sizes][0], BUCKETS[0]);
    const vault = new Vault({ invites: ["m2"], buckets: BUCKETS });
    const blob = sealForChannel(chan, new TextEncoder().encode("x"));
    const short = vault.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id,
      body: bytes(blob).slice(0, 900), invite: "m2",
    });
    assert.equal(short.ok, false, "the server stored a body that was not a bucket");
  },
};

test("every CLAIM names a mechanism, and every mechanism is checked", () => {
  // Both directions, per claim rather than per row. `channel.membership` passed this check for
  // weeks with one mechanism and two claims: the first was proven, the second was the
  // disclosure written as though it were the protection, and nothing asserted it because the
  // guard only asked whether the ROW named a mechanism.
  const claimed = NOT_OBSERVABLE.flatMap((g) => g.because.map((b) => b.mechanism)).sort();
  const checked = Object.keys(MECHANISMS).sort();
  assert.deepEqual([...new Set(claimed)].sort(), checked,
    "the guarantees and their proofs have drifted apart");
  assert.equal(new Set(claimed).size, claimed.length,
    "two claims share a mechanism — one of them is resting on the other's assertion");
  assert.ok(NOT_OBSERVABLE.every((g) => g.because.length > 0), "a row states no reason at all");
});

test("no single claim smuggles a second claim inside it", () => {
  // The structural fix stops a ROW carrying two claims under one mechanism. This stops a CLAIM
  // doing the same thing inside one string, which is where the old defect actually lived: the
  // second half arrived after an "and" and read like supporting detail.
  //
  // A clause needing a semicolon or an "and" that joins two assertions is two clauses. Split
  // it and give the second one its own mechanism, or discover there is nothing proving it.
  for (const g of NOT_OBSERVABLE) {
    for (const b of g.because) {
      assert.ok(!b.claim.includes(";"),
        `${g.id}: "${b.claim}" joins two statements with a semicolon — split it`);
      assert.ok(!/, and /.test(b.claim),
        `${g.id}: "${b.claim}" joins two statements with ", and" — split it and prove both`);
    }
  }
});

for (const guarantee of NOT_OBSERVABLE) {
  for (const because of guarantee.because) {
    test(`${guarantee.id} — ${because.mechanism}`, async () => {
      await MECHANISMS[because.mechanism]();
    });
  }
}

test("no guarantee's reason is only a claim about how clients behave", () => {
  // The shape of the original defect. "Clients fetch their whole channel set" describes a habit,
  // and a habit is not a mechanism — the code has to make it so, or the first caller who does
  // otherwise is not doing anything wrong. Each reason must point at something enforced.
  for (const g of NOT_OBSERVABLE) {
    for (const b of g.because) {
      assert.ok(!/^clients? [a-z]/i.test(b.claim.trim()),
        `${g.id}'s claim opens by describing what clients do: "${b.claim}". Name what stops `
        + "them doing otherwise.");
    }
    assert.ok(whyOf(g).length > 20, `${g.id} states no reason worth reading`);
  }
});
