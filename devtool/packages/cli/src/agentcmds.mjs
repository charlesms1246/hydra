/**
 * The command surface an agent calls directly: `hydra-dev indexer --status --json`.
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

/** `0x534e5f4d41494e` -> `SN_MAIN`. Falls back to the hex if it is not printable ASCII. */
function decodeChainId(hex) {
  try {
    const s = Buffer.from(String(hex).replace(/^0x/, ""), "hex").toString("ascii");
    return /^[\x20-\x7e]+$/.test(s) ? s : String(hex);
  } catch {
    return String(hex);
  }
}

/**
 * The configuration `hydra-dev up` actually runs, declared honestly. It lives here,
 * not in the TUI, because `hydra-dev leak --json` and the TUI's disclosure matrix
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
 * arguments, so OHTTP is off — against the indexer `hydra-dev up` started.
 *
 * `proving` is OMITTED for the same reason as `network` when the stack could not be
 * read. It used to default to "mock" on a failed status(), which was true only
 * because `up` happens to configure a mock prover today — a value asserted rather
 * than read, correct now, and silently wrong the moment proving mode becomes
 * configurable. Omitted, leak.mjs:386-393 reports the prover's cells as undeclared
 * rather than as mocked, which errs toward over-disclosure. Standing rule 6.
 */
export function leakConfig(s) {
  const config = { discovery: "indexer-self-hosted" };
  const mode = s?.prover?.mode;
  if (mode) config.proving = mode;
  return config;
}

/**
 * The declared action shapes `hydra-dev leak` reports on.
 *
 * `transfer` carries NO `opensChannel`, and that omission is the point. It used to
 * say `false` — the reassuring branch — so `hydra-dev leak transfer` answered
 * NOT_DISCLOSED_BY_THIS_TX with the reason "the caller states the channel already
 * exists", about a caller who had stated nothing. On a fresh stack it was simply
 * wrong: `get_num_of_channels(bob)` is 0 before the first transfer, so that transfer
 * DOES open a channel and DOES write bob's plaintext address.
 *
 * Whether a channel is open is a chain fact, not an action shape. `hydra-dev leak` takes
 * no stack and cannot read it, so the honest answer is UNKNOWN — which is what
 * packages/leak returns for an absent field, and which the header comment above and
 * packages/core/src/flows.mjs:118-124 both already required.
 */
export const LEAK_ACTIONS = {
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
      // "devnet" is a label this tool never read. With --rpc the node may be mainnet or
      // Sepolia, and printing `● devnet https://…/mainnet` asserts a network nobody
      // checked — E-DEV15 in a different field. Say "node" whenever the URL was supplied
      // rather than started by `up`, and print the chain id, which IS read.
      const netLabel = s.devnet.rpcOverride ? "node  " : "devnet";
      // Decoded: a chain id is an ASCII short string, and `0x534e5f4d41494e` on screen
      // makes a reader look it up to learn which network they just read.
      const chain = s.devnet.chainId ? `   chain ${decodeChainId(s.devnet.chainId)}` : "";
      L.push(`  ${dot(s.devnet.up)} ${netLabel}    ${s.devnet.up ? s.devnet.url : "down"}` +
        (s.devnet.blockNumber !== null && s.devnet.up ? `   block ${s.devnet.blockNumber}` : "") +
        (s.devnet.up ? chain : ""));
      // Reachable-but-lagging gets its own dot: green would hide it, red would say
      // "restart me" about a service that is answering.
      L.push(`  ${dot(s.indexer.up && s.indexer.healthy, s.indexer.up)} indexer   ` +
        `${s.indexer.up ? s.indexer.url : "down"}` +
        (s.indexer.up ? `   lag ${s.indexer.lagSecs ?? "?"}s` : ""));
      L.push(`  ${dot(Boolean(s.prover.mode))} prover    ${s.prover.mode ?? "—"}`);
      L.push(`  ${dot(s.agents.mcp.present)} mcp       ${s.agents.mcp.present ? "present" : "withheld"}`);
      L.push(`  ${dot(s.agents.skills.installed.length > 0)} skills    ` +
        `${s.agents.skills.installed.length}/${s.agents.skills.expected.length} installed`);
      if (s.stack) L.push(`\n  pool      ${s.stack.poolAddress}`);
      if (!s.stack) L.push(`\n  no running stack — 'hydra-dev up'`);
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
      // "withheld", not "missing": packages/mcp is untracked and gitignored under
      // a67514b pending coordinated disclosure, and is excluded from package.json's
      // `files`. So a fresh clone and an installed tarball both lack it permanently,
      // and `hydra-dev bootstrap` cannot help. "Missing" sends a reader looking for a
      // remedy that does not exist. ERRORS.md E-DEV13.
      return `  ${dot(a.mcp.present)} mcp     ${a.mcp.present ? "present" : "withheld — not in this distribution"}\n` +
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
      if (!address) return { ok: false, error: "usage: hydra-dev faucet --address 0x… [--amount 1e18]" };
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
    help: "transaction status — hydra-dev tx <hash>",
    run: async (args) => {
      const hash = args.find((a) => a.startsWith("0x"));
      if (!hash) return { available: false, reason: "usage: hydra-dev tx 0x…" };
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
    help: `what an action discloses — hydra-dev leak [${Object.keys(LEAK_ACTIONS).join("|")}]`,
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
        // `?? "UNKNOWN"` for the same reason ConfigStrip does it: leakConfig omits
        // `proving` when no stack was read, and interpolating it raw printed
        // "proving undefined". ERRORS.md E-DEV15.
        `  ${r.disclosures[0].action.type} · discovery ${r.config.discovery} · proving ${r.config.proving ?? "UNKNOWN"}` +
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
    // `ok` is the same verdict `up` gates on and the MCP environment tool reports
    // (mcp/src/tools.mjs:153). Without it this command exited 0 on a machine missing
    // the upstream checkout, so an agent — the audience --json exists for — had to
    // parse every row to learn the environment was unusable. WARN does not fail:
    // a warning is a handled condition, same rule as doctor.mjs report().
    // `status` is column-padded at source (doctor.mjs OK = "ok  ") so the human
    // table lines up. That is a display concern and --json is read by agents, who
    // have no way to know they must trim before comparing. Strip it here, at the
    // one place the machine-readable result is built, and let render() pad. Every
    // other consumer calls check() directly and is untouched.
    run: async () => {
      const rows = check().map((r) => ({ ...r, status: r.status.trim() }));
      return { ok: rows.every((r) => r.status !== "MISS"), rows };
    },
    // Shows the fix, not just the fault. An earlier version printed only the
    // rows, which on a machine missing everything told a newcomer what was wrong
    // and nothing about what to do — the moment the tool is most needed.
    render: (d) => {
      const L = d.rows.map((r) =>
        `  [${r.status.padEnd(4)}] ${r.name.padEnd(24)} want ${String(r.want).padEnd(14)} got ${r.got}`);
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
      section("to fix:", d.rows.filter((r) => r.status === "MISS"));
      section("worth knowing:", d.rows.filter((r) => r.status === "WARN"));
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
