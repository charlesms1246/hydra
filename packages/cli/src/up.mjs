/**
 * Brings up the full local stack: devnet, deployed privacy pool, funded accounts,
 * and a real local discovery service. Nothing hosted.
 *
 * The pool deploy and account funding are upstream's own `Devnet` class — this is
 * packaging, not reimplementation. The indexer spawn mirrors e2e/src/indexer-client.ts.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { upstreamPath } from "./doctor.mjs";
import { AUDITOR_NOTE } from "./notes.mjs";
import { writeState, clearState } from "../../core/src/state.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export async function up() {
  const up_ = upstreamPath();
  const { Devnet } = await import(join(up_, "sdk/dist/testing/index.js"));

  console.log("\n  starting devnet and deploying the privacy pool…");
  const devnet = new Devnet();
  const env = await devnet.initialize();

  const port = await freePort();
  const binary = join(up_, "target/release/discovery-service");
  console.log("  starting local discovery service…");

  const child = spawn(binary, [], {
    env: {
      ...process.env,
      WS_URL: devnet.wsUrl,
      RPC_URL: devnet.url,
      API_HOST: `127.0.0.1:${port}`,
      RUST_LOG: process.env.RUST_LOG ?? "error",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  const indexerUrl = `http://127.0.0.1:${port}`;
  if (!(await waitForHealth(indexerUrl))) {
    child.kill();
    await devnet.cleanup();
    throw new Error("discovery service did not become healthy within 30s");
  }

  const poolAddress = env.privacy.address ?? env.privacy.contractAddress;

  // Publish where everything is, so `hydra status`, the agent commands and the
  // TUI can find a stack they did not start.
  await writeState({
    startedAt: new Date().toISOString(),
    devnetUrl: devnet.url,
    wsUrl: devnet.wsUrl,
    indexerUrl,
    poolAddress: String(poolAddress),
    proving: "mock",
    indexerPid: child.pid,
    devnetPid: process.pid,
    tokens: { STRK: env.strk, ETH: env.eth },
    accounts: [
      { name: "alice", address: String(env.alice.address) },
      { name: "bob", address: String(env.bob.address) },
      { name: "admin", address: String(env.admin.address) },
    ],
  });

  console.log(`
  STACK UP — nothing here is hosted.

    devnet RPC        ${devnet.url}
    devnet WS         ${devnet.wsUrl}
    discovery         ${indexerUrl}
    privacy pool      ${poolAddress}
    STRK / ETH        ${env.strk} / ${env.eth}

    alice             ${env.alice.address}
    bob               ${env.bob.address}
    admin             ${env.admin.address}

  Proving is mocked. Discovery is local. No proving-service or indexer URL is needed.
${AUDITOR_NOTE}
  Ctrl-C to tear down.
`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("\n  tearing down…");
    child.kill();
    await devnet.cleanup().catch(() => {});
    await clearState().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}
