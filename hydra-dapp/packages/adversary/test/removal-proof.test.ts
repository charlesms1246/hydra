/**
 * Proving a removal — `decisions/0039` Option A.
 *
 * `removedIds` was the operator's own list of objects nobody could fetch, with nothing attesting
 * they were ever there: **an operator who silently dropped a post and never listed it was
 * indistinguishable from one who never received it.** A transparency report nobody can audit is not
 * doing the one thing it exists to do.
 *
 * The fix commits OPERATOR-SIDE, which is what makes it possible at all — `0011`/`0012` established
 * that publishing a pointer names the author, so an author-side anchor costs the author their
 * anonymity for a class whose purpose is anonymous publishing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Vault, PUBLIC_ENDPOINT, ENCRYPTED_ENDPOINT } from "../../vault-server/src/server.ts";
import { rootOf, proofFor, verifyProof, TREE_LEAVES } from "../../vault-server/src/root.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { publish, wireBytes } from "../../vault-client/src/blobs.ts";
import { createHash } from "node:crypto";

const intent = { confirmedPublicAt: "2026-09-04T00:00:00Z", reason: "removal proof" };
const bytes = (b: Parameters<typeof wireBytes>[0]) => wireBytes(b) as unknown as Uint8Array;
const ids = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `pub:${(i + from).toString(16).padStart(8, "0")}`);

test("A REMOVAL IS PROVABLE: in root N, absent from root N+1", async () => {
  const vault = new Vault({ invites: ["a", "b", "c"], buckets: BUCKETS });
  const posts = ["one", "two", "three"].map((t) =>
    publish(new TextEncoder().encode(t), intent));
  posts.forEach((p, i) => vault.handle({
    op: "upload", endpoint: PUBLIC_ENDPOINT, id: p.id, body: bytes(p), invite: "abc"[i],
  }));

  // Period N: the object is in the corpus, and anyone holding its id can prove it.
  const before = vault.publicRoot();
  const proof = vault.publicProof(posts[1].id)!;
  assert.ok(proof, "no proof for an object the vault holds");
  assert.equal(verifyProof(before, posts[1].id, proof), true);

  // The operator removes it. Period N+1.
  vault.handle({ op: "remove", id: posts[1].id });
  const after = vault.publicRoot();
  assert.notEqual(after, before, "the root did not change when an object was removed");

  // THE AUDIT, which is the whole point: the old proof still verifies against the OLD root, and
  // the object is not in the new one. Nobody needs the vault's cooperation to check either.
  assert.equal(verifyProof(before, posts[1].id, proof), true,
    "the proof stopped verifying against the root it was made under — history is not fixed");
  assert.equal(vault.publicProof(posts[1].id), null);
  // And its neighbours are untouched, so a removal is one object rather than a reshuffle claim.
  for (const p of [posts[0], posts[2]]) {
    assert.equal(verifyProof(after, p.id, vault.publicProof(p.id)!), true);
  }
});

test("SILENT DROPPING IS DETECTABLE, which is the case that was invisible", () => {
  // The accusation the old report could neither support nor refute. An object present in root N
  // and absent from N+1 with no entry in the report is exactly that, and it is now checkable by
  // anybody holding the id — which, for a public object, is anybody who ever read it.
  const corpus = ids(40);
  const before = rootOf(corpus);
  const proof = proofFor(corpus, corpus[9])!;
  const after = rootOf(corpus.filter((id) => id !== corpus[9]));

  assert.equal(verifyProof(before, corpus[9], proof), true);
  assert.equal(proofFor(corpus.filter((id) => id !== corpus[9]), corpus[9]), null);
  assert.notEqual(before, after);
});

test("THE ROOT DISCLOSES NO CORPUS SIZE — the property the padding exists for", () => {
  // The measurement that made this Option A PLUS a padded tree: an unpadded tree publishes its
  // leaf count, and a sequence of leaf counts is a standing lower bound on removals, because
  // additions cannot be negative. See transparency.test.ts, third counterexample of that shape.
  //
  // Checked as a property of the artifact rather than as an argument: every root is the same
  // length, every proof is the same length, whatever the corpus holds.
  const sizes = [0, 1, 2, 17, 500, 4096];
  const roots = sizes.map((n) => rootOf(ids(n)));
  assert.equal(new Set(roots.map((r) => r.length)).size, 1,
    "roots differ in length, so the root itself leaks the corpus size");
  assert.equal(new Set(roots).size, roots.length, "two different corpora produced one root");

  for (const n of [1, 17, 500]) {
    const corpus = ids(n);
    const p = proofFor(corpus, corpus[0])!;
    assert.equal(p.path.length, Math.log2(TREE_LEAVES),
      "proof length varies with corpus size, so the proof leaks what the root does not");
  }
});

test("a leaf cannot be forged out of an interior node", () => {
  // The second-preimage attack a Merkle tree invites without domain separation: present an
  // interior node as a leaf and prove membership of something never stored. Cheap to prevent and
  // expensive to notice, so it is asserted rather than assumed.
  const corpus = ids(8);
  const root = rootOf(corpus);
  const proof = proofFor(corpus, corpus[0])!;

  // WHICH DEFENCE DOES WHAT, established by mutation rather than by assumption. Two versions of
  // this test passed under a mutation that stripped domain separation entirely, because the
  // attack they described is blocked by something else:
  //
  //   - Presenting an interior node as a leaf (`id = a || b`, so `sha256(id)` is the parent) is
  //     blocked by the FIXED DEPTH. Climbing a level shortens the path, and `verifyProof` refuses
  //     any path that is not exactly log2(TREE_LEAVES). Not by the domain separation.
  //   - What separation actually protects is the PADDING LEAF. Undomained, `leaf(x) = sha256(x)`
  //     and the empty leaf is `sha256("hydra/vault/root/empty/v1")` — so an id equal to that
  //     string hashes to the padding value, and every tree is full of padding.
  const forged = "hydra/vault/root/empty/v1";
  assert.notEqual(rootOf([forged]), rootOf([]),
    "an id equal to the padding leaf's preimage is indistinguishable from padding — leaves and "
    + "the empty marker are not separated, so it is provably present in every tree ever published");
  // The level-climbing attempt, kept because it is what an attacker tries first, with the reason
  // it fails recorded next to it.
  const undomained = createHash("sha256").update(corpus[0]).digest("hex");
  assert.equal(verifyProof(root, undomained + proof.path[0],
    { index: proof.index >> 1, path: proof.path.slice(1) }), false,
    "a shortened path verified — the fixed-depth check is what refuses this one");
  // And a proof for one id does not verify another.
  assert.equal(verifyProof(root, corpus[1], proof), false);
  // Nor does a tampered path, or a wrong index.
  assert.equal(verifyProof(root, corpus[0], { ...proof, index: proof.index ^ 1 }), false);
  assert.equal(verifyProof(root, corpus[0], { ...proof, path: proof.path.slice(1) }), false);
});

test("the root is a function of the SET, not of arrival order", () => {
  // Two vaults holding the same objects must publish the same root, or the commitment says
  // something about arrival sequence nobody asked it to say — and an operator could then produce
  // a different root for the same corpus by reordering.
  const corpus = ids(30);
  const shuffled = [...corpus].reverse();
  assert.equal(rootOf(shuffled), rootOf(corpus));
});

test("encrypted objects are not in the tree, and a full tree refuses rather than truncating", () => {
  // The tree is over the PUBLIC class only. An encrypted object in a published commitment would
  // let anyone holding an id test whether the vault holds it, which is a capability nothing else
  // in this design grants.
  const vault = new Vault({ invites: ["e"], buckets: BUCKETS });
  const enc = new Uint8Array(BUCKETS[0]);
  vault.handle({ op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: "enc:abcd", body: enc, invite: "e" });
  assert.equal(vault.publicRoot(), rootOf([]), "an encrypted object reached the public tree");

  // And the ceiling refuses loudly rather than silently dropping objects out of the commitment,
  // which would be an operator choosing what to be accountable for by overflowing.
  assert.throws(() => rootOf(ids(TREE_LEAVES + 1)), /exceeds the .* tree|decisions\/0039/);
});

test("THE AUDIT RUNS OVER HTTP, by somebody who is not the operator", async () => {
  // The claim of `decisions/0039` is that anybody can check a removal WITHOUT the operator's
  // cooperation. That is only true if a client can do it, so this drives the real endpoints — a
  // verifier only the operator runs is a verifier nobody has, which is what the reachability sweep
  // said when `verifyProof` had no caller outside a test.
  const vault = new Vault({ invites: ["a", "b"], buckets: BUCKETS });
  const { serve } = await import("../../vault-server/src/http.ts");
  const { url, server } = await serve(vault);
  try {
    const posts = ["kept", "doomed"].map((t) => publish(new TextEncoder().encode(t), intent));
    for (const [i, p] of posts.entries()) {
      await fetch(`${url}${PUBLIC_ENDPOINT}/${p.id}`,
        { method: "PUT", headers: { "x-hydra-invite": "ab"[i] }, body: bytes(p) });
    }
    const rootOf1 = async () =>
      (await (await fetch(`${url}${PUBLIC_ENDPOINT}/root`)).json() as { root: string }).root;
    const proofOf = async (id: string) =>
      (await (await fetch(`${url}${PUBLIC_ENDPOINT}/proof`,
        { method: "POST", body: JSON.stringify({ id }) })).json() as
        { proof: { index: number; path: string[] } | null }).proof;

    const before = await rootOf1();
    const kept = await proofOf(posts[1].id);
    assert.equal(verifyProof(before, posts[1].id, kept!), true);

    vault.handle({ op: "remove", id: posts[1].id });
    const after = await rootOf1();

    // The auditor keeps the old root and proof; the vault cannot take them back.
    assert.equal(verifyProof(before, posts[1].id, kept!), true);
    assert.equal(await proofOf(posts[1].id), null);
    assert.notEqual(after, before);

    // A MISSING PROOF IS 200 WITH null, not 404 — an auditor asks precisely about ids that are
    // supposed to be gone, and a distinguishable error would make "removed" and "never here"
    // answer differently on a path whose whole job is telling them apart with evidence.
    const res = await fetch(`${url}${PUBLIC_ENDPOINT}/proof`,
      { method: "POST", body: JSON.stringify({ id: "pub:neverexisted" }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { proof: unknown }).proof, null);

    // And the root endpoint discloses no count.
    const meta = await (await fetch(`${url}${PUBLIC_ENDPOINT}/root`)).json() as
      Record<string, unknown>;
    assert.deepEqual(Object.keys(meta).sort(), ["leaves", "root"]);
    assert.equal(meta.leaves, TREE_LEAVES, "the endpoint reports a variable leaf count");
  } finally { server.close(); }
});
