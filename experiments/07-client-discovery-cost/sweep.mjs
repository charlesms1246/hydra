/**
 * Phase B1 — how does client-side discovery cost scale with history depth?
 *
 * ContractDiscoveryProvider is the only discovery path that does not send the user's
 * private viewing key to a third party (findings/02). This measures whether it is
 * affordable, by wrapping the pool in upstream's own profiler and counting calls.
 *
 * Two numbers matter and they answer different questions:
 *   totalCalls  — bandwidth and rate-limit cost against an RPC provider.
 *   rounds      — sequential dependency depth. Wall-clock latency is roughly
 *                 rounds x RTT, NOT totalCalls x RTT, because discovery fans out.
 *
 * Everything runs in memory. No chain, no Cairo toolchain, no proving service.
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
// Not reachable from any public subpath — see findings/07 "Import surface".
import { derivePublicKey } from "../../../.upstream/sdk/dist/utils/crypto.js";

/** Simulated per-call RPC latency. rounds = elapsedMs / DELAY_MS. */
const DELAY_MS = 20;

let poolSeq = 1n;

/**
 * Builds a pool with `senders x tokens x notes` notes addressed to Alice,
 * then profiles a full discoverNotes() over it.
 */
async function measure({ senders, tokens: nTokens, notes, spentFraction = 0 }) {
  const mocknet = new Mocknet({ poolAddress: poolSeq++, validateBalances: false });
  const env = mocknet.initialize();
  const pool = mocknet.pool;

  const alice = env.alice.address;
  const aliceKey = env.alice.privateKey;
  const alicePub = derivePublicKey(aliceKey);

  pool.setupChannel(alice, aliceKey, alice, 0, new Channel(alicePub));

  const tokens = Array.from({ length: nTokens }, (_, i) => BigInt(0xace000 + i));
  let spent = 0;

  for (let s = 0; s < senders; s++) {
    const sender = { address: BigInt(0x2000 + s), key: BigInt(300000 + s) };
    pool.setupChannel(
      sender.address, sender.key, sender.address, 0,
      new Channel(derivePublicKey(sender.key))
    );

    const channelKey = compute_channel_key(sender.address, sender.key, alice, BigInt(alicePub));
    const channel = new Channel(alicePub);
    channel.key = channelKey;
    for (let t = 0; t < nTokens; t++) {
      channel.tokens.set(tokens[t], { tokenIndex: t, noteNonce: notes });
    }
    pool.setupChannel(sender.address, sender.key, alice, 0, channel);

    for (let t = 0; t < nTokens; t++) {
      for (let n = 0; n < notes; n++) {
        pool.setupNote(
          alice,
          {
            id: compute_note_id(channelKey, tokens[t], n),
            amount: BigInt(100 + n),
            created: 0,
            witness: { channelKey, nonce: n, r: BigInt(6000 + t * 1000 + n) },
            sender: sender.address,
          },
          tokens[t]
        );
        // Spend a deterministic fraction — spent notes still cost traversal.
        if (spentFraction > 0 && n % Math.round(1 / spentFraction) === 0) {
          pool.nullifiers.add(compute_nullifier(channelKey, tokens[t], n, aliceKey));
          spent++;
        }
      }
    }
  }

  const profiler = createConcurrencyProfiler(pool, DELAY_MS);
  const discovery = new ContractDiscoveryProvider(profiler.pool);

  const found = await discovery.discoverNotes(alice, aliceKey);
  const report = profiler.getReport();

  let discovered = 0;
  for (const [, arr] of found.notes) discovered += arr.length;

  return {
    senders, tokens: nTokens, notes,
    notesCreated: senders * nTokens * notes,
    spent,
    discovered,
    totalCalls: report.totalCalls,
    rounds: Math.max(1, Math.round(report.elapsedMs / DELAY_MS)),
    maxConcurrent: report.maxConcurrent,
    duplicates: report.duplicates.length,
    elapsedMs: report.elapsedMs,
  };
}

function table(title, rows) {
  console.log(`\n## ${title}\n`);
  console.log(
    "senders tokens notes | created spent found | calls rounds maxConc dups | calls/note"
  );
  console.log("-".repeat(92));
  for (const r of rows) {
    const perNote = r.notesCreated > 0 ? (r.totalCalls / r.notesCreated).toFixed(2) : "-";
    console.log(
      `${String(r.senders).padStart(7)} ${String(r.tokens).padStart(6)} ${String(r.notes).padStart(5)} |` +
      ` ${String(r.notesCreated).padStart(7)} ${String(r.spent).padStart(5)} ${String(r.discovered).padStart(5)} |` +
      ` ${String(r.totalCalls).padStart(5)} ${String(r.rounds).padStart(6)} ${String(r.maxConcurrent).padStart(7)} ${String(r.duplicates).padStart(4)} |` +
      ` ${perNote.padStart(10)}`
    );
  }
}

const all = {};

// Sweep 1 — note depth within one subchannel. Isolates note-index walking.
all.notes = [];
for (const n of [0, 1, 2, 4, 8, 16, 32, 64, 128, 256]) {
  all.notes.push(await measure({ senders: 1, tokens: 1, notes: n }));
}
table("Sweep 1 — notes per subchannel (1 sender, 1 token)", all.notes);

// Sweep 2 — channel count. Isolates channel walking.
all.senders = [];
for (const s of [1, 2, 4, 8, 16, 32]) {
  all.senders.push(await measure({ senders: s, tokens: 1, notes: 8 }));
}
table("Sweep 2 — senders/channels (1 token, 8 notes each)", all.senders);

// Sweep 3 — token count. Isolates subchannel walking.
all.tokens = [];
for (const t of [1, 2, 4, 8, 16]) {
  all.tokens.push(await measure({ senders: 1, tokens: t, notes: 8 }));
}
table("Sweep 3 — tokens/subchannels (1 sender, 8 notes each)", all.tokens);

// Sweep 4 — combined, toward realistic and upstream's own 1,920-note figure.
all.realistic = [];
for (const cfg of [
  { senders: 2, tokens: 2, notes: 8 },
  { senders: 5, tokens: 2, notes: 16, spentFraction: 0.5 },
  { senders: 12, tokens: 10, notes: 16, spentFraction: 0.5 },
]) {
  all.realistic.push(await measure(cfg));
}
table("Sweep 4 — combined (spent notes included)", all.realistic);

console.log(`\nDELAY_MS=${DELAY_MS}. rounds = elapsedMs/DELAY_MS ~ sequential RPC depth.`);
console.log("Wall clock ~ rounds x RTT, not totalCalls x RTT.\n");

await import("node:fs").then((fs) =>
  fs.writeFileSync("results.json", JSON.stringify(all, null, 2))
);
console.log("wrote results.json");
