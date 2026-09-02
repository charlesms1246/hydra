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
  /** Every event this contract has emitted, oldest first. */
  events(): Promise<{ readonly data: readonly bigint[] }[]>;
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
      const out: { data: bigint[] }[] = [];
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
        }, fetchImpl) as { events: { data: string[] }[]; continuation_token?: string };
        for (const e of page.events) out.push({ data: e.data.map((d) => BigInt(d)) });
        token = page.continuation_token;
      } while (token);
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
export function memoryChain(): Chain & { readonly published: [bigint, bigint][] } {
  const published: [bigint, bigint][] = [];
  return {
    published,
    async publish(calldata) {
      published.push([calldata[0], calldata[1]]);
      return `0x${published.length.toString(16).padStart(64, "0")}`;
    },
    async events() {
      return published.map((data) => ({ data }));
    },
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
