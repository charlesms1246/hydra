/** Block and transaction views — what the TUI's activity pane renders. */

import { rpc } from "./probe.mjs";
import { readState } from "./state.mjs";

export async function latestBlocks(n = 8) {
  const st = await readState();
  if (!st) return { available: false, reason: "no running stack — run `hydra up`" };
  const head = await rpc(st.devnetUrl, "starknet_blockNumber");
  if (!head.ok) return { available: false, reason: head.error };
  const top = head.result;
  const blocks = [];
  for (let b = top; b > Math.max(-1, top - n); b--) {
    const r = await rpc(st.devnetUrl, "starknet_getBlockWithTxHashes", [{ block_number: b }]);
    if (!r.ok) continue;
    blocks.push({
      number: r.result.block_number,
      hash: r.result.block_hash,
      timestamp: r.result.timestamp,
      txCount: (r.result.transactions ?? []).length,
      txs: (r.result.transactions ?? []).slice(0, 12),
      status: r.result.status ?? r.result.finality_status ?? null,
    });
  }
  return { available: true, head: top, blocks };
}

export async function txStatus(hash) {
  const st = await readState();
  if (!st) return { available: false, reason: "no running stack — run `hydra up`" };
  const r = await rpc(st.devnetUrl, "starknet_getTransactionReceipt", [hash]);
  if (!r.ok) return { available: true, found: false, error: r.error };
  const rc = r.result;
  return {
    available: true,
    found: true,
    hash,
    finality: rc.finality_status ?? null,
    execution: rc.execution_status ?? null,
    blockNumber: rc.block_number ?? null,
    actualFee: rc.actual_fee ?? null,
    events: (rc.events ?? []).length,
    revertReason: rc.revert_reason ?? null,
  };
}
