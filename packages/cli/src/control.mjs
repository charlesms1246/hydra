/**
 * A local control API inside `hydra up`.
 *
 * Doing a private transfer needs the `Devnet` object — `executeOutside` advances
 * the chain past the 10-block proof buffer and submits an outside execution
 * signed by admin. That object lives in this process. Rather than reimplement
 * that plumbing in the TUI (a separate process), `up` exposes it on loopback and
 * the TUI stays a client.
 *
 * Bound to 127.0.0.1 with a random port, recorded in state.json. It holds devnet
 * account keys, so it must never listen on anything but loopback.
 */

import { createServer } from "node:http";
import { join } from "node:path";

const VIEWING_KEYS = { alice: "0xA11CE", bob: "0xB0B" };

export async function startControl({ devnet, env, upstream, indexerUrl }) {
  const { createPrivateTransfers } = await import(join(upstream, "sdk/dist/index.js"));
  const { ScreeningCallMockProofProvider, IndexerDiscoveryProvider } =
    await import(join(upstream, "sdk/dist/testing/index.js"));
  // SN_SEPOLIA. Hardcoded rather than importing starknet just for one constant —
  // the devnet the pool is deployed to hardcodes the same value
  // (sdk/src/testing/devnet.ts: chainId: "0x534e5f5345504f4c4941").
  const chainId = "0x534e5f5345504f4c4941";
  const poolAddress = env.privacy.address;

  const mk = (account, viewingKey) =>
    createPrivateTransfers({
      account,
      viewingKeyProvider: { getViewingKey: async () => BigInt(viewingKey) },
      // The pool screens deposits, so the mock prover must sign each attestation
      // with the screener key the pool was deployed with.
      provingProvider: new ScreeningCallMockProofProvider(env.node, chainId),
      discoveryProvider: new IndexerDiscoveryProvider(indexerUrl, poolAddress),
      poolContractAddress: poolAddress,
    });

  const transfers = { alice: mk(env.alice, VIEWING_KEYS.alice), bob: mk(env.bob, VIEWING_KEYS.bob) };
  const accounts = { alice: env.alice, bob: env.bob };
  const log = [];
  const note = (m) => { log.push({ at: new Date().toISOString(), m }); if (log.length > 200) log.shift(); };

  /**
   * Mine empty blocks.
   *
   * A note is not spendable until 10 blocks after the transaction that created
   * it. `executeOutside` advances the chain before *submitting*, but planning a
   * transfer — discovery and note selection — happens before that, so a freshly
   * shielded note looks unavailable and the build fails with
   * "Insufficient balance … (total available: N)". Advancing before planning is
   * what makes shield-then-transfer work as two separate steps.
   */
  async function advanceBlocks(n = 11) {
    for (let i = 0; i < n; i++) {
      await fetch(env.node.channel?.nodeUrl ?? devnet.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock" }),
      });
    }
  }

  /** Approve the pool to pull `amount` of `token` for `who`. Deposits pull, they are not pushed. */
  async function approve(who, token, amount) {
    const r = await accounts[who].execute({
      contractAddress: token,
      entrypoint: "approve",
      calldata: [poolAddress, BigInt(amount).toString(), "0"],
    });
    await env.node.waitForTransaction(r.transaction_hash);
    return r.transaction_hash;
  }

  const ACTIONS = {
    async register({ who = "bob" }) {
      note(`register ${who}`);
      const { callAndProof } = await transfers[who].build().register().execute();
      const receipt = await devnet.executeOutside(callAndProof);
      return { who, txHash: receipt.transaction_hash ?? null };
    },

    // `amount` is in BASE units, as the SDK's deposit()/transfer() take it. Callers
    // that mean whole tokens convert with core's toBaseUnits first.
    async shield({ who = "alice", amount = "100", token = "STRK" }) {
      const tokenAddr = token === "ETH" ? env.eth : env.strk;
      note(`shield ${amount} ${token} for ${who}`);
      const approveTx = await approve(who, tokenAddr, amount);
      const { callAndProof } = await transfers[who]
        .build({ autoRegister: true, autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } })
        .with(tokenAddr)
        .deposit({ amount: BigInt(amount) })
        .surplusTo(accounts[who].address)
        .execute();
      const receipt = await devnet.executeOutside(callAndProof);
      return { who, amount, token, approveTx, txHash: receipt.transaction_hash ?? null };
    },

    async advance({ blocks = 11 }) {
      await advanceBlocks(blocks);
      return { advanced: blocks };
    },

    async transfer({ from = "alice", to = "bob", amount = "50", token = "STRK" }) {
      const tokenAddr = token === "ETH" ? env.eth : env.strk;
      note(`transfer ${amount} ${token} ${from} → ${to}`);
      // Mature any note shielded moments ago; see advanceBlocks.
      await advanceBlocks();
      const { callAndProof } = await transfers[from]
        .build({
          autoRegister: true,
          autoSetup: true,
          autoDiscover: { notes: "refresh", channels: "refresh" },
          // Without this the planner never spends a discovered note: it reports
          // "need N more (total available: N)" while holding exactly that note.
          // Upstream's own e2e never trips it because its deposit funds the
          // transfer in the same transaction, so nothing has to be selected.
          autoSelectNotes: true,
        })
        .with(tokenAddr)
        .transfer({ recipient: accounts[to].address, amount: BigInt(amount) })
        // Spending a 100 note to send 50 leaves 50, and the compiler refuses to
        // guess where change goes: "Surplus of N found but no surplus action".
        // Notes cannot be partially spent, so any transfer not exactly equal to
        // a note needs this.
        .surplusTo(accounts[from].address)
        .execute();
      const receipt = await devnet.executeOutside(callAndProof);
      return { from, to, amount, token, txHash: receipt.transaction_hash ?? null };
    },

    async notes({ who = "alice" }) {
      const { notes } = await transfers[who].discoverNotes();
      const out = [];
      for (const [token, list] of notes) {
        for (const n of list) {
          out.push({
            token: "0x" + BigInt(token).toString(16),
            symbol: BigInt(token) === BigInt(env.strk) ? "STRK" : BigInt(token) === BigInt(env.eth) ? "ETH" : "?",
            amount: n.amount?.toString?.() ?? String(n.amount),
          });
        }
      }
      return { who, notes: out };
    },
  };

  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      const s = JSON.stringify(obj);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
      res.end(s);
    };
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/log") return send(200, { log });
      const name = url.pathname.replace(/^\//, "");
      const action = ACTIONS[name];
      if (!action) return send(404, { error: `no such action: ${name}`, actions: Object.keys(ACTIONS) });

      let body = {};
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      }
      const started = Date.now();
      const result = await action(body);
      send(200, { ok: true, ms: Date.now() - started, ...result });
    } catch (e) {
      note(`error: ${e.message}`);
      send(500, { ok: false, error: String(e.message).slice(0, 400) });
    }
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, server };
}
