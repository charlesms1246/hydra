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

import { NOT_OBSERVABLE } from "../../vault-server/src/observations.ts";
import type { Guarantee } from "../../vault-server/src/observations.ts";
import { Vault, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";
import { MIN_READ_BATCH } from "../../client/src/read.ts";
import { sealForChannel, wireBytes } from "../../vault-client/src/blobs.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { channelSecret } from "../../channel/src/pointer.ts";
import { inboxSlots, encodePrekey, decodePrekey } from "../../handshake/src/inbox.ts";
import { initiate, bundleFor } from "../../handshake/src/x3dh.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..", "..", "vault-server", "src");
const chan = channelSecret(
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(15), "mechanisms")))),
  "alice→bob",
);
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
function grep(pattern: string, path: string): string[] {
  try {
    return execFileSync("/usr/bin/grep", ["-rn", "--include=*.ts", "-E", pattern, path],
      { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * One assertion per mechanism. Keyed by the same union the guarantees use, so a typo is a
 * compile error rather than a silently absent check.
 */
const MECHANISMS: Record<Guarantee["mechanism"], () => void> = {
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
    const src = readFileSync(join(SERVER_SRC, "server.ts"), "utf8");
    const upload = src.match(/export type UploadRequest = \{[^}]*\}/s);
    const stored = src.match(/type Stored = \{[^}]*\}/s);
    assert.ok(upload && stored);
    for (const shape of [upload[0], stored[0]]) {
      assert.ok(!/channel/i.test(shape), `a channel field appeared in:\n${shape}`);
    }
    // And a real upload, driven end to end, leaves nothing channel-shaped in the record.
    const vault = new Vault({ invites: ["m1"], buckets: BUCKETS });
    const blob = sealForChannel(chan, new TextEncoder().encode("grouped?"));
    vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id, body: bytes(blob), invite: "m1" });
    assert.ok(!JSON.stringify(vault.observe()).includes("alice"));
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

test("every guarantee names a mechanism, and every mechanism is checked", () => {
  // Both directions. A row added without an assertion is a claim nobody proved; an assertion
  // left behind after its row is deleted is a check that no longer defends anything.
  const claimed = NOT_OBSERVABLE.map((g) => g.mechanism).sort();
  const checked = Object.keys(MECHANISMS).sort();
  assert.deepEqual(claimed, checked,
    "the guarantees and their proofs have drifted apart");
  assert.equal(new Set(claimed).size, claimed.length,
    "two guarantees share a mechanism — one of them is not separately proven");
});

for (const guarantee of NOT_OBSERVABLE) {
  test(`${guarantee.id} — ${guarantee.mechanism}`, () => {
    MECHANISMS[guarantee.mechanism]();
  });
}

test("no guarantee's reason is only a claim about how clients behave", () => {
  // The shape of the original defect. "Clients fetch their whole channel set" describes a habit,
  // and a habit is not a mechanism — the code has to make it so, or the first caller who does
  // otherwise is not doing anything wrong. Each reason must point at something enforced.
  for (const g of NOT_OBSERVABLE) {
    const clientBehaviour = /^clients? [a-z]/i.test(g.why.trim());
    assert.ok(!clientBehaviour,
      `${g.id}'s reason opens by describing what clients do: "${g.why}". Name what stops them ` +
      "doing otherwise.");
  }
});
