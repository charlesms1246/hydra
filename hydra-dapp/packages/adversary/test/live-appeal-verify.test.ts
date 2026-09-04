/**
 * An appeal signature checked against a REAL account on a REAL chain.
 *
 * `operator/src/verify.ts` is the one path in the moderation pipeline whose failure mode is
 * "the operator acts for somebody who could not sign", and it was the one thing `npm test` could
 * not know: everything below the network boundary is covered, and whether a deployed account
 * replies as `verifyReply` expects is only answerable by asking one.
 *
 *     HYDRA_RPC=https://api.cartridge.gg/x/starknet/sepolia npm run test:live
 *
 * READ-ONLY. One `starknet_call`, no transaction, no funds, nothing written to the chain. The
 * private key never leaves this process and is never printed.
 *
 * THE CHAIN IS THE ORACLE, which is what makes the Stark curve constructed below safe to write by
 * hand. If any parameter here were wrong the signature would simply not verify and this test would
 * fail — there is no way for a wrong implementation to produce a false ACCEPT, because that would
 * require forging a signature the account recognises. So the risk of hand-rolling is a red suite,
 * not a silent pass, and that is the right direction for the one check that fails closed.
 *
 * It drives `verifierAgainst` itself rather than a reimplementation. A live test that rebuilds the
 * request it is meant to be checking proves the rebuild works.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";

import { appealDigest } from "../../moderation/src/appeals.ts";
import { verifierAgainst, verifyRequest, verifyReply } from "../../operator/src/verify.ts";

const RPC = process.env.HYDRA_RPC;
const ACCOUNTS = process.env.HYDRA_ACCOUNTS ?? join(homedir(), ".hydra", "sepolia-accounts.json");
const ACCOUNT = process.env.HYDRA_ACCOUNT ?? "hydra";
const NETWORK = process.env.HYDRA_NETWORK_KEY ?? "alpha-sepolia";

/**
 * The STARK curve, and ECDSA over it, in plain BigInt.
 *
 * WRITTEN OUT RATHER THAN DEPENDED ON, for two reasons. `@noble/curves` carries no Stark curve in
 * the version vendored here, and it sits in a sibling package's `node_modules` where nothing in
 * this one resolves it — so using it would mean either a new dependency or reaching across a
 * package boundary, in a repo whose whole client is two dependencies.
 *
 * The parameters are public and every one of them is checked by the chain rather than by me. A
 * wrong constant produces a signature the account refuses, so the failure mode of hand-rolling
 * this is a red suite — never a false accept, which would require forging a signature the account
 * recognises. That asymmetry is what makes it safe to write here.
 *
 * The message is NOT hashed. An account's `is_valid_signature` takes a felt, and hashing it again
 * would sign something nobody asked about.
 */
const P = 2n ** 251n + 17n * 2n ** 192n + 1n;
const N = 0x800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const A = 1n;
const G: Point = [
  0x1ef15c18599971b7beced415a40f0c7deacfd9b0d1819e03d723d8bc943cfcan,
  0x5668060aa49730b7be4801df46ec62de53ecd11abe43a32873000c36e8dc1fn,
];

type Point = [bigint, bigint];

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;

/** Extended Euclid. Throws rather than returning a wrong answer if there is no inverse. */
function inv(a: bigint, m: bigint): bigint {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error("no modular inverse — a curve constant is wrong");
  return mod(old_s, m);
}

function add(p: Point | null, q: Point | null): Point | null {
  if (p === null) return q;
  if (q === null) return p;
  const [x1, y1] = p;
  const [x2, y2] = q;
  if (x1 === x2 && mod(y1 + y2, P) === 0n) return null;
  const lam = x1 === x2 && y1 === y2
    ? mod((3n * x1 * x1 + A) * inv(2n * y1, P), P)
    : mod((y2 - y1) * inv(x2 - x1, P), P);
  const x3 = mod(lam * lam - x1 - x2, P);
  return [x3, mod(lam * (x1 - x3) - y1, P)];
}

function mul(k: bigint, p: Point): Point {
  let acc: Point | null = null;
  let base: Point | null = p;
  for (let n = mod(k, N); n > 0n; n >>= 1n) {
    if (n & 1n) acc = add(acc, base);
    base = add(base, base);
  }
  if (acc === null) throw new Error("scalar multiplication reached infinity");
  return acc;
}

const felt = (n: bigint) => `0x${n.toString(16)}`;
const be32 = (n: bigint) => {
  const b = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
};

let address = "";
let secret = new Uint8Array();
let priv = 0n;

