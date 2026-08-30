/**
 * Test wallets and the devnet faucet.
 *
 * Balances are read straight over RPC rather than via starknet.js, so this module
 * stays dependency-free and usable from a status poll that must not block.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rpc, fetchJson } from "./probe.mjs";
import { readState, writeState, HYDRA_HOME } from "./state.mjs";

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

/**
 * Track another ERC20 alongside STRK and ETH.
 *
 * Tokens live in the recorded stack state, so every reader — `hydra wallets`, the
 * TUI, an agent — picks the new one up without being told. Validated by actually
 * calling `balanceOf` on it: an address that does not answer is a typo, and
 * storing it would put a permanent "—" in the table with no explanation.
 */
export async function addToken({ symbol, address }) {
  const st = await readState();
  if (!st) return { ok: false, error: "no running stack — run `hydra up`" };
  const sym = String(symbol ?? "").trim().toUpperCase();
  const addr = String(address ?? "").trim();
  if (!/^[A-Z0-9]{1,10}$/.test(sym)) return { ok: false, error: "symbol must be 1-10 letters or digits" };
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(addr)) return { ok: false, error: "address must be 0x-prefixed hex" };
  if (st.tokens?.[sym]) return { ok: false, error: `${sym} is already tracked` };

  const probe = await balanceOf(st.devnetUrl, addr, st.accounts?.[0]?.address ?? "0x0");
  if (probe === null) return { ok: false, error: "no balanceOf at that address on this chain" };

  const tokens = { ...(st.tokens ?? {}), [sym]: addr };
  await writeState({ ...st, tokens });
  return { ok: true, symbol: sym, address: addr, tokens };
}

/** Forget a tracked token. STRK and ETH are the pool's own and are not removable. */
export async function removeToken(symbol) {
  const st = await readState();
  if (!st) return { ok: false, error: "no running stack" };
  const sym = String(symbol ?? "").toUpperCase();
  if (sym === "STRK" || sym === "ETH") return { ok: false, error: `${sym} is the pool's own token` };
  if (!st.tokens?.[sym]) return { ok: false, error: `${sym} is not tracked` };
  const tokens = { ...st.tokens };
  delete tokens[sym];
  await writeState({ ...st, tokens });
  return { ok: true, symbol: sym, tokens };
}

/**
 * Write the wallet set to disk as JSON.
 *
 * Addresses, balances and tracked tokens — and NOT private keys, which this
 * process never holds: `hydra up` records only what `status()` needs, and devnet's
 * predeployed keys are derived from its seed rather than stored here. The file
 * says so, because an export called "wallets" that silently omits keys would
 * otherwise read as a complete backup.
 */
export async function exportWallets(dest) {
  const st = await readState();
  if (!st) return { ok: false, error: "no running stack — run `hydra up`" };
  const w = await wallets();
  if (!w.available) return { ok: false, error: w.reason };
  const path = dest ?? join(HYDRA_HOME, `wallets-${st.startedAt?.slice(0, 10) ?? "export"}.json`);
  const payload = {
    note: "addresses and balances only — no private keys. devnet keys derive from its seed (42).",
    exportedAt: new Date().toISOString(),
    devnetUrl: st.devnetUrl,
    poolAddress: st.poolAddress,
    tokens: w.tokens,
    accounts: w.wallets,
  };
  try {
    await writeFile(path, JSON.stringify(payload, null, 2));
    return { ok: true, path, accounts: w.wallets.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
