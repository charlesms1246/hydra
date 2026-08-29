/**
 * Liveness checks. Every probe answers within `timeoutMs` and never throws:
 * a status view must degrade to "down", not crash.
 */

const DEFAULT_TIMEOUT = 2000;

async function fetchJson(url, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ac.signal,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return { ok: false, error: String(e.name === "AbortError" ? "timeout" : e.message) };
  } finally {
    clearTimeout(t);
  }
}

export async function rpc(url, method, params = [], timeoutMs = DEFAULT_TIMEOUT) {
  const r = await fetchJson(url, {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method, params },
    timeoutMs,
  });
  if (!r.ok || !r.json) return { ok: false, error: r.error ?? `http ${r.status}` };
  if (r.json.error) return { ok: false, error: r.json.error.message ?? "rpc error" };
  return { ok: true, result: r.json.result };
}

export async function probeDevnet(url) {
  if (!url) return { up: false, reason: "no url" };
  const chain = await rpc(url, "starknet_chainId");
  if (!chain.ok) return { up: false, reason: chain.error };
  const bn = await rpc(url, "starknet_blockNumber");
  return {
    up: true,
    url,
    chainId: chain.result,
    blockNumber: bn.ok ? bn.result : null,
  };
}

export async function probeIndexer(url) {
  if (!url) return { up: false, reason: "no url" };
  const r = await fetchJson(`${url}/health`);
  if (!r.ok || !r.json) return { up: false, reason: r.error ?? `http ${r.status}` };
  return {
    up: r.json.status === "OK",
    url,
    status: r.json.status,
    blockNumber: r.json.chain_head?.block_number ?? null,
    lagSecs: r.json.lag_secs ?? null,
  };
}

export { fetchJson };
