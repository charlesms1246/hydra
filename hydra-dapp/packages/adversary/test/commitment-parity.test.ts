/**
 * Cairo and TypeScript must compute the same commitment.
 *
 * A client binds a commitment into a note off-chain; a verifier checks it on chain. If the two
 * implementations disagree — different Poseidon, different felt encoding of the domain tag,
 * different behaviour at the field boundary — the failure is silent. Nothing throws. There is
 * simply a proof that verifies against nothing, or a commitment nobody can open, and it is
 * discovered by a user who cannot prove they wrote something they did write.
 *
 * So this does not re-implement the check in TypeScript and hope. It runs `snforge test`,
 * reads the vectors `contracts/tests/vectors.cairo` prints, and requires every one to match.
 * Cairo is the authority; `packages/channel/src/commitment.ts` follows it.
 *
 * A missing `snforge` is a FAILURE, not a skip — for the same reason the I1 build check fails
 * when tsc is absent. A parity test that silently does not run is worse than none, because
 * the suite still reports green.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { commit, contentHashFor, shortString, DOMAIN, P } from "../../channel/src/commitment.ts";

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts");

/** Run the Cairo and read back what it printed. snforge exits non-zero if any test fails. */
function cairoVectors(): { domain: bigint; cases: [bigint, bigint, bigint][] } {
  let out = "";
  try {
    out = execFileSync("snforge", ["test", "vectors"], {
      cwd: CONTRACTS,
      encoding: "utf8",
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: string };
    // ENOENT means snforge is not installed; anything else means the Cairo itself failed.
    assert.fail(
      err.code === "ENOENT"
        ? "snforge is not on PATH — the parity test cannot run, and a skipped parity test is a green suite that proves nothing"
        : `snforge failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`,
    );
  }
  const domain = out.match(/^DOMAIN (\d+)$/m);
  assert.ok(domain, `no DOMAIN line in snforge output:\n${out}`);
  const cases = [...out.matchAll(/^VECTOR (\d+) (\d+) (\d+)$/gm)]
    .map((m) => [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])] as [bigint, bigint, bigint]);
  return { domain: BigInt(domain[1]), cases };
}

const cairo = cairoVectors();

test("the domain tag encodes to the same felt on both sides", () => {
  // The tag is what stops this being an ordinary two-element Poseidon hash that any unrelated
  // calldata could be presented as. If the encodings differ, every commitment differs.
  assert.equal(DOMAIN, cairo.domain);
  assert.equal(DOMAIN, shortString("hydra/authorship/v1"));
});

test("every Cairo vector reproduces exactly in TypeScript", () => {
  assert.ok(cairo.cases.length >= 10, `only ${cairo.cases.length} vectors — the Cairo emitted fewer than expected`);
  for (const [nullifier, contentHash, expected] of cairo.cases) {
    assert.equal(commit(nullifier, contentHash), expected,
      `commit(${nullifier}, ${contentHash}) disagrees with the Cairo`);
  }
});

test("the vectors actually cover the field boundary", () => {
  // A parity suite of small numbers passes even when the field arithmetic is wrong, which is
  // the case that matters: a reduction that misbehaves only near the prime.
  const largest = cairo.cases.map(([n, c]) => (n > c ? n : c)).reduce((a, b) => (a > b ? a : b));
  assert.ok(largest > P / 2n, "no vector exercises the upper half of the field");
  assert.ok(cairo.cases.some(([n, c]) => n === 0n && c === 0n), "no zero vector");
});

test("the commitment does not commute, on both sides", () => {
  // Asserted in the Cairo tests too. Repeated here because the property has to survive the
  // TypeScript's own argument handling, not just the hash's.
  const swapped = cairo.cases.filter(([n, c]) => n !== c);
  assert.ok(swapped.length > 0);
  for (const [n, c] of swapped) assert.notEqual(commit(n, c), commit(c, n));
});

test("a value outside the field is refused rather than silently reduced", () => {
  // Reducing mod P here would make the TypeScript accept inputs the Cairo would reject, and
  // the disagreement would surface as an unopenable commitment much later.
  assert.throws(() => commit(P, 0n), /field/i);
  assert.throws(() => commit(0n, P), /field/i);
  assert.throws(() => commit(-1n, 0n), /field/i);
  assert.doesNotThrow(() => commit(P - 1n, P - 1n));
});

test("content hashes land in the field and separate from the blob id", () => {
  const seen = new Set<bigint>();
  for (let i = 0; i < 256; i++) {
    const h = contentHashFor(new Uint8Array(48).fill(i));
    assert.ok(h >= 0n && h < P, "content hash is not a field element");
    seen.add(h);
  }
  assert.equal(seen.size, 256);
  // Domain-separated from the blob id: a commitment equal to a published id would say which
  // document it commits to.
  const bytes = new TextEncoder().encode("the same document");
  const digest = BigInt(
    "0x" + createHash("sha256").update(bytes).digest().subarray(0, 31).toString("hex"),
  );
  assert.notEqual(contentHashFor(bytes), digest);
});
