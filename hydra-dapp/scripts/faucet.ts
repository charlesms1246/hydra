/**
 * Fund a Sepolia address from the Starknet public faucet.
 *
 * The flow is documented in `claude-docs/faucet.md`: ask for a challenge, solve a
 * proof-of-work locally, submit, poll. No auth — the work is the rate limit.
 *
 * The one place this is easy to get wrong is the difficulty, which is in BITS and is not
 * usually a whole number of hex digits. Counting leading zero nibbles instead would demand
 * roughly four times the work at difficulty 21 and never terminate at difficulty 25, so the
 * check is bit-level.
 *
 *     node scripts/faucet.ts 0x02afa2039a4173a1c327f6bb87d49bac815c5c50dfd9afa57f24609c2426c157
 */

import { createHash } from "node:crypto";

const BASE = "https://api.faucet.starknet.io";
/**
 * Required in the body of BOTH calls, and `claude-docs/faucet.md` did not say so.
 *
 * Without it the challenge is created under one network and looked up under another, and the
 * request fails with `POW_CHALLENGE_INVALID` — "does not match this address or network" — which
 * reads like a proof-of-work bug and sends you to re-check the hashing. It is not: a bogus
 * challenge id produces the identical error, so the lookup never finds the challenge at all.
 */
const NETWORK = "sepolia";

const address = process.argv[2];
if (!/^0x[0-9a-fA-F]{1,64}$/.test(address ?? "")) {
  throw new Error("usage: node scripts/faucet.ts <0x-address>");
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Leading zero BITS, not nibbles. See the header. */
function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

console.log(`challenge for ${address}`);
const { data: challenge } = await post("/api/public-agent/pow/challenge", { userAddress: address, network: NETWORK });
const { challengeId, powInputPrefix, difficulty } = challenge as
  { challengeId: string; powInputPrefix: string; difficulty: number };
console.log(`  difficulty ${difficulty} bits`);

let nonce = 0;
const started = Date.now();
for (;;) {
  const digest = createHash("sha256").update(`${powInputPrefix}${nonce}`).digest();
  if (leadingZeroBits(digest) >= difficulty) break;
  nonce++;
}
console.log(`  solved: nonce ${nonce} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const { data: request } = await post("/api/public-agent/faucet/request", {
  userAddress: address, challengeId, nonce: String(nonce), network: NETWORK,
});
const { requestId } = request as { requestId: string; pollAfterSeconds?: number };
let wait = (request as { pollAfterSeconds?: number }).pollAfterSeconds ?? 5;

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, wait * 1000));
  const res = await fetch(`${BASE}/api/public-agent/faucet/status/${requestId}`);
  const { data } = await res.json() as
    { data: { jobStatus: string; txHash?: string; pollAfterSeconds?: number } };
  console.log(`  ${data.jobStatus}${data.txHash ? ` ${data.txHash}` : ""}`);
  if (data.jobStatus === "confirmed") process.exit(0);
  if (data.jobStatus === "failed") throw new Error("the faucet reported the job failed");
  wait = data.pollAfterSeconds ?? wait;
}
throw new Error("the faucet did not confirm within the polling window");
