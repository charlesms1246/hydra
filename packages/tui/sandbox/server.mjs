/**
 * The simulated world, over the wire.
 *
 * One HTTP server plays three roles the real stack splits across processes: devnet's
 * JSON-RPC, the discovery service's /health, and `hydra up`'s control API. It exists so
 * the TUI can reach the world through the real @hydra/core — real probe.mjs timeouts,
 * real u256 balance parsing, real error shapes — rather than through a stubbed core that
 * could drift from what ships.
 */

import { createServer } from "node:http";

const u256 = (v) => ["0x" + (v & ((1n << 128n) - 1n)).toString(16), "0x" + (v >> 128n).toString(16)];
const felt = (s) => BigInt(s);

function rpcResult(w, method, params) {
  switch (method) {
    case "starknet_chainId":
      return "0x534e5f5345504f4c4941";
    case "starknet_blockNumber":
      return w.blockNumber;
    case "starknet_getBlockWithTxHashes": {
      const n = params?.[0]?.block_number ?? w.blockNumber;
      if (n < 0 || n > w.blockNumber) throw new Error("Block not found");
      return {
        block_number: n,
        block_hash: "0x" + n.toString(16),
        // Only the head carries the backdating; older blocks stay ordered behind it.
        timestamp: Math.floor(Date.now() / 1000) - w.headAgeSecs - (w.blockNumber - n) * 12,
        transactions: Array.from({ length: n % 3 }, (_, i) => "0x" + (n * 10 + i).toString(16)),
      };
    }
    case "starknet_call": {
      // balanceOf(account) -> u256. wallets.mjs parses this itself; that is the point.
      const { contract_address, calldata } = params?.[0] ?? {};
      const acct = w.accounts.find((a) => felt(a.address) === felt(calldata?.[0] ?? "0x0"));
      const token = Object.values(w.tokens).find((t) => felt(t) === felt(contract_address ?? "0x0"));
      if (!acct || !token) return u256(0n);
      return u256(w.balances[acct.address]?.[token] ?? 0n);
    }
    case "starknet_getTransactionReceipt": {
      const rec = w.txs.get(params?.[0]);
      if (!rec) throw new Error("Transaction hash not found");
      return {
        finality_status: "ACCEPTED_ON_L2",
        execution_status: "SUCCEEDED",
        block_number: rec.blockNumber,
        actual_fee: { amount: "0x5af3107a4000", unit: "FRI" },
        events: [{}, {}],
      };
    }
    default:
      throw new Error(`unsupported method: ${method}`);
  }
}

const CONTROL = {
  async notes(w, { who = "alice" }) {
    return { who, notes: w.notes[who] ?? [] };
  },
  async shield(w, { who = "alice", amount = "100", token = "STRK" }) {
    if (!w.registered.has(who)) w.registered.add(who);
    const tokenAddr = w.tokens[token] ?? w.tokens.STRK;
    w.notes[who] = [...(w.notes[who] ?? []), { token: tokenAddr, symbol: token, amount: String(amount) }];
    w.balances[w.accounts.find((a) => a.name === who).address][tokenAddr] -= BigInt(amount) * 10n ** 18n;
    const txHash = w.hash();
    w.mineBlock(txHash);
    w.note(`shield ${amount} ${token} for ${who}`);
    return { who, amount, token, approveTx: w.hash(), txHash };
  },
  async register(w, { who = "bob" }) {
    w.registered.add(who);
    const txHash = w.hash();
    w.mineBlock(txHash);
    w.note(`register ${who}`);
    return { who, txHash };
  },
  async transfer(w, { from = "alice", to = "bob", amount = "50", token = "STRK" }) {
    // The real pool refuses this exact case, and the refusal is worth being able to see.
    if (!w.registered.has(to)) throw new Error(`Missing channel context for recipient ${to}`);
    const held = (w.notes[from] ?? []).reduce((n, x) => n + BigInt(x.amount), 0n);
    if (held < BigInt(amount)) throw new Error(`insufficient notes: have ${held}, need ${amount}`);
    w.notes[from] = [{ token: w.tokens[token], symbol: token, amount: String(held - BigInt(amount)) }];
    w.notes[to] = [...(w.notes[to] ?? []), { token: w.tokens[token], symbol: token, amount: String(amount) }];
    const txHash = w.hash();
    w.mineBlock(txHash);
    w.note(`transfer ${amount} ${token} ${from} -> ${to}`);
    return { from, to, amount, token, txHash };
  },
  async advance(w, { blocks = 11 }) {
    for (let i = 0; i < blocks; i++) w.mineBlock();
    return { advanced: blocks };
  },
};

export async function startServer(w) {
  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      const s = JSON.stringify(obj);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
      res.end(s);
    };
    const url = new URL(req.url, "http://127.0.0.1");
    const body = await new Promise((resolve) => {
      const c = [];
      req.on("data", (x) => c.push(x));
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || "{}")); } catch { resolve({}); } });
    });

    try {
      if (!w.running) { res.destroy(); return; }   // nothing listening is the honest empty state
      await w.tick();

      if (url.pathname === "/health") {
        // Upstream returns 503 whenever lag exceeds health_max_lag_secs (default 60):
        // crates/discovery-service/src/api/handlers.rs:43-52, config.rs:139.
        const lag = w.headAgeSecs;
        const healthy = lag <= 60;
        return send(healthy ? 200 : 503, {
          status: healthy ? "OK" : "UNHEALTHY",
          chain_head: { block_number: w.blockNumber, block_hash: "0x" + w.blockNumber.toString(16),
            timestamp: Math.floor(Date.now() / 1000) - lag },
          lag_secs: lag,
        });
      }

      if (url.pathname === "/mint") {
        const acct = w.accounts.find((a) => BigInt(a.address) === BigInt(body.address ?? "0x0"));
        if (acct) w.balances[acct.address][w.tokens.STRK] += BigInt(body.amount ?? 0);
        w.note(`faucet -> ${acct?.name ?? body.address}`);
        return send(200, { new_balance: String(w.balances[acct?.address]?.[w.tokens.STRK] ?? 0), unit: "FRI" });
      }

      if (url.pathname === "/log") return send(200, { log: w.log });

      const action = CONTROL[url.pathname.replace(/^\//, "")];
      if (action) {
        const started = Date.now();
        const result = await action(w, body);
        return send(200, { ok: true, ms: Date.now() - started, ...result });
      }

      // Anything else on this port is devnet's JSON-RPC.
      if (body.jsonrpc) {
        try {
          return send(200, { jsonrpc: "2.0", id: body.id, result: rpcResult(w, body.method, body.params) });
        } catch (e) {
          return send(200, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: e.message } });
        }
      }
      return send(404, { error: "no such route" });
    } catch (e) {
      return send(500, { ok: false, error: String(e.message).slice(0, 400) });
    }
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url };
}
