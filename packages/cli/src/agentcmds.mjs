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
import { whatDoesThisLeak } from "../../leak/src/leak.mjs";
import { check } from "./doctor.mjs";

// Three states, matching theme.mjs glyph(): serving-and-current, serving-but-behind, absent.
const dot = (up, warn) => (up ? "●" : warn ? "◐" : "○");

/**
 * The configuration `hydra up` actually runs, declared honestly. It lives here,
 * not in the TUI, because `hydra leak --json` and the TUI's disclosure matrix
 * must describe the same machine — one definition is the only way they cannot
 * drift, and the CLI is the layer the TUI already imports.
 *
 * `network` is deliberately OMITTED rather than set to "sepolia". A devnet is
 * neither mainnet nor sepolia, and declaring sepolia made the report print the
 * live Sepolia auditor key (packages/leak/src/facts.mjs:105) as the key in force
 * for a pool the user controls. Omitted, leak.mjs emits no key and adds a
 * kind:"unknown" note saying the auditor key in force is UNKNOWN.
 *
 * `discovery` is "indexer-self-hosted" because packages/cli/src/control.mjs:36
 * constructs `new IndexerDiscoveryProvider(indexerUrl, poolAddress)` — two
 * arguments, so OHTTP is off — against the indexer `hydra up` started.
 */
export function leakConfig(s) {
  return { discovery: "indexer-self-hosted", proving: s?.prover?.mode ?? "mock" };
}

/**
 * The declared action shapes `hydra leak` reports on.
 *
 * `transfer` carries NO `opensChannel`, and that omission is the point. It used to
 * say `false` — the reassuring branch — so `hydra leak transfer` answered
 * NOT_DISCLOSED_BY_THIS_TX with the reason "the caller states the channel already
 * exists", about a caller who had stated nothing. On a fresh stack it was simply
 * wrong: `get_num_of_channels(bob)` is 0 before the first transfer, so that transfer
 * DOES open a channel and DOES write bob's plaintext address.
 *
 * Whether a channel is open is a chain fact, not an action shape. `hydra leak` takes
 * no stack and cannot read it, so the honest answer is UNKNOWN — which is what
 * packages/leak returns for an absent field, and which the header comment above and
 * packages/core/src/flows.mjs:118-124 both already required.
 */
const LEAK_ACTIONS = {
  register: { type: "register" },
  deposit: { type: "deposit", token: "STRK", amount: "100" },
  transfer: { type: "transfer", token: "STRK", amount: "50", counterparty: "bob" },
  withdraw: { type: "withdraw", token: "STRK", amount: "50" },
  invoke: { type: "invoke", via: "shadow-account", dapp: "ekubo" },
};

export const COMMANDS = {
  status: {
    help: "whole stack at a glance",
    run: async () => status(),
    render: (s) => {
      const L = [];
      L.push(`  ${dot(s.devnet.up)} devnet    ${s.devnet.up ? s.devnet.url : "down"}` +
        (s.devnet.blockNumber !== null && s.devnet.up ? `   block ${s.devnet.blockNumber}` : ""));
      // Reachable-but-lagging gets its own dot: green would hide it, red would say
      // "restart me" about a service that is answering.
      L.push(`  ${dot(s.indexer.up && s.indexer.healthy, s.indexer.up)} indexer   ` +
        `${s.indexer.up ? s.indexer.url : "down"}` +
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
      ? `  ${i.healthy ? "●" : "◐"} indexer up at ${i.url}\n    status ${i.status}   head ${i.blockNumber}   lag ${i.lagSecs}s` +
        (i.healthy ? "" : "\n    lagging, not down — an idle devnet mints no blocks; a transaction clears it")
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

  /**
   * The disclosure matrix, which is the TUI's home screen, as a command. Same
   * leakConfig(), same whatDoesThisLeak() — the pane and this share one code
   * path, so they cannot report different things about the same machine.
   *
   * The report describes the DECLARED action shape, not a receipt: the action is
   * a literal from LEAK_ACTIONS above, and nothing here reads a transaction back
   * off chain to check it.
   */
  leak: {
    help: `what an action discloses — hydra leak [${Object.keys(LEAK_ACTIONS).join("|")}]`,
    run: async (args) => {
      const which = args.find((a) => !a.startsWith("-")) ?? "transfer";
      const action = LEAK_ACTIONS[which];
      if (!action) return { error: `unknown action: ${which} — one of ${Object.keys(LEAK_ACTIONS).join(", ")}` };
      return whatDoesThisLeak({ config: leakConfig(await status().catch(() => null)), actions: [action] });
    },
    render: (r) => {
      if (r.error) return `  ${r.error}`;
      const cell = (w) => String(w).padEnd(26);
      const L = [
        `  ${r.disclosures[0].action.type} · discovery ${r.config.discovery} · proving ${r.config.proving}` +
        ` · network ${r.config.network ?? "UNKNOWN"} · upstream ${r.upstreamCommit.slice(0, 8)}`,
        "",
        `  ${"".padEnd(28)}${r.fields.map(cell).join("")}`,
      ];
      for (const [id, label] of r.parties) {
        L.push(`  ${label.padEnd(28)}${r.fields.map((f) => cell(r.disclosures[0].byParty[id][f].disclosure)).join("")}`);
      }
      // The same gloss the TUI's legend carries, and for the same reason: an
      // unglossed NOT_DISCLOSED_BY_THIS_TX reads as "private".
      L.push("", "  NOT_DISCLOSED_BY_THIS_TX is NOT a claim of privacy, and UNKNOWN is never a pass" +
        " — packages/leak/src/facts.mjs:25-33");
      for (const n of r.notes ?? []) L.push(`  ${n.kind.padEnd(9)} ${n.text}`);
      L.push("", "  --json carries every cell's `why` and its file:line citations.");
      return L.join("\n");
    },
  },

  doctor: {
    help: "toolchain and build artifacts",
    run: async () => ({ rows: check() }),
    // Shows the fix, not just the fault. An earlier version printed only the
    // rows, which on a machine missing everything told a newcomer what was wrong
    // and nothing about what to do — the moment the tool is most needed.
    render: (d) => {
      const L = d.rows.map((r) =>
        `  [${r.status}] ${r.name.padEnd(24)} want ${String(r.want).padEnd(14)} got ${r.got}`);
      // MISS and WARN are different asks. A WARN is already handled — filing it under
      // "to fix" tells the reader to go and fix something that is working.
      const section = (title, rows) => {
        if (!rows.length) return;
        L.push("", `  ${title}`);
        for (const r of rows) {
          L.push(`    ${r.name}`);
          for (const line of String(r.hint ?? "no automatic fix").split("\n")) L.push(`      ${line.trim()}`);
        }
      };
      section("to fix:", d.rows.filter((r) => r.status.trim() === "MISS"));
      section("worth knowing:", d.rows.filter((r) => r.status.trim() === "WARN"));
      return L.join("\n");
    },
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
