/**
 * The chain, as the two things the client actually needs from it.
 *
 * An interface rather than direct calls because there are genuinely two implementations: the
 * real one shells out to `sncast` and reads events over JSON-RPC, and the test one is a list in
 * memory. Without the seam, every test of the client would need a node, and a suite that needs
 * a node is a suite people stop running.
 *
 * It is deliberately tiny. `publish` takes the two felts and nothing else — I4 is enforced by
 * `noteCalldata`'s return type upstream of here, and widening this signature is the shape any
 * regression would take.
 */

import { execFileSync } from "node:child_process";
import type { State } from "./state.ts";

export type Chain = {
  /** Put a pointer and a commitment on chain. Returns the transaction hash. */
  publish(calldata: readonly [bigint, bigint]): Promise<string>;
  /**
   * Every event this contract has emitted, oldest first.
   *
   * `blockNumber` and `txHash` arrive in the SAME JSON-RPC response as `data` and were being
   * thrown away. Keeping them costs nothing and they are the only route to two things this repo
   * could not otherwise see: when an event happened, on a clock that is not the wall clock, and
   * — via one more call per transaction — which account published it. `channel.activeAccount` on
   * the disclosure table is about exactly that join, so a client that wants to tell a user how
   * linkable sending is right now starts here. See `decisions/0029`.
   *
   * Both are optional because `memoryChain` has neither a block nor a transaction, and inventing
   * plausible values for a test double is how a harness ends up measuring itself.
   */
  events(): Promise<{
    readonly data: readonly bigint[];
    readonly blockNumber?: number;
    readonly txHash?: string;
  }[]>;
  /**
   * Who published in a block range, and WHEN in wall-clock terms.
   *
   * A BLOCK SCAN RATHER THAN A LOOKUP PER TRANSACTION, and the timestamp is the reason. This was
   * `senders(txHashes)` doing one `getTransactionByHash` each, which answers "who" and not
   * "when" — so the caller reconstructed a time as `blockNumber * blockMs`. On Sepolia that is
   * about 4.2e11 against uploads at 1.8e12: not a different precision, a different quantity.
   * Nothing could ever overlap, the crowd was always zero, and zero is the alarming direction, so
   * it read as the honest common case.
   *
   * `starknet_getBlockWithTxs` returns the block's `timestamp` AND every transaction's
   * `sender_address`, so one call per block answers both and costs fewer requests than one per
   * transaction. It is also window-wide by construction — a range cannot be a chosen subset —
   * which is what `node.blockScan` on the disclosure table rests on.
   *
   * Optional because a chain with no blocks cannot answer. Settled history does not change, so a
   * caller may cache the answers forever.
   */
  publishers?(fromBlock: number, toBlock: number): Promise<{ account: string; atMs: number }[]>;
};

export type ChainConfig = {
  readonly rpcUrl: string;
  readonly contract: string;
  readonly fromBlock: number;
  readonly accountsFile: string;
  readonly account: string;
  /** `sepolia`, or a URL for a devnet. `sncast` wants one or the other, never both. */
  readonly network?: string;
};

async function rpc(
  url: string, method: string, params: unknown, fetchImpl: typeof fetch = fetch,
): Promise<any> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * `fetchImpl` is injected for the same reason `flush` takes one: the node is a party with its
 * own disclosure table (`node-view.ts`), and a table is only honest if something captures what
 * that party actually receives. `adversary/test/node-view.test.ts` is that capture.
 */
export function starknet(config: ChainConfig, fetchImpl: typeof fetch = fetch): Chain {
  const target = config.network ? ["--network", config.network] : ["--url", config.rpcUrl];
  return {
    async publish(calldata) {
      // Shelling out to sncast rather than signing here: signing needs the account's key, and
      // the client having a copy of it is a thing to avoid rather than a convenience.
      const out = execFileSync("sncast", [
        "--json", "--accounts-file", config.accountsFile, "--account", config.account,
        "invoke", "--contract-address", config.contract,
        "--function", "privacy_invoke",
        "--arguments", `${calldata[0]}, ${calldata[1]}`,
        ...target,
      ], { encoding: "utf8" });
      const last = out.trim().split("\n").filter(Boolean).pop()!;
      return JSON.parse(last).transaction_hash as string;
    },

    async events() {
      // Paged. A public node caps a page well below a busy contract's history, and a client
      // that reads only the first page silently stops seeing new messages.
      const out: { data: bigint[]; blockNumber?: number; txHash?: string }[] = [];
      let token: string | undefined;
      do {
        const page = await rpc(config.rpcUrl, "starknet_getEvents", {
          filter: {
            from_block: { block_number: config.fromBlock },
            to_block: "latest",
            address: config.contract,
            chunk_size: 100,
            ...(token ? { continuation_token: token } : {}),
          },
        }, fetchImpl) as {
          events: { data: string[]; block_number?: number; transaction_hash?: string }[];
          continuation_token?: string;
        };
        for (const e of page.events) {
          // `block_number` and `transaction_hash` arrive in the SAME response as `data`. Keeping
          // them costs nothing and they are the only route to when an event happened and who
          // published it — see the type above and `decisions/0029`.
          out.push({
            data: e.data.map((d) => BigInt(d)),
            blockNumber: e.block_number,
            txHash: e.transaction_hash,
          });
        }
        token = page.continuation_token;
      } while (token);
      return out;
    },

    /**
     * One `starknet_getBlockWithTxs` per block in the range, in order.
     *
     * A transaction with no `sender_address` — an L1 handler, a deploy — is left out rather than
     * given a zero, so a caller counting accounts does not count one that does not exist. A block
     * that will not load is skipped rather than throwing: a partial answer narrows the crowd,
     * which is the safe direction, and a thrown one would lose the message being sent.
     */
    async publishers(fromBlock, toBlock) {
      const out: { account: string; atMs: number }[] = [];
      for (let n = fromBlock; n <= toBlock; n++) {
        const block = await rpc(config.rpcUrl, "starknet_getBlockWithTxs",
          [{ block_number: n }], fetchImpl).catch(() => null) as
          { timestamp?: number; transactions?: { sender_address?: string }[] } | null;
        if (!block?.timestamp || !block.transactions) continue;
        for (const tx of block.transactions) {
          if (tx.sender_address) out.push({ account: tx.sender_address, atMs: block.timestamp * 1000 });
        }
      }
      return out;
    },
  };
}

