/**
 * The cover salt descends from a random blind, and no substitution that merely type-checks is
 * allowed to replace it.
 *
 * **THIS GUARD EXISTS BECAUSE A DRAFT OF `decisions/0042` PROPOSED EXACTLY THAT SUBSTITUTION**, and
 * every existing check would have passed it. Removing the chain leg makes the on-chain commitment
 * look chain-dependent, and the obvious replacement — a content hash — is a silent regression:
 *
 *   - `cover.ts` states which half does the work: *"only the commitment also separates two DEVICES
 *     sharing an identity, because it descends from a random blind rather than from a counter both
 *     devices keep."* A content hash descends from the CONTENT, so two devices on one identity
 *     sending identical bytes — `ok`, an emoji, the same short reply — mint **byte-identical
 *     decoys**, which `decisions/0033` calls a proof rather than an inference that two clients
 *     share an identity.
 *   - **`saltFrom` would not have fired.** It is a MAGNITUDE check: it refuses values below 2^64
 *     because that range means a counter or an unset field. A content hash is a full-range felt
 *     and passes cleanly.
 *
 * So the protection would have looked intact with the property gone — this project's recurring
 * failure, in a security guard rather than a fixture. What follows checks the PROVENANCE of the
 * salt rather than its shape, because shape is what the existing check already covers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { send, openChannel } from "../../client/src/session.ts";
import { sealForChannel } from "../../vault-client/src/blobs.ts";
import { coverBody, coverId, saltFrom, isCommitment } from "../../channel/src/cover.ts";
import { commit, contentHashFor } from "../../channel/src/commitment.ts";
import { ephemeral } from "../../handshake/src/authorship.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { codeOf } from "../src/prose.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rootOf = (n: number) =>
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(n), `d${n}`))));
const config = (root: ReturnType<typeof rootOf>) =>
  ({ channel: openChannel(root, "a→b"), author: ephemeral(), blockMs: 30_000 });

test("TWO DEVICES ON ONE IDENTITY SENDING IDENTICAL BYTES MINT DIFFERENT COVER", () => {
  // `decisions/0033`'s property, stated as the thing that must survive every future refactor of
  // where the salt comes from. Identical text, identical sequence, identical channel — one shared
  // identity, two clients. If their decoys collide, the vault holds a proof they are one person.
  const shared = rootOf(11);
  const text = new TextEncoder().encode("ok");

  const a = send(config(shared), text, 0, 0, () => 0.5);
  const b = send(config(shared), text, 0, 0, () => 0.5);

  const decoysOf = (commitment: bigint) => {
    const salt = saltFrom(commitment);
    return BUCKETS.map((bucket) => coverId(coverBody(config(shared).channel, bucket, 0, salt)));
  };
  const ofA = decoysOf(a.calldata[1]);
  const ofB = decoysOf(b.calldata[1]);

  assert.notDeepEqual(ofA, ofB,
    "two devices on one identity minted IDENTICAL cover for identical bytes — the salt no longer "
    + "descends from a random blind, and the vault now holds proof the two clients are one person");
  // And the commitments themselves differ, which is the mechanism rather than the symptom.
  assert.notEqual(a.calldata[1], b.calldata[1],
    "two sends of identical content produced one commitment, so the blind is not random");
});

test("THE SAME CONTENT HASHES THE SAME — which is why a content hash cannot be the salt", () => {
  // The counter-example made explicit, so nobody has to re-derive why the substitution fails.
  const text = new TextEncoder().encode("ok");
  assert.equal(contentHashFor(text), contentHashFor(new TextEncoder().encode("ok")),
    "the content hash is not deterministic, which would make this whole argument moot");

  // A content hash passes `saltFrom` cleanly — it is a full-range felt, and the existing check is
  // about MAGNITUDE, not provenance. This is the assertion that says the old guard cannot help.
  const asSalt = contentHashFor(text);
  assert.equal(isCommitment(asSalt), true,
    "a content hash no longer passes saltFrom, which would mean the substitution is caught after "
    + "all — recheck before relying on this test's premise");
  assert.doesNotThrow(() => saltFrom(asSalt));
});

test("THE COMMITMENT IS COMPUTED LOCALLY, so nothing about it needed a chain", () => {
  // The correction that made the substitution unnecessary in the first place. `session.ts`
  // computes it before anything is published; the chain was where it was PUBLISHED, never where it
  // was MADE. Asserted against the source so a refactor that moves the computation is visible.
  const src = codeOf(readFileSync(
    join(import.meta.dirname, "..", "..", "client", "src", "session.ts"), "utf8"));
  assert.match(src, /commit\(blind, contentHashFor\(plaintext\)\)/,
    "the commitment is no longer computed from a local blind and the plaintext — if it now comes "
    + "from somewhere else, decisions/0042 §2b's reasoning needs redoing");

  // And it really is a pure function of those two, so a client with no chain can produce it.
  const blind = 0x1234_5678_9abc_def0_1234n;
  const hash = contentHashFor(new TextEncoder().encode("anything"));
  assert.equal(commit(blind, hash), commit(blind, hash));
});

test("NO DERIVED VALUE CAN BE THE SALT, because the whole seal is deterministic by design", () => {
  // **THE STRUCTURAL ANSWER, and it is why two separate proposals to derive the salt both failed.**
  //
  // The first was a content hash. The second — mine, while looking for a way to avoid spending
  // header bytes — was a hash of the CIPHERTEXT, on the reasoning that a ciphertext carries a
  // random nonce. It does not: `sealForChannel` derives the nonce as `HMAC(key, padded)`, a
  // synthetic IV, deliberately, so that content addressing is stable and a nonce cannot be reused
  // catastrophically.
  //
  // So the seal is deterministic end to end, and **every "derive it from what we already have"
  // answer reduces to the content.** Only an explicitly random value separates two devices, and a
  // random value cannot be derived — by definition. It has to travel.
  //
  // That is not a preference between two designs. It is the reason there is only one.
  const shared = rootOf(12);
  const text = new TextEncoder().encode("ok");
  const one = sealForChannel(config(shared).channel, text);
  const two = sealForChannel(config(shared).channel, text);

  assert.equal(one.id, two.id,
    "the seal is no longer deterministic. If a fresh random nonce has been introduced, content "
    + "addressing is no longer stable — and the argument above needs redoing, because a "
    + "ciphertext-derived salt would then be viable");
  assert.deepEqual(Buffer.from(one.ciphertext as unknown as Uint8Array),
    Buffer.from(two.ciphertext as unknown as Uint8Array));

  // Which is exactly why `decisions/0033` needed a random blind: everything else in this pipeline
  // is deterministic on purpose, so the blind is the only randomness two devices do not share.
  const a = send(config(shared), text, 0, 0, () => 0.5);
  const b = send(config(shared), text, 0, 0, () => 0.5);
  assert.notEqual(a.calldata[1], b.calldata[1],
    "the commitment is the same for two sends of identical content, so the blind is not random "
    + "and nothing in this pipeline separates two devices");
});
