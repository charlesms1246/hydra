#!/usr/bin/env node
/**
 * The TUI, driven by a simulated stack. No devnet, no scarb, no cargo, nothing spawned.
 *
 *   node packages/tui/sandbox/run.mjs                 # healthy stack
 *   node packages/tui/sandbox/run.mjs empty           # first-run, nothing running
 *   node packages/tui/sandbox/run.mjs degraded        # indexer lagging (503/UNHEALTHY)
 *   node packages/tui/sandbox/run.mjs broken          # a fixable row in Tools
 *   node packages/tui/sandbox/run.mjs slow            # ~1.2s per call: loading + staleness
 *   node packages/tui/sandbox/run.mjs flaky           # 1 call in 3 fails: error states
 *
 *   node packages/tui/sandbox/run.mjs degraded --drive 100 30 e ENTER   # headless frame
 *
 * What is real here: the App, every panel, the keymap, the layout, @hydra/core's probe,
 * services, wallets, chain and transact modules, and the whole of packages/leak. What is
 * simulated: the chain, over HTTP, plus the three modules that would spawn processes.
 * So a screen that looks right here is reading data that took the shipping code path.
 */

import { register } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorld, SCENARIOS } from "./world.mjs";
import { startServer } from "./server.mjs";
import { setWorld } from "./state.mjs";

const argv = process.argv.slice(2);
const scenario = argv.find((a) => !a.startsWith("--")) ?? "up";
const driveAt = argv.indexOf("--drive");

if (argv.includes("--help") || !SCENARIOS[scenario]) {
  if (!SCENARIOS[scenario]) console.error(`\n  unknown scenario: ${scenario}\n`);
  console.log("\n  scenarios:\n");
  for (const [k, v] of Object.entries(SCENARIOS)) console.log(`    ${k.padEnd(10)} ${v.label}`);
  console.log("\n  node packages/tui/sandbox/run.mjs <scenario> [--drive COLS ROWS KEY...]\n");
  process.exit(SCENARIOS[scenario] ? 0 : 1);
}

const world = setWorld(createWorld(scenario));
const { server, url } = await startServer(world);

// A throwaway HYDRA_HOME, so the sandbox can never read or overwrite a real stack's
// state file. Everything downstream finds the fake server through this, exactly as it
// would find a real one.
const home = await mkdtemp(join(tmpdir(), "hydra-sandbox-"));
process.env.HYDRA_HOME = home;

if (world.running) {
  await writeFile(join(home, "state.json"), JSON.stringify({
    startedAt: new Date().toISOString(),
    devnetUrl: url, wsUrl: url.replace("http", "ws") + "/ws", indexerUrl: url, controlUrl: url,
    poolAddress: world.pool, proving: "mock",
    // Our own pid, so pidAlive() reports true without inventing a process.
    indexerPid: process.pid, devnetPid: process.pid,
    tokens: world.tokens,
    accounts: world.accounts.map((a) => ({ name: a.name, address: a.address })),
  }, null, 2));
}

// rmSync on the exit path, not rm(): process.on("exit") runs no async work, and a
// sandbox killed with Ctrl-C or SIGTERM would otherwise leave its temp HYDRA_HOME behind.
const cleanup = () => {
  server.close();
  rmSync(home, { recursive: true, force: true });
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(sig, () => { cleanup(); process.exit(0); });
}

register("./loader.mjs", import.meta.url);

if (driveAt !== -1) {
  const [cols, rows, ...keys] = argv.slice(driveAt + 1);
  const { drive } = await import("./drive.mjs");
  // `slow` and `flaky` need longer than the default before the first frame means anything.
  // The splash holds for MIN_SPLASH_MS and then seals for SEAL_MS before the
  // dashboard exists at all, so a headless capture has to outlast both or it
  // photographs the loading screen every time.
  const settle = Number(process.env.SANDBOX_SETTLE ?? (world.latencyMs ? world.latencyMs * 2 + 2400 : 2400));
  await drive(Number(cols) || 100, Number(rows) || 30, keys, settle);
  process.exit(0);
}

console.log(`\n  sandbox · ${scenario} — ${SCENARIOS[scenario].label}`);
console.log(`  fake stack at ${url}   HYDRA_HOME=${home}`);
console.log("  nothing real is running; q to quit\n");

const { start } = await import("../src/app.mjs");
await start();
process.exit(0);
