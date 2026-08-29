/**
 * Test wallets and the devnet faucet.
 *
 * Balances are read straight over RPC rather than via starknet.js, so this module
 * stays dependency-free and usable from a status poll that must not block.
 */

import { rpc, fetchJson } from "./probe.mjs";
import { readState } from "./state.mjs";

/** ERC20 balanceOf, as a plain RPC call. Returns a decimal string, or null. */
export async function balanceOf(rpcUrl, token, account) {
  const r = await rpc(rpcUrl, "starknet_call", [
    { contract_address: token, entry_point_selector: SELECTOR_BALANCE_OF, calldata: [account] },
    "latest",
  ]);
  if (!r.ok || !Array.isArray(r.result)) return null;
  // u256 { low, high }
  const [low = "0x0", high = "0x0"] = r.result;
  return (BigInt(low) + (BigInt(high) << 128n)).toString();
}

// starknet_keccak("balanceOf")
const SELECTOR_BALANCE_OF = "0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e";

export function formatUnits(raw, decimals = 18, places = 4) {
  if (raw === null) return null;
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = ((v % base) * 10n ** BigInt(places)) / base;
  return `${whole}.${frac.toString().padStart(places, "0")}`;
}

export async function wallets() {
  const st = await readState();
  if (!st) return { available: false, reason: "no running stack — run `hydra up`" };
  const out = [];
  for (const a of st.accounts ?? []) {
    const row = { name: a.name, address: a.address, balances: {} };
    for (const [sym, token] of Object.entries(st.tokens ?? {})) {
      const raw = await balanceOf(st.devnetUrl, token, a.address);
      row.balances[sym] = { raw, formatted: formatUnits(raw) };
    }
    out.push(row);
  }
  return { available: true, wallets: out, tokens: st.tokens ?? {} };
}

/**
 * starknet-devnet's mint endpoint. Devnet only, by construction — there is no
 * faucet on mainnet and this must never look like there is.
 */
export async function faucet({ address, amount = 1e18, unit = "FRI" }) {
  const st = await readState();
  if (!st) return { ok: false, error: "no running stack — run `hydra up`" };
  const r = await fetchJson(`${st.devnetUrl}/mint`, {
    method: "POST",
    body: { address, amount: Number(amount), unit },
    timeoutMs: 10000,
  });
  if (!r.ok) return { ok: false, error: r.error ?? `http ${r.status}`, body: r.text?.slice(0, 200) };
  return { ok: true, ...r.json };
}
