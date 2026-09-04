/**
 * A local control API inside `hydra-dev up`.
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
  // `admin` is here as a recipient only — it has no viewing key and nothing registers it, so it
  // is a permanently unregistered address. `live-lifecycle.test.ts` needs one to assert what
  // happens when you send to somebody who has not set themselves up, and using `bob` made that
  // test depend on whether some other suite had registered him first — which it silently did.
  const accounts = { alice: env.alice, bob: env.bob, admin: env.admin };
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

  /**
   * One operation at a time per account.
   *
   * Two concurrent callers on the same account corrupt each other, and the failure does not
   * look like a race. `approve` SETS an allowance rather than adding to it, so a `shield` and a
   * `publish` running together each approve their own amount, the second overwrites the first,
   * and whichever deposit runs last fails with "Insufficient ERC20 allowance" — a message that
   * sends you looking at token balances. The SDK's build-then-execute is stateful per account
   * besides, so the pool-side discovery interleaves too and produces "did not compile the
   * actions".
   *
   * Found because two live suites ran in parallel and failed in ways neither failed alone. The
   * fix belongs here rather than in the tests: an API that cannot be called twice at once is a
   * bug wherever it is called from, and a client with two windows open would hit exactly this.
   */
  const queues = new Map();
  const perAccount = (who, fn) => {
    const previous = queues.get(who) ?? Promise.resolve();
    // Chained off the settled result, so one failure does not poison the queue behind it.
    const mine = previous.catch(() => {}).then(fn);
    queues.set(who, mine.catch(() => {}));
    return mine;
  };

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
      return perAccount(who, async () => {
      note(`register ${who}`);
      const { callAndProof } = await transfers[who].build().register().execute();
      const receipt = await devnet.executeOutside(callAndProof);
      return { who, txHash: receipt.transaction_hash ?? null };
      });
    },

    // `amount` is in BASE units, as the SDK's deposit()/transfer() take it. Callers
    // that mean whole tokens convert with core's toBaseUnits first.
    async shield({ who = "alice", amount = "100", token = "STRK" }) {
      return perAccount(who, async () => {
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
      });
    },

    async advance({ blocks = 11 }) {
      await advanceBlocks(blocks);
      return { advanced: blocks };
    },

    async transfer({ from = "alice", to = "bob", amount = "50", token = "STRK" }) {
      // Queued on the SENDER: that is the account that signs, approves and spends notes.
      return perAccount(from, async () => {
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
      });
    },

    /**
     * Publish two felts through the POOL, so the pool is the caller on chain.
     *
     * The whole point. `sncast invoke` on the target contract works and puts the user's own
     * account in `sender_address`, which identifies the author of every message they send —
     * measured at 1.000 in hydra-dapp's `chain-sender-disclosure.test.ts`. The pool's
     * `Invoke` action calls the target at `selector!("privacy_invoke")` with the calldata
     * verbatim (`privacy.cairo:997-999`), so routed this way the transaction is the pool's.
     *
     * `.invoke()` is the SDK's builder method for it (`sdk/src/interfaces.ts:708`). No token
     * operations are attached: publishing a pointer moves no value, and adding a transfer to
     * carry it would be inventing an economic cost the design does not have.
     */
    async publish({ who = "alice", contract, calldata = [], attach = "none", amount = "1", build }) {
      return perAccount(who, async () => {
      if (!contract) throw new Error("publish needs a contract address");
      note(`publish ${calldata.length} felts via pool for ${who} (attach=${attach})`);
      // No autoRegister and no autoSetup, and that is the finding rather than a preference.
      // With them, the FIRST publish carries the account's registration — so its address is in
      // the calldata and in a pool event, which is exactly the disclosure this route exists to
      // remove. The SECOND fails outright, because re-registering reverts during proof
      // compilation with the nameless error `explain()` translates. Registration is its own
      // step; publishing is not the place to do it implicitly.
      // `attach` is here because an invoke-only transaction does not compile: the pool
      // simulation emits no server message when there are no private actions to compile. Kept
      // as a parameter rather than a guess so the variants can be measured on one stack.
      // `build` comes straight from the request so the variants can be swept on ONE stack. A
      // restart costs five minutes here, and finding which builder option puts the author's
      // address in the calldata took more variants than that budget allows.
      const builder = transfers[who].build(build ?? (
        attach === "none" ? {} : { autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } }
      ));
      if (attach === "deposit") {
        await approve(who, env.strk, amount);
        builder.with(env.strk, (t) => t.deposit({ amount: BigInt(amount) }));
        builder.surplusTo(accounts[who].address);
      }
      const { callAndProof } = await builder
        .invoke(() => ({
          contractAddress: contract,
          calldata: calldata.map((f) => BigInt(f)),
        }))
        .execute();
      const receipt = await devnet.executeOutside(callAndProof);
      return { who, contract, txHash: receipt.transaction_hash ?? null };
      });
    },

    async notes({ who = "alice" }) {
      return perAccount(who, async () => {
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
      });
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
      // 1200, not 400: the pool's revert reasons nest one contract inside another and the
      // interesting part — the felt-encoded error string — is at the END. A 400-character
      // truncation cut off `INVALID_INVOKE_RETURN_DATA` and cost a round trip through the
      // block explorer to recover.
      send(500, { ok: false, error: String(e.message).slice(0, 1200) });
    }
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, server };
}