before(() => {
  assert.ok(RPC, "HYDRA_RPC is required — see the header");
  const all = JSON.parse(readFileSync(ACCOUNTS, "utf8")) as
    Record<string, Record<string, { address: string; private_key: string; deployed?: boolean }>>;
  const account = all[NETWORK]?.[ACCOUNT];
  // A missing account FAILS rather than skips, for the reason every live test here fails: a
  // check that goes green because it could not run is how a guarantee stops being one.
  assert.ok(account, `no account "${ACCOUNT}" under "${NETWORK}" in ${ACCOUNTS}`);
  assert.ok(account.deployed, "the account is not deployed, so it has no is_valid_signature");
  address = account.address;
  priv = BigInt(account.private_key);
  secret = be32(priv);
});

/**
 * Sign a felt with the account's key. Returns the two felts an account expects.
 *
 * `k` is derived deterministically from the key and the message, so a run is reproducible and no
 * two messages share one — a repeated `k` across two signatures discloses the private key, which
 * is the classic way a signing routine leaks everything at once. `r` must also be a valid felt,
 * so a candidate that lands above the field is rejected and the counter moves on.
 */
function sign(hash: bigint): string[] {
  for (let attempt = 0n; attempt < 64n; attempt++) {
    const k = mod(BigInt(`0x${createHash("sha256")
      .update(secret).update(be32(hash)).update(be32(attempt)).digest("hex")}`), N);
    if (k === 0n) continue;
    const [x] = mul(k, G);
    const r = mod(x, N);
    if (r === 0n || r >= P) continue;
    const s = mod(inv(k, N) * (hash + r * priv), N);
    if (s === 0n) continue;
    return [felt(r), felt(s)];
  }
  throw new Error("no signature found in 64 attempts, which cannot happen by chance");
}

test("A REAL ACCOUNT ACCEPTS A REAL APPEAL SIGNATURE", async () => {
  // The exact digest the operator would verify, over a decision id shaped like a real one.
  const decisionId = "9f2c1ab77e4d0356bb18c4a0e7d9f31c";
  const digest = appealDigest(decisionId);
  const hash = BigInt(`0x${digest}`);
  assert.ok(hash < P, "the appeal digest is not a felt, so no account could ever sign it");

  const signature = sign(hash);
  // The SHIPPED verifier, against the real chain. If the calldata encoding is wrong — the felt
  // array's length prefix in particular — this is where it shows, because the call errors rather
  // than returning a value.
  const ok = await verifierAgainst(RPC!)(address, digest, signature);
  assert.equal(ok, true,
    `a genuine signature from ${address} over its own appeal digest was not accepted. `
    + `Request: ${JSON.stringify(verifyRequest(address, digest, signature))}`);
});

test("AND REFUSES A CORRUPTED ONE, so fail-closed is a property something has seen close", async () => {
  // Fail-closed is only a property if something has watched it close. Every other case in
  // `verify.ts` is checked against a stub reply; this one is checked against an account that
  // actually says no.
  const digest = appealDigest("9f2c1ab77e4d0356bb18c4a0e7d9f31c");
  const good = sign(BigInt(`0x${digest}`));

  // r altered, s altered, and the pair swapped — three ways to be wrong that a lenient
  // implementation might wave through.
  const corruptions: [string, string[]][] = [
    ["r flipped", [felt(BigInt(good[0]) ^ 1n), good[1]]],
    ["s flipped", [good[0], felt(BigInt(good[1]) ^ 1n)]],
    ["r and s swapped", [good[1], good[0]]],
  ];
  for (const [what, signature] of corruptions) {
    const ok = await verifierAgainst(RPC!)(address, digest, signature).catch(() => false);
    assert.equal(ok, false, `the account accepted a signature with ${what}`);
  }

  // And a valid signature over a DIFFERENT decision is refused, which is the binding doing its
  // job against a real verifier rather than against an assertion about the digest.
  const other = appealDigest("a different decision entirely");
  const forOther = sign(BigInt(`0x${other}`));
  assert.equal(await verifierAgainst(RPC!)(address, digest, forOther).catch(() => false), false,
    "a signature over another decision was accepted against this one");
});

test("an unreachable endpoint is a refusal, not an acceptance", async () => {
  // The operator's message says a network failure and a bad signature are indistinguishable here,
  // and this is the half of that claim a hermetic test cannot make: a real fetch that fails.
  const unreachable = verifierAgainst("http://127.0.0.1:1");
  await assert.rejects(() => unreachable(address, appealDigest("x"), ["0x1", "0x2"]),
    "an unreachable endpoint neither refused nor threw — it must not return true");
  // And a reply that is not the shape we know is a refusal rather than a guess.
  assert.equal(verifyReply({ result: ["0xdeadbeef"] }), false);
});
