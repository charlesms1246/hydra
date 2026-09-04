/**
 * The simulated world, over the wire.
 *
 * A FIXTURE AGREES WITH REALITY, NOT WITH THE CODE UNDER TEST. That is the rule, and
 * both bugs found on 2026-09-04 existed because this file broke it: each route was
 * written to match what the caller sent, so it tracked the implementation and was
 * green forever without ever being evidence. When core/ was fixed, this file became
 * wrong — and the correction was toward devnet, not back toward the new code.
 *
 * One HTTP server plays three roles the real stack splits across processes: devnet's
 * JSON-RPC, the discovery service's /health, and `hydra-dev up`'s control API. It exists so
 * the TUI can reach the world through the real @hydra/core — real probe.mjs timeouts,
 * real u256 balance parsing, real error shapes — rather than through a stubbed core that
 * could drift from what ships.
 *
 * WHAT THIS IS NOT: it is not evidence that any request it answers is a request devnet
 * would answer. Every route here was written to match what the code sends, so it agrees
 * with the code by construction and cannot discriminate against a wrong call. Two bugs
 * lived behind exactly that on 2026-09-04 — a `POST /mint` devnet has not served since
 * v0.8.0-rc.3, and a `starknet_getTransactionByHash` param arity real devnet rejects —
 * both green here the whole time. See ERRORS.md E-DEV11.
 *
 * So a passing sandbox test says the TUI renders a response correctly. It says nothing
 * about whether that response is one the real world produces. Only a live drive does.
 *
 * Audited against starknet-devnet v0.8.0-rc.3 on 2026-09-04, request by request. Findings,
 * in the three states worth distinguishing:
 *
 *   CONTRADICTS reality (bug)   POST /mint; getTransactionByHash [hash]. Both now fixed
 *                               in core/, and this file follows the fixed shapes.
 *   NARROWER than reality (ok)  starknet_call and getTransactionReceipt return a subset of
 *                               the real fields — verified to cover every field the code
 *                               reads. Narrowing is fine when it is checked and written down.
 *   NEVER COMPARED (the trap)   what both bugs were. Nothing is knowingly in this state now;
 *                               anything added here should be driven against the real
 *                               service before it is relied on.
 *
 * /health matches upstream handlers.rs:43-52 and config.rs:139, and is the one surface
 * corroborated twice — by reading upstream and by a live drive of the real service.
 * The control API's `publish` action is deliberately unimplemented: a coverage gap that
 * creates no false confidence, which is different from a wrong answer.
 */

import { createServer } from "node:http";

const u256 = (v) => ["0x" + (v & ((1n << 128n) - 1n)).toString(16), "0x" + (v >> 128n).toString(16)];
/** Mirrors packages/core/src/chain.mjs, so a drift there shows up here as a miss. */
const SELECTOR_NUM_OF_CHANNELS =
  "0x3dd96f9f4c6d6e8a31f13b4f6bddb32618aaea7439310de036bc5c244a43c3d";
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
        transactions: w.blockTxs.get(n) ?? [],
      };
    }
    case "starknet_call": {
      const { contract_address, calldata, entry_point_selector } = params?.[0] ?? {};
      // get_num_of_channels(recipient) -> u64. Modelled rather than stubbed to zero:
      // zero means "the next transfer opens a channel and discloses the recipient",
      // which is a disclosure claim, and answering it by accident is exactly the
      // kind of fiction this sandbox must not put on the screen.
      if (felt(entry_point_selector ?? "0x0") === felt(SELECTOR_NUM_OF_CHANNELS)) {
        const key = String(felt(calldata?.[0] ?? "0x0"));
        return ["0x" + (w.channels.get(key) ?? 0).toString(16)];
      }
      // balanceOf(account) -> u256. wallets.mjs parses this itself; that is the point.
      const acct = w.accounts.find((a) => felt(a.address) === felt(calldata?.[0] ?? "0x0"));
      const token = Object.values(w.tokens).find((t) => felt(t) === felt(contract_address ?? "0x0"));
      if (!acct || !token) return u256(0n);
      return u256(w.balances[acct.address]?.[token] ?? 0n);
    }
    case "starknet_getTransactionReceipt": {
      const rec = w.txs.get(params?.[0]);
      if (!rec) throw new Error("Transaction hash not found");
      return {
        type: rec.type ?? "INVOKE",
        finality_status: "ACCEPTED_ON_L2",
        execution_status: "SUCCEEDED",
        block_number: rec.blockNumber,
        actual_fee: { amount: "0x5af3107a4000", unit: "FRI" },
        events: [{}, {}],
        execution_resources: { l1_gas: 0, l1_data_gas: 224, l2_gas: 1310720 },
      };
    }
    // The sender lives here and nowhere else, which is why chain.mjs reads it.
    case "starknet_getTransactionByHash": {
      // Named params, matching core/src/chain.mjs — devnet rejects [hash] and a real
      // node rejects [hash, []]; only { transaction_hash } satisfies both.
      const rec = w.txs.get(params?.transaction_hash ?? params?.[0]);
      if (!rec) throw new Error("Transaction hash not found");
      return {
        transaction_hash: params[0],
        type: rec.type ?? "INVOKE",
        version: "0x3",
        sender_address: rec.sender,
        nonce: "0x" + rec.blockNumber.toString(16),
        calldata: ["0x1", "0x0", "0x0", "0x0"],
      };
    }
    // starknet-devnet v0.8.0-rc.3 serves minting as this RPC method, not POST /mint.
    // The /mint route below is kept only so an older caller gets a clear failure.
    case "devnet_mint": {
      const address = params?.address ?? params?.[0]?.address;
      const acct = w.accounts.find((a) => felt(a.address) === felt(address ?? "0x0"));
      if (!acct) throw new Error("Account not found");
      const tok = w.tokens.STRK;
      w.balances[acct.address][tok] += BigInt(params?.amount ?? params?.[0]?.amount ?? 0);
      w.note(`faucet -> ${acct.name}`);
      return { new_balance: String(w.balances[acct.address][tok]), unit: "FRI", tx_hash: w.hash() };
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
    // Base units, matching the real control API. This used to multiply by 10^18 on
    // the way in, which is the same units confusion the TUI had, pointed the other
    // way — so the sandbox agreed with the label and disagreed with the chain.
    w.notes[who] = [...(w.notes[who] ?? []), { token: tokenAddr, symbol: token, amount: String(amount) }];
    w.balances[w.accounts.find((a) => a.name === who).address][tokenAddr] -= BigInt(amount);
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
    // Opening the channel is what the pool does on the FIRST transfer into it.
    const toAddr = String(felt(w.accounts.find((a) => a.name === to)?.address ?? "0x0"));
    w.channels.set(toAddr, (w.channels.get(toAddr) ?? 0) + 1);
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

      // Real devnet v0.8.0-rc.3 has no REST /mint and answers 404. This fake used to
      // serve it — which is precisely why the 404 went unnoticed until a live drive.
      // Kept as a 404 so the fixture agrees with reality instead of contradicting it.
      if (url.pathname === "/mint") {
        return send(404, { error: "no such route: /mint — use the devnet_mint JSON-RPC method" });
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
