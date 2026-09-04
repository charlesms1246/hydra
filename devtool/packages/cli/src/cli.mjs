#!/usr/bin/env node
/**
 * hydra-dev — one entry point for the local STRK20 stack.
 *
 * Two audiences, one implementation. A developer runs `hydra-dev` for the TUI; an
 * agent runs `hydra-dev indexer --status --json` and parses the result. Both go
 * through COMMANDS in agentcmds.mjs, so they can never report different things.
 */

import { check, report } from "./doctor.mjs";
import { COMMANDS, runCommand } from "./agentcmds.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1);
const asJson = argv.includes("--json");

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

  Status — every one of these takes --json for agents
${Object.entries(COMMANDS).map(([n, c]) => `    ${pad("hydra-dev " + n)}  ${c.help}`).join("\n")}

  Examples
    hydra-dev indexer --status --json
    hydra-dev faucet --address 0x34ba… --amount 1e18
    hydra-dev tx 0x07f1…

  HYDRA_UPSTREAM   path to a starknet-privacy checkout
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
