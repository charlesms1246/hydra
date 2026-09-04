/**
 * Looking a stranger's bundle up by address — the step that had no path.
 *
 * `decisions/0038` step 3: a bundle could only reach somebody out of band, so **a source needed a
 * prior relationship with the organisation they were anonymously contacting.** That is the same
 * shape as the invite gate — a prerequisite sitting in front of the surface, quietly undoing its
 * premise — and it is the one this closes.
 *
 * Composition rather than new protocol. `decisions/0031` verified the identity contract's data ABI
 * against live mainnet and Sepolia and landed a real record; `BundleRecord` already carried the
 * identity key, the signing key, the signed prekey and its signature. What was missing was a client
 * that reads one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { bundleFromChain } from "../../cli/src/commands.ts";
import { recordFor, encodeRecord, RECORD_FELTS } from "../../handshake/src/record.ts";
import { bundleFor, initiate, respond } from "../../handshake/src/x3dh.ts";
import { createStore, mintOneTime, bundleFrom } from "../../handshake/src/prekeys.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, expose, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { NODE_OBSERVABLE_IDS } from "../../cli/src/node-view.ts";

const rootOf = (n: number, label: string) =>
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(n), label))));
/** The organisation's own store, so a lookup can be compared against what they would hand over. */
const orgStore = (() => { const s = createStore(); mintOneTime(s, 2); return s; })();
const org = rootOf(21, "an organisation");
const impostor = rootOf(22, "an impostor");
const ORG_ADDRESS = 0x2afa2039a4173a1c327f6bb87d49bac815c5c50dfd9afa57f24609c2426c157n;
const ID = 4242n;

const state = {
  rpcUrl: "https://node.example/rpc", contract: "0x0", fromBlock: 0,
  accountsFile: "", account: "", network: "sepolia",
} as never;

/** A node that answers `get_main_id` and `get_extended_user_data` out of a fixture. */
function nodeServing(felts: bigint[] | null, id = ID): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { params: { request: { calldata: string[] } } };
    const isIdLookup = req.params.request.calldata.length === 1;
    const result = isIdLookup
      ? [`0x${id.toString(16)}`]
      : [`0x${RECORD_FELTS.toString(16)}`,
        ...(felts ?? new Array(RECORD_FELTS).fill(0n)).map((f) => `0x${f.toString(16)}`)];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
      { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const recordOf = (root: ReturnType<typeof rootOf>, owner: bigint,
  store = createStore()) => encodeRecord(recordFor(root, store, owner));

test("A STRANGER'S BUNDLE COMES OFF THE CHAIN, byte for byte what they would hand over", async () => {
  const looked = await bundleFromChain(state, ORG_ADDRESS,
    nodeServing(recordOf(org, ORG_ADDRESS, orgStore)));
  const theirs = bundleFrom(org, orgStore);

  // EQUALITY WITH WHAT THEY WOULD HAND YOU OUT OF BAND is the property, and it is the whole claim:
  // if the bytes are identical then everything that works with a hand-delivered bundle works with
  // this one, and `conversation.test.ts` already drives the agreement itself. Asserting the
  // agreement here would be re-testing X3DH through a fixture.
  for (const field of ["identityKey", "signingKey", "signedPrekey", "signedPrekeySignature"] as const) {
    assert.deepEqual(Buffer.from(looked[field]), Buffer.from(theirs[field]),
      `${field} came back different from the bundle the organisation would hand over`);
  }
  assert.equal(looked.epoch, theirs.epoch);

  // NO ONE-TIME PREKEY, which is the deliberate scope: those stay in the vault, and a record
  // carries no field for one. So a conversation opened from a chain record alone has no replay
  // resistance, and `hydra lookup` says so rather than letting somebody discover it.
  assert.ok(!("oneTimePrekey" in looked),
    "a one-time prekey reached the chain record — that is a different decision with its own cost");
});

test("A RECORD SIGNED FOR ANOTHER ADDRESS IS REFUSED — the whole attack", async () => {
  // `0027` established that a published key needs a signature over WHERE it is published, and
  // `verifyRecord` refuses a record whose anchor signature does not name its own address. Without
  // it, an impostor writes their own keys under any name and a source opens a conversation with
  // them believing it is the organisation: a stranger's key with an organisation's name on it.
  //
  // Checked by driving the real path rather than by calling `verifyRecord` beside it — the point
  // is that the lookup goes THROUGH the check, not that the check exists.
  const forged = recordOf(impostor, 0xdeadbeefn);   // signed for an address that is not the org's
  await assert.rejects(() => bundleFromChain(state, ORG_ADDRESS, nodeServing(forged)),
    /does not name|published elsewhere|signature/i,
    "a record signed for a different address was accepted as this one's bundle");

  // A well-formed record for the RIGHT address still passes, so the refusal is about the binding
  // and not about the fixture being malformed.
  await assert.doesNotReject(() =>
    bundleFromChain(state, ORG_ADDRESS, nodeServing(recordOf(org, ORG_ADDRESS))));
});

test("an address with no record, and one with no identity, both say so", async () => {
  // An all-zero record reads as absent rather than as a bundle of zeros — the distinction the
  // reader has to make, since the contract returns a zero span for an empty slot.
  await assert.rejects(() => bundleFromChain(state, ORG_ADDRESS, nodeServing(null)),
    /published no bundle record/);
  // And identity id 0 is refused rather than read out of slot zero, whatever happens to be there.
  // The refusal lives in `readRecordCall`, which is the single place that rule is written — the
  // lookup deliberately does not repeat it.
  await assert.rejects(() => bundleFromChain(state, ORG_ADDRESS, nodeServing(null, 0n)),
    /must be positive|reads as absent/);
});

test("the node learns which address you asked about, and the table says so", () => {
  // Rule 4. The disclosure MOVED rather than appeared — fetching a bundle from the target's vault
  // tells the party you are considering contacting that you are considering it — and moving it is
  // the improvement, because a node is a party you choose and their vault is not.
  assert.ok(NODE_OBSERVABLE_IDS.includes("node.recordLookup"),
    "a client asks a node about a named address and no row says so");
});
