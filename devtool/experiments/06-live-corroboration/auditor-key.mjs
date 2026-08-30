/**
 * Phase A1 — corroborate findings/01 against the live mainnet deployment.
 *
 * findings/01 established from source that auditor escrow is mandatory and that the
 * auditor public key lives in contract storage, not user input. If that is true, the
 * mainnet pool exposes a non-zero auditor key via get_auditor_public_key().
 *
 * Read-only. Makes no transaction and spends nothing.
 */

import { RpcProvider, hash } from "starknet";

const POOLS = {
  mainnet: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
  sepolia: "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
};

const ENDPOINTS = {
  // Blast API was retired (returns -32000 "no longer available, use Alchemy").
  // These three answered starknet_chainId without a key on 2026-08-29.
  mainnet: [
    "https://api.cartridge.gg/x/starknet/mainnet",
    "https://starknet.drpc.org",
    "https://rpc.starknet.lava.build",
  ],
  sepolia: [
    "https://api.cartridge.gg/x/starknet/sepolia",
    "https://starknet-sepolia.drpc.org",
    "https://rpc.starknet-testnet.lava.build",
  ],
};

// Views worth reading while we are here. All read-only.
const VIEWS = [
  "get_auditor_public_key",
  "get_screener_public_key",
  "get_fee_amount",
  "get_fee_collector",
  "get_proof_validity_blocks",
];

async function firstWorking(urls) {
  for (const url of urls) {
    try {
      const p = new RpcProvider({ nodeUrl: url });
      const chainId = await p.getChainId();
      return { provider: p, url, chainId };
    } catch (e) {
      console.log(`    (${url} unavailable: ${String(e.message).slice(0, 60)})`);
    }
  }
  return null;
}

for (const [network, pool] of Object.entries(POOLS)) {
  console.log(`\n=== ${network} — pool ${pool} ===`);
  const conn = await firstWorking(ENDPOINTS[network]);
  if (!conn) {
    console.log("  NO WORKING RPC ENDPOINT — cannot corroborate on this network.");
    continue;
  }
  console.log(`  rpc: ${conn.url}`);
  console.log(`  chainId: ${conn.chainId}`);

  const cls = await conn.provider
    .getClassHashAt(pool)
    .catch((e) => `ERROR: ${String(e.message).slice(0, 80)}`);
  console.log(`  class hash: ${cls}`);

  for (const view of VIEWS) {
    try {
      const res = await conn.provider.callContract({
        contractAddress: pool,
        entrypoint: view,
        calldata: [],
      });
      const vals = (Array.isArray(res) ? res : res.result ?? []).map(String);
      console.log(`  ${view.padEnd(26)} -> ${vals.join(", ")}`);
    } catch (e) {
      console.log(`  ${view.padEnd(26)} -> ERROR ${String(e.message).slice(0, 70)}`);
    }
  }
  console.log(`  selector(get_auditor_public_key) = ${hash.getSelectorFromName("get_auditor_public_key")}`);
}
