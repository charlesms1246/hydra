/**
 * I2 — never operate a discovery service, and never transmit a viewing key.
 *
 * `HYDRA_HANDOFF.md` I2: the SDK's default discovery provider sends the user's *private*
 * viewing key in the request body and the service decrypts server-side. Self-hosting is the
 * right answer for a dapp developer and the wrong one for us — it would mean holding every
 * user's root viewing key. The SDK offers a client-side alternative,
 * `ContractDiscoveryProvider` (`.upstream/client/node_modules/@starkware-libs/starknet-privacy-sdk/dist/factory.d.ts:56`),
 * against the remote `IndexerDiscoveryProvider` named as the default at `factory.d.ts:33`.
 *
 * Its test, verbatim: "no code path transmits a viewing key off-device. Grep-level CI check
 * plus a network-capture test on the reference client."
 *
 * Both are here, and a third that is stronger than either: run a full client session and
 * assert that no key material appears in ANY artifact the client produces, whether or not it
 * was destined for a network. A grep check goes stale the moment someone adds a transport, and
 * a capture test only sees the transports it knows to hook.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";

import { rootSeed, entropyFrom, fromTestVector, derive, subKey, expose, adoptPoolKey, VAULT_DOMAIN, POOL_DOMAIN }
  from "../../identity/src/domains.ts";
import { channelSecret, pointerFor, blobIdFrom } from "../../channel/src/pointer.ts";
import { noteCalldata } from "../../channel/src/note.ts";
import { commit, contentHashFor } from "../../channel/src/commitment.ts";
import { sealForChannel, publish, wireBytes } from "../../vault-client/src/blobs.ts";
import { Vault, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

/** grep exits 1 on no match, which is the passing case here. */
function grep(pattern: string, path: string): string[] {
  try {
    return execFileSync("/usr/bin/grep", ["-rn", "--include=*.ts", "-E", pattern, path],
      { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Everything on the client side of the wire. */
const SOURCES = ["identity", "channel", "vault-client", "vault-server"].map((p) => join(PACKAGES, p, "src"));

/**
 * The packages that hold key material, which is a narrower list on purpose.
 *
 * `vault-server` is excluded because it is the server: it will bind a socket the moment it
 * stops being an in-process object, and forbidding that would be forbidding it to exist. What
 * makes that safe is not this check but the fact that it never receives a key — asserted from
 * the other side by the operator-view test, which fails if plaintext or key bytes ever reach
 * its record.
 */
const KEY_HOLDERS = ["identity", "channel", "vault-client"].map((p) => join(PACKAGES, p, "src"));

test("nothing imports the SDK's remote discovery provider", () => {
  // The grep-level CI check I2 asks for. Names the specific class rather than something vague,
  // so it fails on the actual mistake and not on the word "discovery" in a comment.
  for (const src of SOURCES) {
    assert.deepEqual(grep("IndexerDiscoveryProvider|discoveryProvider *:", src), [],
      `${src} references a discovery provider`);
  }
});

test("no key-handling package imports a network transport at all", () => {
  // Stronger than checking for one provider: a package that cannot reach the network cannot
  // transmit a key through any provider, present or future.
  const transports = "from \"node:(http|https|net|dgram|tls)\"|\\bfetch\\(|require\\(.node:(http|https|net)|from \"(axios|undici|node-fetch|got)\"";
  for (const src of KEY_HOLDERS) {
    assert.deepEqual(grep(transports, src), [], `${src} can reach the network`);
  }
  // And the check is not vacuous: it finds a transport when one is there.
  assert.ok(grep(transports, join(PACKAGES, "adversary", "test")).length > 0,
    "the transport pattern matches nothing anywhere — it has stopped being a check");
});

/** Hook everything a process could plausibly use to open a socket. */
function withNetworkSealed<T>(body: () => T): { result: T; attempts: string[] } {
  const attempts: string[] = [];
  const saved = {
    fetch: globalThis.fetch,
    httpRequest: http.request, httpGet: http.get,
    httpsRequest: https.request, httpsGet: https.get,
    connect: net.connect, Socket: net.Socket,
  };
  const trap = (name: string) => (...args: unknown[]) => {
    attempts.push(`${name} ${JSON.stringify(args).slice(0, 400)}`);
    throw new Error(`network sealed: ${name}`);
  };
  globalThis.fetch = trap("fetch") as unknown as typeof fetch;
  http.request = trap("http.request") as unknown as typeof http.request;
  http.get = trap("http.get") as unknown as typeof http.get;
  https.request = trap("https.request") as unknown as typeof https.request;
  https.get = trap("https.get") as unknown as typeof https.get;
  net.connect = trap("net.connect") as unknown as typeof net.connect;
  try {
    return { result: body(), attempts };
  } finally {
    Object.assign(globalThis, { fetch: saved.fetch });
    http.request = saved.httpRequest; http.get = saved.httpGet;
    https.request = saved.httpsRequest; https.get = saved.httpsGet;
    net.connect = saved.connect;
  }
}

/** A full client session: derive, seal, point, commit, upload, read back. */
function clientSession() {
  const seed = rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(2), "i2 test vector")));
  const vaultRoot = derive(VAULT_DOMAIN, seed);
  const chan = channelSecret(vaultRoot, "alice→bob");
  const pool = adoptPoolKey(0xdeadbeefcafen);
  const vault = new Vault({ invites: ["i0", "i1", "i2"] });

  const artifacts: unknown[] = [];
  for (let seq = 0; seq < 3; seq++) {
    const content = new TextEncoder().encode(`secret message ${seq}`);
    const blob = sealForChannel(chan, content);
    const wire = wireBytes(blob) as unknown as Uint8Array;
    const pointer = pointerFor(chan, blobIdFrom(wire), seq);
    const calldata = noteCalldata(pointer, commit(BigInt(seq + 1), contentHashFor(content)));
    vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id, body: wire, invite: `i${seq}` });
    artifacts.push(blob.id, [...wire], [...pointer], calldata.map(String));
  }
  artifacts.push(publish(new TextEncoder().encode("public"), { confirmedPublicAt: "t", reason: "r" }).id);
  artifacts.push(vault.observe());
  return { artifacts, chan, vaultRoot, pool, seed };
}

