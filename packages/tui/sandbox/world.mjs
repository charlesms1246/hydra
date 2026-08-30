/**
 * A simulated STRK20 stack, in memory.
 *
 * This is the only file that decides what the sandbox believes. It holds no HTTP and
 * no Ink — `server.mjs` exposes it over the wire and the TUI reaches it through the
 * real `@hydra/core`, so the code under test is the shipping code.
 */

const STRK = "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ETH = "0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const POOL = "0x125d4a7d1c16a12e2f572472f8553bfd8a06d9690348d54872b1884819ede03";

const ACCOUNTS = [
  { name: "alice", address: "0x34ba56f92265f0868c57d3fe72ecab144fc96f97954bbbc4252cef8e8a979ba" },
  { name: "bob", address: "0x2939f2dc3f80cc7d620e8a86f2e69c1e187b7ff44b74056647368b5c49dc370" },
  { name: "admin", address: "0x25a6c9f0c15ef30c139065096b4b8e563e6b86191fd600a4f0616df8f22fb77" },
];

/**
 * Scenarios are the point of the sandbox: each is a screen state that is otherwise
 * tedious or impossible to reach on demand. `degraded` and `broken` in particular are
 * states the real machine only reaches by waiting or by being half-provisioned.
 */
export const SCENARIOS = {
  up: { label: "healthy stack, everything answering" },
  empty: { label: "no stack running — the first-run screen" },
  degraded: { label: "indexer reachable but lagging (idle devnet, 503/UNHEALTHY)" },
  broken: { label: "stack up, toolchain incomplete — gives Tools a fixable row" },
  slow: { label: "healthy, but every call takes ~1.2s — shows loading and staleness" },
  flaky: { label: "one call in three fails — shows error states and climbing age" },
};

export function createWorld(scenario = "up") {
  if (!SCENARIOS[scenario]) throw new Error(`unknown scenario: ${scenario}`);

  const w = {
    scenario,
    running: scenario !== "empty",
    // Block timestamps drive the indexer's lag, which is what makes it report
    // UNHEALTHY. Backdating the head is the whole of the `degraded` scenario.
    blockNumber: 24,
    headAgeSecs: scenario === "degraded" ? 148 : 1,
    latencyMs: scenario === "slow" ? 1200 : 0,
    failOneIn: scenario === "flaky" ? 3 : 0,
    calls: 0,
    tokens: { STRK, ETH },
    pool: POOL,
    accounts: ACCOUNTS,
    balances: Object.fromEntries(
      ACCOUNTS.map((a) => [a.address, { [STRK]: 1000n * 10n ** 18n, [ETH]: 1000n * 10n ** 18n }])
    ),
    notes: { alice: [], bob: [] },
    registered: new Set(["alice"]),
    // recipient address -> channels opened to it. The pool exposes this as a public
    // view, and it is the one fact that decides whether a transfer discloses its
    // recipient, so the sandbox has to model it or the disclosure preview is fiction.
    channels: new Map(),
    txs: new Map(),
    log: [],
  };

  w.note = (line) => {
    w.log.push(`${new Date().toISOString().slice(11, 19)}  ${line}`);
    if (w.log.length > 300) w.log.shift();
  };

  /** Every simulated call goes through here, so latency and failure are uniform. */
  w.tick = async () => {
    w.calls++;
    if (w.latencyMs) await new Promise((r) => setTimeout(r, w.latencyMs));
    if (w.failOneIn && w.calls % w.failOneIn === 0) throw new Error("simulated transport failure");
  };

  /** A transaction mints a block, which is also what clears the indexer's lag. */
  w.mineBlock = (txHash) => {
    w.blockNumber++;
    w.headAgeSecs = 0;
    if (txHash) w.txs.set(txHash, { blockNumber: w.blockNumber, at: Date.now() });
    return w.blockNumber;
  };

  w.hash = () => "0x" + (w.calls * 7919 + w.blockNumber * 104729).toString(16).padStart(62, "3");

  return w;
}
