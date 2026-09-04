#!/usr/bin/env node
/**
 * hydra-dev — one entry point for the local STRK20 stack.
 *
 * Two audiences, one implementation. A developer runs `hydra-dev` for the TUI; an
 * agent runs `hydra-dev indexer --status --json` and parses the result. Both go
 * through COMMANDS in agentcmds.mjs, so they can never report different things.
 */

import { check, report } from "./doctor.mjs";
import { COMMANDS, runCommand, LEAK_ACTIONS } from "./agentcmds.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const asJson = argv.includes("--json");

// `--rpc <url>` is sugar for HYDRA_RPC, so both spellings hit one code path in state.mjs.
// Stripped from `args` so a command never sees it as a positional.
const rpcAt = argv.indexOf("--rpc");
if (rpcAt !== -1) {
  const url = argv[rpcAt + 1];
  if (!url || url.startsWith("-")) {
    console.error("  --rpc needs a URL, e.g. --rpc https://api.cartridge.gg/x/starknet/mainnet\n");
    process.exit(2);
  }
  process.env.HYDRA_RPC = url;
}
const args = argv.slice(1).filter((a, i, all) => a !== "--rpc" && all[i - 1] !== "--rpc");

// The stack lifecycle owns the state file; pointing it at someone else's node is
// meaningless at best. Refused here rather than deeper, so the message names the command.
const LOCAL_ONLY = ["up", "down", "init", "bootstrap", "faucet"];
if (process.env.HYDRA_RPC && LOCAL_ONLY.includes(cmd)) {
  // Name the spelling the caller actually used — saying "--rpc" at someone who set
  // HYDRA_RPC sends them looking for a flag they never typed.
  const via = rpcAt !== -1 ? "--rpc" : "HYDRA_RPC";
  console.error(`\n  \`hydra-dev ${cmd}\` writes, so it runs against a local stack and cannot take ${via}.`);
  console.error(`  ${via} is for the read commands: tx, blocks, status, devnet, indexer.\n`);
  process.exit(2);
}

function usage() {
  const pad = (s) => s.padEnd(18);
  console.log(`
  hydra-dev — local STRK20 privacy stack

  Interactive
    hydra-dev                 open the TUI
    hydra-dev bootstrap       install node dependencies (run this first)
    hydra-dev up              start devnet + pool + local discovery service
    hydra-dev down            stop a running stack
    hydra-dev init dapp       scaffold the STRK20 starter kit against this stack
    hydra-dev lint <path>     flag STRK20 configurations that disclose more than intended
    hydra-dev leak <tx.json>  disclosure set for a planned tx — takes network: mainnet
                              also: --example shield|private-transfer|shadow-dapp-call

  Status — every one of these takes --json for agents
${Object.entries(COMMANDS).map(([n, c]) => `    ${pad("hydra-dev " + n)}  ${c.help}`).join("\n")}

  Examples
    hydra-dev indexer --status --json
    hydra-dev faucet --address 0x34ba… --amount 1e18
    hydra-dev tx 0x07f1…

  Read commands take --rpc <url> (or HYDRA_RPC) to address any Starknet node:
    hydra-dev tx 0x… --rpc https://api.cartridge.gg/x/starknet/mainnet
  Write commands — up, down, init, bootstrap, faucet — refuse it.

  HYDRA_UPSTREAM   path to a starknet-privacy checkout
  HYDRA_RPC        read commands address this node instead of the local stack
  HYDRA_HOME       where the running stack records itself (default ~/.hydra)
`);
}

if (cmd === undefined || cmd === "tui") {
  // A fresh clone has no node_modules. Say so plainly instead of printing a
  // module-resolution stack trace at someone who just cloned the repo.
  const { missingDeps } = await import("./bootstrap.mjs");
  const missing = missingDeps();
  if (missing.length) {
    console.error(`\n  dependencies not installed: ${missing.map((m) => "packages/" + m).join(", ")}`);
    console.error("  run:  hydra-dev bootstrap\n");
    process.exit(1);
  }
  const { start } = await import("../../tui/src/app.mjs");
  await start();
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  usage();
} else if (cmd === "up") {
  if (!report(check())) {
    console.error("  environment incomplete — fix the above, then rerun `hydra-dev up`\n");
    process.exit(1);
  }
  const { up } = await import("./up.mjs");
  await up();
} else if (cmd === "bootstrap") {
  const { bootstrap } = await import("./bootstrap.mjs");
  process.exit(bootstrap(args.filter((a) => !a.startsWith("--"))) ? 0 : 1);
} else if (cmd === "down") {
  const { stopStack } = await import("../../core/src/stack.mjs");
  const r = await stopStack();
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else console.log(r.ok ? `\n  signalled ${r.killed.join(", ") || "nothing"}\n` : `\n  ${r.reason}\n`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === "init") {
  const { initDapp } = await import("./init.mjs");
  process.exit((await initDapp(args)) ? 0 : 1);
} else if (cmd === "leak" && args.length && !(args[0] in LEAK_ACTIONS)) {
  // `hydra-dev leak <action>` reports a declared shape under the LOCAL stack's config,
  // which omits `network` and so can never describe mainnet. A tx.json can declare
  // `network: "mainnet"`, and packages/leak already ships the reader and three mainnet
  // examples — it just had no entry point, because its `bin` sits in a nested
  // `private: true` manifest npm does not read on install. Same defect as `hydra-lint`
  // had, in the other half of the product. ERRORS.md E-DEV17.
  //
  // Delegated rather than re-implemented, for the reason `lint` is: one copy of the
  // report rendering, the exit codes and the UNKNOWN vocabulary.
  process.argv = [process.argv[0], process.argv[1], ...args];
  await import("../../leak/src/cli.mjs");
} else if (cmd === "lint") {
  // The linter resolves `typescript` from its own directory, so an uninstalled
  // linter is a missing package rather than a broken import path.
  const { missingDeps } = await import("./bootstrap.mjs");
  if (missingDeps().includes("linter")) {
    console.error("\n  linter dependencies not installed");
    console.error("  run:  hydra-dev bootstrap linter\n");
    process.exit(2);
  }
  if (args.length === 0) {
    console.error("  usage: hydra-dev lint <file-or-dir>... [--json]");
    process.exit(2);
  }
  // Hand the linter's own entry point the argv it expects. Reusing it rather
  // than re-implementing keeps one copy of the severity ordering, the exit
  // codes and the "no findings is not a privacy claim" disclaimer.
  process.argv = [process.argv[0], process.argv[1], ...args];
  await import("../../linter/src/cli.mjs");
} else if (COMMANDS[cmd]) {
  // `--status` is accepted and ignored: these commands only report status, but
  // agents reach for the flag, and rejecting it would be pedantry.
  const result = await runCommand(cmd, args);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n" + COMMANDS[cmd].render(result) + "\n");
  }
  process.exit(result?.ok === false || result?.error ? 1 : 0);
} else {
  console.error(`  unknown command: ${cmd}`);
  usage();
  process.exit(2);
}
