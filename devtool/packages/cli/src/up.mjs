/**
 * Brings up the full local stack: devnet, deployed privacy pool, funded accounts,
 * and a real local discovery service. Nothing hosted.
 *
 * The pool deploy and account funding are upstream's own `Devnet` class — this is
 * packaging, not reimplementation. The indexer spawn mirrors e2e/src/indexer-client.ts.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { upstreamPath } from "./doctor.mjs";
import { AUDITOR_NOTE } from "./notes.mjs";
import { writeState, clearState } from "../../core/src/state.mjs";
import { startControl } from "./control.mjs";

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

/**
 * Hand `starknet-devnet` an explicit port, chosen by binding.
 *
 * Its npm wrapper picks a port by *connecting* to candidates and accepting one only on
 * ECONNREFUSED — every other error is rethrown, not skipped
 * (`node_modules/starknet-devnet/dist/util.js`, `isFreePort`). WSL2 running
 * `networkingMode=mirrored` drops connections to unbound IPv4 loopback ports instead of
 * resetting them, so that probe sits for ~135s and then throws, and `hydra-dev up` dies with
 * `connect ETIMEDOUT 127.0.0.1:6050` having never spawned devnet. (`::1` still refuses
 * correctly, which is why nothing else on such a machine notices.) 6050 is exactly the
 * port it tries first: DEFAULT_DEVNET_PORT 5050 plus its 1000 step.
 *
 * `ensureUrl` skips that probe entirely when `--port` is already in the args, so supplying
 * one avoids it. Binding is the better test anyway — it asks the kernel for a free port
 * rather than inferring one from a refused connection — so this is unconditional rather
 * than gated on detecting the mirrored-mode case, which would leave the path untested on
 * every machine that does not need it.
 *
 * Patched rather than configured because upstream's `Devnet.initialize()` builds its own
 * arg list and `DevnetConfig` exposes only `userAccounts` (`sdk/src/testing/devnet.ts`),
 * so there is no supported way to pass a port. An ESM `import` of a CJS package shares the
 * require cache, so this reaches the same class object the SDK imports afterwards.
 */
async function pinDevnetPort(upstream) {
  const require_ = createRequire(join(upstream, "sdk", "package.json"));
  const { Devnet } = require_("starknet-devnet");
  const original = Devnet.spawnInstalled;
  if (original.hydraPinsPort) return;          // up() can run more than once per process
  const patched = async function (config = {}) {
    const args = [...(config.args ?? [])];
    if (!args.includes("--port")) args.push("--port", String(await freePort()));
    return original.call(this, { ...config, args });
  };
  patched.hydraPinsPort = true;
  Devnet.spawnInstalled = patched;
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Per-request timeout, not just an overall deadline. A connect to a port nothing has
      // bound yet is refused instantly on most systems, but WSL2 in networkingMode=mirrored
      // drops it instead — and fetch() has no default timeout, so the await never returns
      // and the deadline below is never re-checked. The 30s budget would become a hang.
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
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
  await pinDevnetPort(up_);
  const { Devnet } = await import(join(up_, "sdk/dist/testing/index.js"));

  console.log("\n  starting devnet and deploying the privacy pool…");
  // devnet fixes its account set at spawn (`--accounts N`), so there is no way to
  // add one to a running chain. Restarting with a higher count is the honest
  // answer, and this is what makes it available.
  // THREE, not two, and the third is not a convenience.
  //
  // Two signers for one account corrupt each other: `sncast` signs from an accounts file while
  // the control API's in-process account object signs for the same address, neither knows the
  // other's nonce, and the result is an intermittent `starknet_addInvokeTransaction` failure
  // one run in six. The control API drives alice and bob; the extra account exists so anything
  // signing directly — `hydra-dapp/scripts/redeploy.ts`, sncast by hand — has one to itself.
  const userAccounts = Math.max(3, Math.min(16, Number(process.env.HYDRA_ACCOUNTS ?? 3)));
  const devnet = new Devnet({ userAccounts });
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

  // The control API lives here because this process owns the Devnet object that
  // executeOutside needs. Loopback only — it holds devnet account keys.
  console.log("  starting control API…");
  const control = await startControl({ devnet, env, upstream: up_, indexerUrl });

  // Publish where everything is, so `hydra-dev status`, the agent commands and the
  // TUI can find a stack they did not start.
  await writeState({
    startedAt: new Date().toISOString(),
    devnetUrl: devnet.url,
    wsUrl: devnet.wsUrl,
    indexerUrl,
    poolAddress: String(poolAddress),
    controlUrl: control.url,
    proving: "mock",
    indexerPid: child.pid,
    devnetPid: process.pid,
    tokens: { STRK: env.strk, ETH: env.eth },
    // Every account devnet predeployed, not just the three the flows use. Raising
    // HYDRA_ACCOUNTS produced them and nothing recorded them, so the TUI's "one more
    // account" restarted the chain and showed the same three rows. `flows` marks the
    // two the control API can act as — control.mjs:41 wraps alice and bob only, so
    // the others hold funds and cannot run a pool flow.
    accounts: [
      { name: "alice", address: String(env.alice.address), flows: true },
      { name: "bob", address: String(env.bob.address), flows: true },
      { name: "admin", address: String(env.admin.address), flows: false },
      ...(env.extraAccounts ?? []).map((a, i) => ({
        name: `user${i + 3}`, address: String(a.address), flows: false,
      })),
    ],
  });

  console.log(`
  STACK UP — nothing here is hosted.

    devnet RPC        ${devnet.url}
    devnet WS         ${devnet.wsUrl}
    discovery         ${indexerUrl}
    control           ${control.url}
    privacy pool      ${poolAddress}
    STRK / ETH        ${env.strk} / ${env.eth}

    alice             ${env.alice.address}
    bob               ${env.bob.address}
    admin             ${env.admin.address}
${(env.extraAccounts ?? []).map((a, i) => `    user${i + 3}             ${a.address}`).join("\n")}

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
    control.server.close();
    await devnet.cleanup().catch(() => {});
    await clearState().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}