/**
 * Publish through the POOL rather than from your own account.
 *
 * The pool's `Invoke` action calls the target at `selector!("privacy_invoke")` with the calldata
 * verbatim (`.upstream/packages/privacy/src/privacy.cairo:997-999`), and the transaction is
 * submitted by a relayer through `executeOutside`. So `sender_address` is the relayer's and the
 * `nonce` is the relayer's — the author is no longer the submitter and their messages are no
 * longer ordered by their own nonce.
 *
 * IT DOES NOT REMOVE THE AUTHOR, and `live-authorship.test.ts` measures that on a real chain.
 *
 * A pool transaction carrying only an invoke does not compile: the simulation emits no server
 * message, because there are no private actions to compile. Swept across every builder option
 * on one stack, exactly one combination worked without moving value — `autoSetup` plus
 * `autoDiscover` — and it worked **once per account**, because what it contributed was an
 * `OpenChannel`, and the second time the channel already exists so there is again nothing to
 * compile. `OpenChannel` names an address, and measured across two publishers it is the
 * PUBLISHER'S own: alice publishing writes alice, bob publishing writes bob.
 *
 * So a repeatable pool-routed publish has to attach an action that moves value. That is a
 * deposit, a deposit is an ERC20 pull from the author's account, and an ERC20 pull is public.
 *
 * **There is no route that publishes a pointer without naming a real address on chain.** The
 * design's premise — the pool invokes on the user's behalf, so the caller is the pool — is true
 * about the caller and false about the transaction. What routing through the pool buys is real
 * but smaller than it sounds: `sender_address` becomes the relayer's, and the author's messages
 * stop being ordered by their own nonce. The disclosure moved and shrank; it did not close.
 *
 * AND IT COSTS. Every message carries a token deposit, because that is the cheapest repeatable
 * private action. Devnet only: this goes through the Devtool's control API, which holds the
 * proving loop and the relayer's key. A real client needs the SDK in process.
 */
