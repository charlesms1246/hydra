/**
 * Phase B1b — the concurrency/latency tradeoff.
 *
 * sweep.mjs showed discovery fans out to ~715 concurrent calls at 1,920 notes.
 * No public RPC provider will accept that burst, so the practical question is what
 * throttling costs. ContractDiscoveryProvider takes { rateLimit: { concurrency } }
 * (default 8, sdk/src/utils/rate-limiter.ts).
 */

import {
  ContractDiscoveryProvider,
  Mocknet,
  createConcurrencyProfiler,
  compute_channel_key,
  compute_note_id,
  compute_nullifier,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import { Channel } from "@starkware-libs/starknet-privacy-sdk";
import { derivePublicKey } from "../../../.upstream/sdk/dist/utils/crypto.js";

const DELAY_MS = 20;
const SENDERS = 12, TOKENS = 10, NOTES = 16; // upstream's own 1,920-note figure

let poolSeq = 100n;

function build() {
  const mocknet = new Mocknet({ poolAddress: poolSeq++, validateBalances: false });
  const env = mocknet.initialize();
  const pool = mocknet.pool;
  const alice = env.alice.address, aliceKey = env.alice.privateKey;
  const alicePub = derivePublicKey(aliceKey);
  pool.setupChannel(alice, aliceKey, alice, 0, new Channel(alicePub));
  const tokens = Array.from({ length: TOKENS }, (_, i) => BigInt(0xace000 + i));

  for (let s = 0; s < SENDERS; s++) {
    const sender = { address: BigInt(0x2000 + s), key: BigInt(300000 + s) };
    pool.setupChannel(sender.address, sender.key, sender.address, 0,
      new Channel(derivePublicKey(sender.key)));
    const channelKey = compute_channel_key(sender.address, sender.key, alice, BigInt(alicePub));
    const channel = new Channel(alicePub);
    channel.key = channelKey;
    for (let t = 0; t < TOKENS; t++) channel.tokens.set(tokens[t], { tokenIndex: t, noteNonce: NOTES });
    pool.setupChannel(sender.address, sender.key, alice, 0, channel);
    for (let t = 0; t < TOKENS; t++) {
      for (let n = 0; n < NOTES; n++) {
        pool.setupNote(alice, {
          id: compute_note_id(channelKey, tokens[t], n),
          amount: BigInt(100 + n), created: 0,
          witness: { channelKey, nonce: n, r: BigInt(6000 + t * 1000 + n) },
          sender: sender.address,
        }, tokens[t]);
        if (n % 2 === 0) pool.nullifiers.add(compute_nullifier(channelKey, tokens[t], n, aliceKey));
      }
    }
  }
  return { pool, alice, aliceKey };
}

/**
 * `elapsed/DELAY` overstates sequential depth, because elapsed also contains pure
 * compute. Measure a DELAY=0 run per configuration and subtract it, so
 * rounds = (elapsed - compute) / DELAY. Without this the figure moves with DELAY
 * (it read 404 rounds at DELAY=5 and 111 at DELAY=20 for identical work).
 */
async function run(concurrency, delayMs) {
  const { pool, alice, aliceKey } = build();
  const profiler = createConcurrencyProfiler(pool, delayMs);
  const discovery = new ContractDiscoveryProvider(
    profiler.pool,
    concurrency === null ? undefined : { rateLimit: { concurrency } }
  );
  await discovery.discoverNotes(alice, aliceKey);
  return profiler.getReport();
}

console.log(`\n## Sweep 5 — throttling at ${SENDERS * TOKENS * NOTES} notes\n`);
console.log("concurrency | calls  compute  rounds maxConc | projected wall clock @50ms RTT");
console.log("-".repeat(78));

const results = [];
for (const c of [null, 128, 64, 32, 16, 8, 4]) {
  const baseline = await run(c, 0);            // compute only
  const r = await run(c, DELAY_MS);            // compute + simulated latency
  const rounds = Math.max(1, Math.round((r.elapsedMs - baseline.elapsedMs) / DELAY_MS));
  const projSec = ((rounds * 50) / 1000).toFixed(1);
  results.push({
    concurrency: c, totalCalls: r.totalCalls, computeMs: baseline.elapsedMs,
    rounds, maxConcurrent: r.maxConcurrent, projectedSecAt50msRtt: +projSec,
  });
  console.log(
    `${String(c ?? "none").padStart(11)} | ${String(r.totalCalls).padStart(5)} ${String(baseline.elapsedMs + "ms").padStart(8)} ${String(rounds).padStart(7)} ${String(r.maxConcurrent).padStart(7)} | ${projSec.padStart(6)}s`
  );
}
console.log("\nrounds = (elapsed - compute)/DELAY_MS ~ sequential RPC depth. Projection assumes 50ms RTT");
console.log("and ignores client compute, which is listed separately.\n");
await import("node:fs").then((fs) => fs.writeFileSync("results-ratelimit.json", JSON.stringify(results, null, 2)));
console.log("wrote results-ratelimit.json");
