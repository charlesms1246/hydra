/**
 * The ratchet header on the wire, and the one claim it has to earn.
 *
 * `decisions/0032` says a per-message header costs **no disclosure**, and the whole argument is a
 * size argument: padding happens before sealing, the vault refuses any body that is not exactly a
 * bucket, so a header that grew the blob would push messages into the next size band and hand the
 * operator a new signal. Reserving a prefix inside the bucket instead means `blob.bucket` says
 * what it always said and `cover.ts`'s bucket matching is untouched.
 *
 * That claim is checkable, and if it is false the disclosure table needs a row. So it is checked
 * here rather than asserted there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sealForChannel, openForChannel, openHeader, bodyOf, HEADER_RESERVE, wireBytes,
} from "../../vault-client/src/blobs.ts";
import { BUCKETS, bucketFor, SEAL_OVERHEAD } from "../../vault-client/src/buckets.ts";
import { channelSecret } from "../../channel/src/pointer.ts";
import { subKey, derive, rootSeed, entropyFrom, fromTestVector, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { HEADER_BYTES, encodeHeader, decodeHeader, ratchetPublic, freshRatchetSeed }
  from "../../handshake/src/dh-ratchet.ts";

const root = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(11), "blob-header vector"))));
const addressing = channelSecret(root, "alice→bob");
/** A message key, standing in for what a ratcheting client would seal a body under. */
const content = subKey(addressing, "message key 7");
const bytes = (b: ReturnType<typeof sealForChannel>) => wireBytes(b) as unknown as Uint8Array;

const someHeader = () => encodeHeader({
  ratchetKey: ratchetPublic(freshRatchetSeed()),
  previousChainLength: 4,
  messageNumber: 7,
});

test("the reserve is exactly what a sealed header takes", () => {
  // Two constants that must agree, in two packages that must not import each other: the wire
  // fact lives in `blobs.ts` and the header layout in `dh-ratchet.ts`. If they drift, the header
  // block eats the first bytes of the body and the failure looks like a decryption error on a
  // message nobody touched.
  assert.equal(HEADER_RESERVE, HEADER_BYTES + SEAL_OVERHEAD);
});

test("A HEADERED BLOB IS STILL EXACTLY A BUCKET — the whole disclosure argument", () => {
  // Across every bucket and both sides of each boundary. If any of these is not a bucket the
  // vault refuses the upload; if any lands in a DIFFERENT bucket than the same payload without a
  // header, then the header is observable as a size and `observations.ts` needs a row.
  for (const bucket of BUCKETS) {
    for (const len of [0, 1, bucket - SEAL_OVERHEAD - HEADER_RESERVE - 4]) {
      if (len < 0) continue;
      const plain = new Uint8Array(len).fill(7);
      const withHeader = bytes(sealForChannel(content, plain,
        { bytes: someHeader(), addressing }));
      assert.ok(BUCKETS.includes(withHeader.length),
        `a ${len}-byte payload with a header sealed to ${withHeader.length}, which is not a bucket`);
      assert.equal(withHeader.length, bucketFor(len, SEAL_OVERHEAD + HEADER_RESERVE),
        `a ${len}-byte payload did not land in the bucket its reserve implies`);
    }
  }
});

test("the header is readable with the addressing key and nothing else", () => {
  // The property that makes a DH ratchet possible at all: the reader learns which ratchet key
  // sealed the body BEFORE it can derive the body's key.
  const h = someHeader();
  const blob = sealForChannel(content, new TextEncoder().encode("hello"),
    { bytes: h, addressing });
  const back = decodeHeader(openHeader(addressing, bytes(blob)));
  assert.deepEqual([...back.ratchetKey], [...decodeHeader(h).ratchetKey]);
  assert.equal(back.messageNumber, 7);
  assert.equal(back.previousChainLength, 4);

  // And the addressing key does NOT open the body. If it did, keeping it forever — which this
  // design does, so blob ids and cover stay derivable — would undo the message ratchet.
  assert.throws(() => openForChannel(addressing, bodyOf(bytes(blob))),
    /unable to authenticate|bad decrypt/i,
    "the addressing key opened the body — forward secrecy is gone");
});

