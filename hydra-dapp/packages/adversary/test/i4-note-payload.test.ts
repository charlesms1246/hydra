/**
 * I4 — payloads are never stored as pool notes.
 *
 * `HYDRA_HANDOFF.md` I4: "No pool action persists arbitrary calldata, and the helper-event
 * route caps ciphertext at roughly 140 felts. The pool carries pointers and commitments only."
 *
 * The interesting form of this invariant is not "the payload is small enough". It is that
 * there is nowhere to put a payload at all. So the checks below are about the *shape* of the
 * interface — a fixed pair of felts, and a Cairo entrypoint with no array argument — rather
 * than about a size limit, because a size limit is a branch someone can widen and a missing
 * parameter is not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { NOTE_FELTS, noteCalldata, pointerToFelt, feltToPointer } from "../../channel/src/note.ts";
import { channelSecret, pointerFor, blobIdFrom } from "../../channel/src/pointer.ts";
import { commit, contentHashFor, P } from "../../channel/src/commitment.ts";
import { sealForChannel, wireBytes } from "../../vault-client/src/blobs.ts";
import { rootSeed, entropyFrom, derive, VAULT_DOMAIN } from "../../identity/src/domains.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(HERE, "..", "..", "..", "contracts");
const seed = rootSeed(entropyFrom(new Uint8Array(32).fill(4), "i4 test vector"));
const chan = channelSecret(derive(VAULT_DOMAIN, seed), "alice→bob");

test("a message of any size puts exactly two felts on chain", () => {
  // The claim, fuzzed across four orders of magnitude. If the on-chain footprint ever varied
  // with the message, the chain would be disclosing message size — which is precisely what
  // the vault's size buckets are spent on hiding.
  for (const n of [0, 1, 512, 4_000, 60_000, 250_000]) {
    const content = new Uint8Array(n).fill(n & 0xff);
    const blob = sealForChannel(chan, content);
    const calldata = noteCalldata(
      pointerFor(chan, blobIdFrom(wireBytes(blob) as unknown as Uint8Array), 0),
      commit(1n, contentHashFor(content)),
    );
    assert.equal(calldata.length, NOTE_FELTS);
    for (const felt of calldata) assert.ok(felt >= 0n && felt < P, "calldata is not a field element");
  }
});

test("the Cairo entrypoint has no argument a payload could ride in", () => {
  // The enforcement point. A `Span<felt252>` or an `Array<felt252>` here would make I4 a
  // matter of review rather than of signature, and this is the check that notices one being
  // added — including through a struct, which is the version that looks innocent.
  const src = readFileSync(join(CONTRACTS, "src", "channel.cairo"), "utf8");
  const signature = src.match(/fn privacy_invoke\(([^)]*)\)/);
  assert.ok(signature, "privacy_invoke is gone or was renamed");
  const params = signature[1].split(",").map((p) => p.trim()).filter(Boolean);
  // `ref self` plus exactly two felts.
  assert.equal(params.length, 3, `privacy_invoke takes ${params.length} parameters, expected 3`);
  assert.match(params[0], /^ref self/);
  for (const p of params.slice(1)) assert.match(p, /: *felt252$/, `${p} is not a bare felt252`);
  assert.ok(!/Array<|Span<|ByteArray|Vec</.test(signature[1]),
    "privacy_invoke gained a variable-length argument");
});

test("two felts is far below anything the pool would cap", () => {
  // The handoff cites a helper-event route capping ciphertext near 140 felts. This does not
  // approach it, and the margin is the point: there is no message size at which the design
  // needs to think about the cap, so the cap never becomes a design constraint that someone
  // is tempted to engineer around.
  assert.ok(NOTE_FELTS * 10 < 140, "the note is within an order of magnitude of the pool's cap");
});

test("the pointer felt round-trips exactly", () => {
  // 31 bytes was chosen so this is total. If it ever were not, a pointer would be silently
  // truncated and the recipient would fetch a blob that does not exist.
  for (let i = 0; i < 200; i++) {
    const blobId = blobIdFrom(new Uint8Array(64).fill(i));
    const pointer = pointerFor(chan, blobId, i);
    assert.deepEqual(feltToPointer(pointerToFelt(pointer)), pointer);
  }
  // Including the extremes, which is where a byte-order or padding bug lives.
  for (const fill of [0x00, 0xff]) {
    const p = new Uint8Array(31).fill(fill);
    assert.deepEqual(feltToPointer(pointerToFelt(p)), p);
  }
});

test("nothing in the note interface accepts content", () => {
  // `noteCalldata` takes a pointer and a commitment. A future overload taking bytes would
  // satisfy every test above while reintroducing exactly what I4 forbids.
  const src = readFileSync(join(HERE, "..", "..", "channel", "src", "note.ts"), "utf8");
  const exports = src.split("\n").filter((l) => l.startsWith("export function"));
  assert.ok(exports.length > 0);
  for (const line of exports) {
    assert.ok(!/Uint8Array\s*\)?\s*,\s*\w+\s*:\s*Uint8Array/.test(line), `${line} takes a buffer pair`);
    assert.ok(!/content|payload|message|body|plaintext/i.test(line),
      `${line} names content — the note carries a reference, never the thing`);
  }
});

test("a value outside the field is refused rather than wrapped", () => {
  const pointer = pointerFor(chan, blobIdFrom(new Uint8Array(8)), 0);
  assert.throws(() => noteCalldata(pointer, P), /field element/);
  assert.throws(() => noteCalldata(pointer, -1n), /field element/);
  // Cast because the type now also carries the channel domain (I6); this line is about the
  // runtime length guard, which still has to hold for callers that arrived past the type.
  assert.throws(() => noteCalldata(new Uint8Array(32) as never, 1n), /31 bytes/);
  assert.throws(() => feltToPointer(P - 1n), /31 bytes/);
});
