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

/**
 * One transaction, as fully as the node will describe it.
 *
 * TWO calls, not one. The receipt carries the outcome — finality, execution, fee,
 * an event COUNT — and nothing about who sent it; the sender lives on the
 * transaction object, which nothing here used to ask for. So the Activity page
 * had no `from` column for a reason that was true of the code and not of the
 * chain.
 *
 * What is still absent is absent from the RPC, not from this function: there is no
 * `to` on a Starknet invoke (the calls are encoded in `calldata`), no transferred
 * value without decoding them, and the receipt's `events` are counted rather than
 * returned. Those stay unreported rather than guessed at.
 */
export async function txStatus(hash) {
  const st = await readState();
  if (!st) return { available: false, reason: "no running stack — run `hydra up`" };
  const r = await rpc(st.devnetUrl, "starknet_getTransactionReceipt", [hash]);
  if (!r.ok) return { available: true, found: false, error: r.error };
  const rc = r.result;
  // Best-effort: a receipt with no matching transaction is not a failure worth
  // discarding the receipt over, so this fills what it can and leaves nulls.
  const t = await rpc(st.devnetUrl, "starknet_getTransactionByHash", [hash]);
  const tx = t.ok ? t.result : null;
  const res = rc.execution_resources ?? null;
  return {
    available: true,
    found: true,
    hash,
    finality: rc.finality_status ?? null,
    execution: rc.execution_status ?? null,
    blockNumber: rc.block_number ?? null,
    actualFee: rc.actual_fee ?? null,
    events: (rc.events ?? []).length,
    messages: (rc.messages_sent ?? []).length,
    revertReason: rc.revert_reason ?? null,
    type: rc.type ?? tx?.type ?? null,
    version: tx?.version ?? null,
    sender: tx?.sender_address ?? tx?.contract_address ?? null,
    nonce: tx?.nonce ?? null,
    // The length of the encoded call array, NOT a decoded call list. An invoke's
    // calldata is [n, (to, selector, len, ...args) * n] and decoding it to name a
    // `to` is a guess this does not make.
    calldata: Array.isArray(tx?.calldata) ? tx.calldata.length : null,
    gas: res ? { l1: res.l1_gas ?? null, l1Data: res.l1_data_gas ?? null, l2: res.l2_gas ?? null } : null,
  };
}

/**
 * starknet_keccak("get_num_of_channels"), the pool's public channel-count view
 * (`upstream: packages/privacy/src/interface.cairo:623`, impl at `privacy.cairo:1078`).
 *
 * Hardcoded the same way SELECTOR_BALANCE_OF is, because computing a selector needs
 * keccak and this package has no dependencies. Derived with starknet.js
 * `hash.getSelectorFromName`, which reproduces the balanceOf selector already in
 * wallets.mjs — that agreement is the check that the derivation is right, and a test
 * pins this value.
 */
export const SELECTOR_NUM_OF_CHANNELS =
  "0x3dd96f9f4c6d6e8a31f13b4f6bddb32618aaea7439310de036bc5c244a43c3d";

/**
 * How many channels have been opened to `recipient`.
 *
 * This is the one fact that decides whether a transfer discloses its recipient:
 * OpenChannel appends to `recipient_channels[recipient_addr]`, keyed by the
 * PLAINTEXT address, and only on the first transfer into that channel. So a count
 * of zero means the next transfer opens one and the recipient becomes public.
 *
 * Returns `known: false` rather than a number when it cannot tell. A caller that
 * turns "I could not ask" into "no channel" would be manufacturing the reassuring
 * branch, which is exactly what packages/leak/src/leak.mjs:139-147 refuses to do.
 */
export async function channelsTo(recipient) {
  const st = await readState();
  if (!st?.poolAddress) return { known: false, reason: "no running stack" };
  if (!recipient) return { known: false, reason: "no recipient" };
  const r = await rpc(st.devnetUrl, "starknet_call", [
    {
      contract_address: st.poolAddress,
      entry_point_selector: SELECTOR_NUM_OF_CHANNELS,
      calldata: [String(recipient)],
    },
    "latest",
  ]);
  if (!r.ok || !Array.isArray(r.result) || !r.result.length) {
    return { known: false, reason: r.error ?? "call returned nothing" };
  }
  try {
    return { known: true, count: Number(BigInt(r.result[0])) };
  } catch {
    return { known: false, reason: "unparseable u64" };
  }
}

/**
 * Does a transfer to `recipient` open a channel?
 *
 * `undefined` when unknown, which is the value packages/leak reads as UNKNOWN.
 */
export async function opensChannelTo(recipient) {
  const r = await channelsTo(recipient);
  return r.known ? r.count === 0 : undefined;
}
