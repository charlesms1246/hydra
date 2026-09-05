/**
 * A Starknet JSON-RPC node, small enough to be a fixture and real enough to be a socket.
 *
 * **THE TUI TESTS WERE POINTED AT A PORT NOTHING LISTENED ON.** The setup page defaults `rpc` to
 * `http://127.0.0.1:5050` — the devnet's port — and no test overrode it. That cost nothing while
 * nothing in the effect path made a request. When `ensureFromBlock` moved into `commands.ts` the
 * TUI began calling it at three points, and every one of those calls went to a dead port.
 *
 * On a machine that refuses the connection that is instant and invisible. On this one it is not:
 * `fetch` hangs for undici's ten-second connect timeout, and the suite went from about a minute to
 * **three minutes twenty-two**, with every test still passing. Seven tests paying one timeout and
 * three paying four, which is exactly the nineteen calls the effect path makes.
 *
 * **A FIXTURE RATHER THAN AN ADDRESS THAT FAILS FASTER**, and the difference matters. Failing fast
 * would have made the suite quick again while leaving `ensureFromBlock` untested from the surface
 * that regressed — the call would still be a call that goes nowhere, and the repair the TUI now
 * performs at identity creation would still be asserted only by reading the source. Answering the
 * two methods it actually uses means the TUI tests exercise the discovery, and a state file they
 * create has a real deployment block in it that a test can assert.
 *
 * It answers exactly two methods and rejects everything else by name. A fixture that returns
 * something plausible for a method nobody meant to call is a fixture that hides the call.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";

/** Where the fake contract was deployed. Large, so a block number that is really an index shows. */
export const FIXTURE_DEPLOYED_AT = 1_284_617;

/** And where its chain head is, comfortably past the deployment. */
export const FIXTURE_HEAD = 1_310_004;

export type FixtureNode = { url: string; server: Server; asked: string[] };

/**
 * Serve the two methods `ensureFromBlock` needs, on a loopback port the caller must close.
 *
 * `starknet_getClassHashAt` answers by block, which is the whole point: `deploymentBlock` bisects
 * on it, so a fixture that answered unconditionally would return 0 and prove nothing.
 */
export async function fixtureNode(deployedAt = FIXTURE_DEPLOYED_AT): Promise<FixtureNode> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body || "{}") as
        { id?: number; method?: string; params?: any };
      asked.push(method ?? "(none)");
      const reply = (payload: object) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, ...payload }));
      };
      if (method === "starknet_blockNumber") return reply({ result: FIXTURE_HEAD });
      if (method === "starknet_getClassHashAt") {
        const at = params?.[0]?.block_number ?? FIXTURE_HEAD;
        // A real node reports CONTRACT_NOT_FOUND before the deployment. `deployedAt` reads the
        // ABSENCE of `result`, so the error's shape does not matter and its presence does.
        return at >= deployedAt
          ? reply({ result: "0x1234" })
          : reply({ error: { code: 20, message: "Contract not found" } });
      }
      reply({ error: { code: -32601, message: `fixtureNode does not serve ${method}` } });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, server, asked };
}
