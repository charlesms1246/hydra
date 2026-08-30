/**
 * The whole client path, against a running chain.
 *
 * Everything else in this directory is hermetic: it models the chain rather than talking to
 * one. That is the right default — a suite that needs a node is a suite people stop running —
 * but it leaves one class of bug uncovered, the kind where the model and the node disagree.
 * Felt encoding, event serialisation, argument order at the ABI boundary: each is invisible to
 * a test that never leaves the process, and each produces a pointer nobody can resolve.
 *
 * So this is opt-in, and deliberately NOT part of `npm test`:
 *
 *     hydra up                                   # in devtool/, brings up devnet and the pool
 *     cd hydra-dapp/contracts
 *     scarb build
 *     sncast ... declare --contract-name Channel
 *     sncast ... deploy --class-hash <hash>
 *     sncast ... invoke --function privacy_invoke --arguments "<pointer>, <commitment>"
 *     HYDRA_RPC=http://127.0.0.1:45055 HYDRA_CHANNEL=0x… npm run test:live
 *
 * It is read-only. It asserts that a pointer and commitment this code computed off-chain are
 * present, unaltered, in an event the node actually emitted — which is the property the rest
 * of the suite assumes and cannot check.
 *
 * A missing environment variable fails rather than skips, for the usual reason: the run that
 * silently does nothing is the run that gets counted as a pass.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { channelSecret, pointerFor, blobIdFrom } from "../../channel/src/pointer.ts";
import { noteCalldata, feltToPointer, pointerToFelt } from "../../channel/src/note.ts";
import { commit, contentHashFor } from "../../channel/src/commitment.ts";
import { sealForChannel, wireBytes } from "../../vault-client/src/blobs.ts";
import { rootSeed, entropyFrom, derive, VAULT_DOMAIN, fromTestVector} from "../../identity/src/domains.ts";

const RPC = process.env.HYDRA_RPC;
const CHANNEL = process.env.HYDRA_CHANNEL;

/** The same inputs the deployment step published. Deterministic, so the event is findable. */
const chan = channelSecret(
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(11), "live")))),
  "alice→bob",
);
const content = new TextEncoder().encode("a real message, on a real chain");
const blob = sealForChannel(chan, content);
const blobId = blobIdFrom(wireBytes(blob) as unknown as Uint8Array);
const pointer = pointerFor(chan, blobId, 0);
const expected = noteCalldata(pointer, commit(42n, contentHashFor(content)));

async function rpc(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(RPC!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

let events: { data: string[] }[] = [];

before(async () => {
  assert.ok(RPC && CHANNEL,
    "set HYDRA_RPC and HYDRA_CHANNEL — see the header. A live test that skips is a live test "
    + "nobody notices has stopped working.");
  const page = await rpc("starknet_getEvents", {
    filter: {
      from_block: { block_number: 0 },
      to_block: "latest",
      address: CHANNEL,
      chunk_size: 100,
    },
  }) as { events: { data: string[] }[] };
  events = page.events;
});

test("the chain holds an event carrying exactly what this code computed", async () => {
  // Not "an event exists" — the specific felts. If the ABI serialised them in the other order,
  // or a felt were reduced somewhere, this is what notices.
  assert.ok(events.length > 0, `no events from ${CHANNEL}; was privacy_invoke ever called?`);
  const match = events.find((e) =>
    e.data.length === 2
    && BigInt(e.data[0]) === expected[0]
    && BigInt(e.data[1]) === expected[1]);
  assert.ok(match,
    `no event matched.\n  expected ${expected[0]}, ${expected[1]}\n  saw ${
      events.map((e) => e.data.map((d) => BigInt(d).toString()).join(", ")).join("\n      ")}`);
});

test("every event the contract emits carries exactly two felts", () => {
  // I4, checked against the node rather than against the signature. A struct that grew a field
  // would still compile and still pass the source-level check in i4-note-payload.
  for (const e of events) {
    assert.equal(e.data.length, 2, `an event carried ${e.data.length} felts, not 2`);
  }
});

test("the pointer survives the round trip through a felt and back", async () => {
  // The encoding this whole path rests on: 31 bytes -> felt -> chain -> felt -> 31 bytes.
  const onChain = events.find((e) => BigInt(e.data[0]) === expected[0]);
  assert.ok(onChain);
  const recovered = feltToPointer(BigInt(onChain.data[0]));
  assert.deepEqual(recovered, pointer);
  assert.equal(pointerToFelt(recovered), expected[0]);
});

test("nothing on chain reveals the blob it points at", () => {
  // The I3 claim, verified against real event data rather than a model of it. The blob id must
  // not be recoverable from what was published, by anyone without the channel secret.
  const onChain = events.find((e) => BigInt(e.data[0]) === expected[0])!;
  const published = feltToPointer(BigInt(onChain.data[0]));
  assert.notDeepEqual(published, blobId);
  // And no prefix or suffix of it either, which is what a partial leak would look like.
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  assert.ok(!hex(published).includes(hex(blobId).slice(0, 16)));
  assert.ok(!hex(published).includes(hex(blobId).slice(-16)));
  // Nor does the commitment, which is a hash of a hash of the content.
  assert.notEqual(BigInt(onChain.data[1]), pointerToFelt(blobId));
});
