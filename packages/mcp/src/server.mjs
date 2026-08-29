#!/usr/bin/env node
/**
 * hydra-mcp — stdio MCP server over the STRK20 privacy pool.
 *
 * Four tools, and the reason each exists:
 *
 *   resolve_endpoints   Upstream's own Day-0 guidance is not to guess at endpoints,
 *                       because a wrong proving service fails in ways that look like a
 *                       bug in your code. findings/06 then found the endpoint list most
 *                       tutorials use is retired. So: probe, report, and say UNKNOWN
 *                       where upstream itself says TODO.
 *   check_environment   packages/cli/src/doctor.mjs, unchanged.
 *   lint_config         packages/linter/src/analyze.mjs, unchanged.
 *   pool_state          Live views + deployed class hash, with the findings/06
 *                       discrepancy surfaced when it occurs.
 *
 * Every tool that answers about a network repeats the standing auditor condition. That
 * is deliberate (HANDOFF Phase F: "Always yes. Say it every time.").
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { resolveEndpoints, checkEnvironment, lintConfig, poolState, KNOWN_NETWORKS } from "./tools.mjs";

const networkArg = { network: z.enum(KNOWN_NETWORKS).describe("mainnet or sepolia") };

/** MCP tool results are text; JSON keeps UNKNOWN unambiguous and machine-readable. */
const asResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

async function run(fn, args) {
  try {
    return asResult(await fn(args));
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `${e.name}: ${e.message}` }] };
  }
}

export function createServer() {
  const server = new McpServer({ name: "hydra", version: "0.1.0" });

  server.registerTool(
    "resolve_endpoints",
    {
      title: "Resolve pool address, RPC endpoints and live keys for a network",
      description:
        "Returns the STRK20 privacy pool address, RPC endpoints probed live right now, and " +
        "the pool's current auditor and screener public keys. The hosted proving-service and " +
        "discovery-service URLs are reported as UNKNOWN because upstream publishes neither — " +
        "its own mainnet template leaves both as TODO placeholders. Do not guess them: a wrong " +
        "proving service fails in ways that look like a bug in your own code. Also reports that " +
        "every blastapi.io endpoint is retired, which breaks older tutorials.",
      inputSchema: networkArg,
    },
    (args) => run(resolveEndpoints, args)
  );

  server.registerTool(
    "check_environment",
    {
      title: "Verify the local toolchain against upstream's pins",
      description:
        "Wraps packages/cli/src/doctor.mjs. Checks Node >= 24, scarb, snforge, starknet-devnet, " +
        "the upstream checkout and its build artifacts against the versions pinned from " +
        "upstream .tool-versions. Reports every problem at once. Set HYDRA_UPSTREAM to point at " +
        "a starknet-privacy checkout.",
      inputSchema: {},
    },
    () => run(checkEnvironment, {})
  );

  server.registerTool(
    "lint_config",
    {
      title: "Report what a project's SDK configuration discloses",
      description:
        "Wraps packages/linter/src/analyze.mjs over a file or directory. Flags configurations " +
        "that send the user's private viewing key to a remote host, discovery concurrency traps, " +
        "and mainnet/Sepolia address mixing. Findings are disclosure consequences, not style " +
        "opinions. An empty result means no checked pattern matched — it is not a privacy claim.",
      inputSchema: { path: z.string().describe("Absolute path to a file or project directory") },
    },
    (args) => run(lintConfig, args)
  );

  server.registerTool(
    "pool_state",
    {
      title: "Read the live pool views and deployed class hash",
      description:
        "Read-only starknet_call against the deployed pool: get_auditor_public_key, " +
        "get_screener_public_key, get_fee_amount, get_proof_validity_blocks, plus the deployed " +
        "class hash. Compares the class hash with the one published in upstream's compatibility " +
        "matrix and surfaces the discrepancy — the published hash matches neither deployment, so " +
        "the matrix cannot be used to verify that a pool runs audited code.",
      inputSchema: networkArg,
    },
    (args) => run(poolState, args)
  );

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createServer().connect(new StdioServerTransport());
}
