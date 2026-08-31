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

async function rpc(url: string, method: string, params: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export function starknet(config: ChainConfig): Chain {
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
        }) as { events: { data: string[] }[]; continuation_token?: string };
        for (const e of page.events) out.push({ data: e.data.map((d) => BigInt(d)) });
        token = page.continuation_token;
      } while (token);
      return out;
    },
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
