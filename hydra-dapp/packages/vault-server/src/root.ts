/**
 * A commitment over the public objects this vault holds, so a removal can be proved.
 *
 * `decisions/0039`. `removedIds` used to be the operator's own list of objects nobody could fetch,
 * with nothing attesting they were ever there — **an operator who silently dropped a post and never
 * listed it was indistinguishable from one who never received it.** A transparency report that
 * cannot be audited by anybody is not doing the one thing it exists to do.
 *
 * OPERATOR-SIDE, NOT AUTHOR-SIDE, and that is the whole reason this is possible. `0011`/`0012`
 * established that publishing a pointer names the author in `sender_address`, so anchoring a public
 * post author-side costs the author their anonymity — for a class whose entire purpose is anonymous
 * publishing. Committing here names no author and touches no author key: a removal is provable as
 * "in root N, absent from root N+1", and the operator's signature is on both.
 *
 * OVER ALL PUBLIC IDS, NEVER ONLY THE REMOVED ONES. A root over removals lets the operator choose
 * what to be accountable for, which is the same failure one level up from the one being fixed.
 *
 * PADDED TO A FIXED SIZE, AND THAT IS NOT TIDINESS. An unpadded tree publishes its leaf count, and
 * a sequence of leaf counts is a **standing lower bound on removals**: additions cannot be
 * negative, so a fall of 11 with a published cell of 7 pins a banded cell at 4 — no knowledge of
 * additions required. That is the third differencing shape this report has met, after banding and
 * rounding, and `transparency.test.ts` carries all three. Every period's tree is the same size, so
 * there is no delta to difference.
 *
 * IT NEEDS NO CHAIN TO BE USEFUL. A signed, published root is already non-repudiable against the
 * operator, which is the party a transparency report is about. A chain leg adds third-party
 * timestamping and censorship resistance — an upgrade, and it can be added later without changing
 * this shape.
 *
 * AND IT IS NOT AN INDEX. The root discloses no id, and a proof is only obtainable for an id you
 * already hold — which is the same precondition as fetching the object. `hydra post` promises there
 * is "no feed and no index", and this keeps that promise.
 */

import { createHash } from "node:crypto";

/**
 * Leaves per tree, fixed. 2^16, so a proof is 16 hashes — 512 bytes.
 *
 * WHAT HAPPENS WHEN A CORPUS OUTGROWS IT is a disclosure event, so it is written down rather than
 * met by surprise: the tree doubles, every proof grows by one hash, and that step is public. It
 * discloses one bit — *the corpus passed 65,536 objects in this period* — which can only be crossed
 * upward, is a threshold rather than a running total, and says nothing about removals. It must be
 * announced in the report for the period it happens in, because a reader whose proof length changed
 * with no explanation is a reader guessing.
 */
export const TREE_LEAVES = 1 << 16;

const H = (...parts: (string | Uint8Array)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
};

/**
 * A leaf, domain-separated from an interior node and from the padding marker.
 *
 * WHICH DEFENCE DOES WHAT, established by mutation rather than assumed — two versions of the test
 * for this passed with the separation stripped out, because they described an attack something
 * else was blocking:
 *
 *   - Presenting an interior node as a leaf (choose `id = a || b`, so an undomained `sha256(id)`
 *     is exactly the parent) is refused by the **fixed depth**: climbing a level shortens the
 *     path, and `verifyProof` requires exactly `log2(TREE_LEAVES)` siblings.
 *   - What the separation actually prevents is a collision with the **padding leaf**. Undomained,
 *     an id equal to the string behind `EMPTY` hashes to the padding value — and every tree is
 *     mostly padding, so that one id would be provably present in every root ever published.
 */
const leaf = (id: string) => H("hydra/vault/root/leaf/v1", id);
const node = (a: string, b: string) => H("hydra/vault/root/node/v1", a, b);

/** The padding leaf. Fixed and public: it hides how many real objects there are, not which. */
const EMPTY = H("hydra/vault/root/empty/v1");

/**
 * Every level of the tree, leaves first.
 *
 * Ids are SORTED so the root is a function of the set and not of insertion order — two vaults
 * holding the same objects must publish the same root, or the commitment says something about
 * arrival sequence that nobody asked it to say.
 */
function levels(ids: readonly string[]): string[][] {
  if (ids.length > TREE_LEAVES) {
    throw new Error(`${ids.length} objects exceeds the ${TREE_LEAVES}-leaf tree. Doubling it is a `
      + "public step that discloses the corpus passed this threshold — see decisions/0039, and "
      + "announce it in the report for the period it happens in.");
  }
  const sorted = [...ids].sort();
  let level = [...sorted.map(leaf), ...new Array(TREE_LEAVES - sorted.length).fill(EMPTY)];
  const out = [level];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(node(level[i], level[i + 1]));
    out.push(next);
    level = next;
  }
  return out;
}

/** The commitment. Identical in size and shape whatever the corpus holds. */
export function rootOf(ids: readonly string[]): string {
  const all = levels(ids);
  return all[all.length - 1][0];
}

/**
 * The path proving one id is in the tree, or `null` if it is not there.
 *
 * ONLY OBTAINABLE FOR AN ID YOU ALREADY HAVE, which is what keeps this from being an index: the
 * precondition is the same one fetching the object has.
 */
export function proofFor(ids: readonly string[], id: string): Proof | null {
  const sorted = [...ids].sort();
  const at = sorted.indexOf(id);
  if (at < 0) return null;
  const all = levels(ids);
  const path: string[] = [];
  let index = at;
  for (let l = 0; l < all.length - 1; l++) {
    path.push(all[l][index ^ 1]);
    index >>= 1;
  }
  return { index: at, path };
}

/** A membership proof: which leaf, and the siblings up to the root. */
export type Proof = { readonly index: number; readonly path: readonly string[] };

/**
 * Check a proof without holding the corpus. Anyone can run this; that is the point.
 */
export function verifyProof(root: string, id: string, proof: Proof): boolean {
  // The index says which side the leaf sits on at each level. THE PROVER SUPPLYING IT IS NOT A
  // WEAKNESS — a wrong index simply produces a different root and fails. The first version of this
  // tried both orderings at every level to avoid trusting it, which doubles the frontier per level
  // and is 2^16 hashes deep by the top: exponential work to avoid trusting a value that cannot be
  // abused.
  if (proof.path.length !== Math.log2(TREE_LEAVES)) return false;
  if (!Number.isInteger(proof.index) || proof.index < 0 || proof.index >= TREE_LEAVES) return false;
  let hash = leaf(id);
  let index = proof.index;
  for (const sibling of proof.path) {
    hash = (index & 1) === 0 ? node(hash, sibling) : node(sibling, hash);
    index >>= 1;
  }
  return hash === root;
}
