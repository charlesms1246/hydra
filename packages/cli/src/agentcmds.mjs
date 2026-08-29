/**
 * The command surface an agent calls directly: `hydra indexer --status --json`.
 *
 * Every command is a thin wrapper over @hydra/core and every one accepts --json,
 * because a surface an agent can only read by parsing prose is not a surface.
 * Human output is a rendering of the same object, never a separate code path.
 */

import { status, agentStatus } from "../../core/src/services.mjs";
import { wallets, faucet } from "../../core/src/wallets.mjs";
import { latestBlocks, txStatus } from "../../core/src/chain.mjs";
import { readState } from "../../core/src/state.mjs";
import { check } from "./doctor.mjs";

const dot = (up) => (up ? "●" : "○");

export const COMMANDS = {
  status: {
    help: "whole stack at a glance",
    run: async () => status(),
    render: (s) => {
      const L = [];
      L.push(`  ${dot(s.devnet.up)} devnet    ${s.devnet.up ? s.devnet.url : "down"}` +
        (s.devnet.blockNumber !== null && s.devnet.up ? `   block ${s.devnet.blockNumber}` : ""));
      L.push(`  ${dot(s.indexer.up)} indexer   ${s.indexer.up ? s.indexer.url : "down"}` +
        (s.indexer.up ? `   lag ${s.indexer.lagSecs ?? "?"}s` : ""));
      L.push(`  ${dot(true)} prover    ${s.prover.mode}`);
      L.push(`  ${dot(s.agents.mcp.present)} mcp       ${s.agents.mcp.present ? "present" : "missing"}`);
      L.push(`  ${dot(s.agents.skills.installed.length > 0)} skills    ` +
        `${s.agents.skills.installed.length}/${s.agents.skills.expected.length} installed`);
      if (s.stack) L.push(`\n  pool      ${s.stack.poolAddress}`);
      if (!s.stack) L.push(`\n  no running stack — 'hydra up'`);
      return L.join("\n");
    },
  },

  devnet: {
    help: "local chain status",
    run: async () => (await status()).devnet,
    render: (d) => d.up
      ? `  ● devnet up at ${d.url}\n    chain ${d.chainId}   block ${d.blockNumber}`
      : `  ○ devnet down (${d.reason ?? "no state"})`,
  },

  indexer: {
    help: "discovery service status",
    run: async () => (await status()).indexer,
    render: (i) => i.up
      ? `  ● indexer up at ${i.url}\n    status ${i.status}   head ${i.blockNumber}   lag ${i.lagSecs}s`
      : `  ○ indexer down (${i.reason ?? "no state"})`,
  },

  agents: {
    help: "MCP server and agent skills",
    run: async () => agentStatus(),
    render: (a) => {
      const missing = a.skills.expected.filter((s) => !a.skills.installed.includes(s));
      return `  ${dot(a.mcp.present)} mcp     ${a.mcp.present ? "present" : "missing"}\n` +
        `  ${dot(missing.length === 0)} skills  ${a.skills.installed.join(", ") || "none"}` +
        (missing.length ? `\n    missing: ${missing.join(", ")}` : "");
    },
  },

  wallets: {
    help: "test accounts and balances",
    run: async () => wallets(),
    render: (w) => !w.available ? `  ${w.reason}` :
      w.wallets.map((x) =>
        `  ${x.name.padEnd(7)} ${x.address.slice(0, 14)}…  ` +
        Object.entries(x.balances).map(([s, b]) => `${b.formatted ?? "?"} ${s}`).join("  ")
      ).join("\n"),
  },

  faucet: {
    help: "fund an address on devnet — devnet only, there is no mainnet faucet",
    run: async (args) => {
      const address = argOf(args, "--address");
      if (!address) return { ok: false, error: "usage: hydra faucet --address 0x… [--amount 1e18]" };
      return faucet({ address, amount: argOf(args, "--amount") ?? 1e18 });
    },
    render: (r) => r.ok ? `  funded — new balance ${r.new_balance ?? "(see --json)"}` : `  failed: ${r.error}`,
  },

  blocks: {
    help: "recent blocks",
    run: async () => latestBlocks(Number(process.env.HYDRA_BLOCKS ?? 8)),
    render: (b) => !b.available ? `  ${b.reason}` :
      b.blocks.map((x) => `  #${String(x.number).padEnd(6)} ${x.txCount} tx   ${x.hash.slice(0, 18)}…`).join("\n"),
  },

  tx: {
    help: "transaction status — hydra tx <hash>",
    run: async (args) => {
      const hash = args.find((a) => a.startsWith("0x"));
      if (!hash) return { available: false, reason: "usage: hydra tx 0x…" };
      return txStatus(hash);
    },
    render: (t) => !t.available ? `  ${t.reason}` : !t.found ? `  not found: ${t.error ?? ""}` :
      `  ${t.hash.slice(0, 22)}…\n  finality ${t.finality}   execution ${t.execution}   block ${t.blockNumber}` +
      (t.revertReason ? `\n  reverted: ${t.revertReason}` : ""),
  },

  doctor: {
    help: "toolchain and build artifacts",
    run: async () => ({ rows: check() }),
    render: (d) => d.rows.map((r) =>
      `  [${r.status}] ${r.name.padEnd(24)} want ${String(r.want).padEnd(14)} got ${r.got}`).join("\n"),
  },
};

function argOf(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Shared by the CLI and anything else that wants one command's result. */
export async function runCommand(name, args = []) {
  const cmd = COMMANDS[name];
  if (!cmd) return { error: `unknown command: ${name}` };
  return cmd.run(args);
}