test("the body still opens under the content key, header and all", () => {
  const text = "the quick brown fox";
  const blob = sealForChannel(content, new TextEncoder().encode(text),
    { bytes: someHeader(), addressing });
  const opened = openForChannel(content, bodyOf(bytes(blob)));
  assert.equal(new TextDecoder().decode(opened as unknown as Uint8Array), text);
});

test("a tampered header is refused rather than misread", () => {
  const blob = sealForChannel(content, new TextEncoder().encode("x"),
    { bytes: someHeader(), addressing });
  const wire = bytes(blob);
  for (const at of [0, 20, HEADER_RESERVE - 1]) {
    const bad = new Uint8Array(wire);
    bad[at] ^= 0xff;
    assert.throws(() => openHeader(addressing, bad), /unable to authenticate|bad decrypt/i,
      `flipping byte ${at} of the header block was not detected`);
  }
  // And a different channel's key does not open it, which is what stops a header being read
  // across conversations by an operator holding one channel's material.
  const other = channelSecret(root, "alice→carol");
  assert.throws(() => openHeader(other, wire), /unable to authenticate|bad decrypt/i);
});

test("without a header the bytes are exactly what they were before", () => {
  // The format change is additive, and this is the assertion that keeps it so. Every blob already
  // in a vault, and every test that measures sizes, depends on the headerless path not moving.
  const plain = new TextEncoder().encode("unchanged");
  const a = bytes(sealForChannel(content, plain));
  const b = bytes(sealForChannel(content, plain));
  assert.deepEqual([...a], [...b], "sealing is no longer deterministic");
  assert.equal(a.length, bucketFor(plain.length, SEAL_OVERHEAD));
  assert.equal(a.length, BUCKETS[0]);
  // A headered blob of the same payload is the same SIZE and different BYTES.
  const h = bytes(sealForChannel(content, plain, { bytes: someHeader(), addressing }));
  assert.equal(h.length, a.length, "the header changed the size after all");
  assert.notDeepEqual([...h], [...a]);
});

test("a header refuses to be the wrong size", () => {
  // The reserve is fixed, so a header that is not `HEADER_BYTES` cannot be sealed into it. Caught
  // here rather than by producing a blob whose body starts in the wrong place.
  assert.throws(() => sealForChannel(content, new Uint8Array(1),
    { bytes: new Uint8Array(HEADER_BYTES + 1), addressing }), /reserve is/);
  assert.throws(() => sealForChannel(content, new Uint8Array(1),
    { bytes: new Uint8Array(HEADER_BYTES - 1), addressing }), /reserve is/);
});

test("the real vault accepts a headered blob and reports the same bucket", async () => {
  // The premise of the whole argument is a line in `server.ts`: a body that is not exactly a
  // bucket is refused. So the claim is checked against that server rather than against BUCKETS.
  const { Vault, ENCRYPTED_ENDPOINT } = await import("../../vault-server/src/server.ts");
  const vault = new Vault({ invites: ["h1", "h2"], buckets: BUCKETS });
  const plain = new TextEncoder().encode("a message with a ratchet header");

  const plainBlob = sealForChannel(content, plain);
  const headered = sealForChannel(content, plain, { bytes: someHeader(), addressing });
  for (const [blob, invite] of [[plainBlob, "h1"], [headered, "h2"]] as const) {
    const res = vault.handle({
      op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blob.id,
      body: bytes(blob), invite,
    });
    assert.equal(res.ok, true, `the vault refused it: ${JSON.stringify(res)}`);
  }

  // Same bucket for both, which is the sentence `observations.ts` `blob.bucket` already carries.
  // If these differed, the header would be observable as a size and the table would need a row.
  const buckets = vault.observe().rows.map((r) => r["blob.bucket"]);
  assert.equal(new Set(buckets).size, 1,
    `a headered blob landed in a different bucket than a plain one: ${buckets.join(", ")}`);

  // And nothing new appears in the capture at all.
  const keys = vault.observedKeys();
  assert.ok(!keys.some((k) => /header|ratchet/i.test(k)),
    `the capture gained ${keys.filter((k) => /header|ratchet/i.test(k)).join(", ")}`);
});