export function poolChain(
  config: ChainConfig & { controlUrl: string; who: string; attach?: "none" | "deposit" },
): Chain {
  const direct = starknet(config);
  return {
    async publish(calldata) {
      const res = await fetch(`${config.controlUrl}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          who: config.who,
          contract: config.contract,
          calldata: calldata.map(String),
          // `deposit` by default, because `none` works exactly once per account. See the header.
          attach: config.attach ?? "deposit",
          amount: "1000",
          build: { autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } },
        }),
      });
      const body = await res.json() as { ok: boolean; txHash?: string; error?: string };
      if (!body.ok || !body.txHash) throw new Error(`pool publish failed: ${body.error}`);
      return body.txHash;
    },
    // Reading is identical: the event is the event, whoever put it there.
    events: direct.events,
  };
}

/** For tests, and for anyone who wants to see what the client does before it costs gas. */
/**
 * A chain in memory, for tests.
 *
 * `crowd` IS THE POINT OF THE OPTION, and its absence is equally the point. Without it there is
 * no `publishers`, so `narrowCrowd` cannot run and the client renders "not measured" — the state
 * every hermetic test was in, and the state that hid a feature computing nothing for two separate
 * reasons. With it a real crowd exists and the chain-backed path is exercised.
 *
 * Both are needed. "Not measured" is a real rendering with its own copy, and a fixture that only
 * ever produced a number would stop testing it — which is how the last one went wrong.
 */
/**
 * An in-memory chain, and **a harder one than it was** — `decisions/0041` (the fakes audit).
 *
 * A fake that is easier than reality hides every bug in the code that copes with reality, and this
 * one has already cost five bugs in one feature. Three things changed:
 *
 *   - **`publishers` honours its block range.** It used to take no arguments at all while the
 *     signature declared two, so `narrowCrowd`'s range computation was handed to a function that
 *     discarded it — making any error in that computation structurally invisible.
 *   - **Foreign events are the default.** A real chain interleaves other people's events with
 *     yours, and the path where a reader sifts its own out of a stream was exercised by nothing.
 *     `own: true` opts back into a clean stream for a test that genuinely needs one; the clean
 *     stream is the unrealistic case and is no longer what you get by not thinking about it.
 *   - **`publish` can fail.** No test had ever seen a failed publish — no gas failure, no nonce
 *     collision, no rejection — so an entire class of error handling had zero coverage.
 */
/**
 * Where a fake chain's blocks start.
 *
 * Not zero. Sequential-from-zero block numbers are what let `blockNumber * blockMs` look like a
 * wall clock — about 4.2e11 against uploads at 1.8e12 — so the crowd was always empty and the
 * emptiness read as the honest common case rather than as a bug. A realistic number makes wrong
 * arithmetic visibly wrong.
 */
const FIRST_BLOCK = 1_284_000;

export function memoryChain(opts: {
  /** Other accounts publishing, in wall-clock ms, so a crowd can exist. */
  readonly crowd?: readonly { readonly account: string; readonly at: readonly number[] }[];
  /** Opt back into a stream carrying only this client's events. The unrealistic case. */
  readonly own?: boolean;
  /** Fail the nth publish (1-based), the way a real one fails on gas or a nonce collision. */
  readonly failPublishOn?: number;
} = {}): Chain & { readonly published: [bigint, bigint][]; readonly asked: { from: number; to: number }[] } {
  const published: [bigint, bigint][] = [];
  let attempts = 0;
  // Crowd publishers are placed on blocks so a range filter has something to filter on.
  const others = (opts.crowd ?? [])
    .flatMap((p) => p.at.map((atMs) => ({ account: p.account, atMs })));
  /**
   * The ranges `publishers` was asked for.
   *
   * RECORDING RATHER THAN FILTERING IS THE HONEST CHECK HERE. The fake took no arguments while the
   * signature declared two, so `narrowCrowd`'s range computation was handed to something that
   * discarded it. Filtering strictly instead would force every crowd fixture to model block
   * placement — brittle, and it would prove less than this: a test can now assert the range the
   * caller computed, which is the thing that was invisible.
   */
  const asked: { from: number; to: number }[] = [];
  return {
    published,
    asked,
    async publish(calldata) {
      attempts++;
      if (opts.failPublishOn === attempts) {
        // Shaped like a real refusal: the transaction does not land and the caller is told. A real
        // one costs gas from an account and can be rejected for reasons the client cannot fix.
        throw new Error("the chain refused the transaction (simulated: insufficient fee)");
      }
      published.push([calldata[0], calldata[1]]);
      return `0x${published.length.toString(16).padStart(64, "0")}`;
    },
    async events() {
      // BLOCK NUMBERS THAT LOOK LIKE BLOCK NUMBERS. Sequential from zero was the shape that let a
      // client multiply one by `blockMs` and get a plausible-looking wall clock; real ones are
      // large and sparse, so the arithmetic that was wrong is visibly wrong.
      const mine = published.map((data, i) => ({
        data, blockNumber: FIRST_BLOCK + i * 3, txHash: `0x${(0xbeef0000 + i).toString(16)}`,
      }));
      if (opts.own) return mine;
      // Interleaved, not appended: a reader that only looks at the tail would still pass.
      return mine.flatMap((e, i) => [
        { data: [0x1111n + BigInt(i), 0x2222n + BigInt(i)] as bigint[],
          blockNumber: e.blockNumber - 1, txHash: `0x${(0xfeed0000 + i).toString(16)}` },
        e,
      ]);
    },
    // Present only when a crowd was configured, so the unmeasured path stays reachable.
    ...(opts.crowd
      ? {
        publishers: async (fromBlock: number, toBlock: number) => {
          if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock) {
            throw new Error(`publishers asked for [${fromBlock}, ${toBlock}], which is not a range`);
          }
          asked.push({ from: fromBlock, to: toBlock });
          return others.map((o) => ({ ...o }));
        },
      }
      : {}),
  };
}

/**
 * Which route this client's state says to publish through.
 *
 * Here rather than in `cli.ts` because there are now two front ends and the route is a privacy
 * decision, not a presentation one: a TUI that picked `starknet` while the CLI picked
 * `poolChain` would give the same user two different disclosures depending on which one they
 * happened to open.
 *
 * Direct is the default because `pool` needs a control API that only the devnet stack provides.
 */
export const chainFor = (state: State): Chain => {
  const base = {
    rpcUrl: state.rpcUrl, contract: state.contract, fromBlock: state.fromBlock,
    accountsFile: state.accountsFile, account: state.account, network: state.network,
  };
  return state.controlUrl
    ? poolChain({ ...base, controlUrl: state.controlUrl, who: state.poolAccount || "alice" })
    : starknet(base);
};