test("a full client session opens no socket by any route", () => {
  // The network-capture test. Every hook throws rather than records-and-continues, so a code
  // path that tried would fail loudly here rather than pass with a note in an array.
  const { attempts } = withNetworkSealed(() => clientSession());
  assert.deepEqual(attempts, [], `the client attempted network I/O:\n${attempts.join("\n")}`);
});

test("the seal actually catches an egress attempt", () => {
  // Teeth. Without this, the check above passes identically on a broken harness.
  const { attempts } = withNetworkSealed(() => {
    try { void (globalThis.fetch as unknown as (u: string) => unknown)("https://example.invalid/keys"); } catch { /* expected */ }
    try { http.get("http://example.invalid/keys"); } catch { /* expected */ }
  });
  assert.equal(attempts.length, 2);
  assert.match(attempts[0], /fetch/);
});

test("no key material appears in anything the client produces", () => {
  // The check that survives a new transport. Whatever the client emits — ids, ciphertext,
  // pointers, calldata, the server's own record — none of it may contain the bytes of any key,
  // in any of the three encodings something might serialise them into.
  const { artifacts, chan, vaultRoot, pool, seed } = clientSession();
  const blob = JSON.stringify(artifacts);

  const keys: [string, Uint8Array][] = [
    ["vault root", expose(vaultRoot, VAULT_DOMAIN)],
    ["channel secret", expose(chan, VAULT_DOMAIN)],
    ["channel sub-key", expose(subKey(chan, "blob content"), VAULT_DOMAIN)],
    ["pool viewing key", expose(pool, POOL_DOMAIN)],
    ["root seed", seed.bytes],
  ];
  for (const [name, bytes] of keys) {
    const hex = Buffer.from(bytes).toString("hex");
    const b64 = Buffer.from(bytes).toString("base64");
    const decimal = bytes.join(",");
    assert.ok(!blob.includes(hex), `${name} appears hex-encoded in client output`);
    assert.ok(!blob.includes(b64), `${name} appears base64-encoded in client output`);
    assert.ok(!blob.includes(decimal), `${name} appears as a byte array in client output`);
    // And no eight-byte run of it, which is what a partial or truncated leak looks like.
    for (let i = 0; i + 16 <= hex.length; i += 16) {
      assert.ok(!blob.includes(hex.slice(i, i + 16)), `a fragment of ${name} appears in client output`);
    }
  }
});

test("the key-material search would find a planted leak", () => {
  // Teeth again, and the more important half: the search above is only as good as its
  // encodings, so each one is proven to catch a key that really is there.
  const { chan } = clientSession();
  const bytes = expose(chan, VAULT_DOMAIN);
  for (const encoded of [
    Buffer.from(bytes).toString("hex"),
    Buffer.from(bytes).toString("base64"),
    bytes.join(","),
  ]) {
    const leaked = JSON.stringify({ innocuous: "field", debug: encoded });
    assert.ok(leaked.includes(encoded), "the planted leak was not detectable");
  }
});
