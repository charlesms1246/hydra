#!/usr/bin/env node
/**
 * hydra — one entry point for the local STRK20 stack.
 *
 * Two audiences, one implementation. A developer runs `hydra` for the TUI; an
 * agent runs `hydra indexer --status --json` and parses the result. Both go
 * through COMMANDS in agentcmds.mjs, so they can never report different things.
 */

import { check, report } from "./doctor.mjs";
import { COMMANDS, runCommand } from "./agentcmds.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1);
const asJson = argv.includes("--json");

function usage() {
  const pad = (s) => s.padEnd(12);
  console.log(`
  hydra — local STRK20 privacy stack

  Interactive
    hydra                     open the TUI
    hydra up                  start devnet + pool + local discovery service
    hydra down                stop a running stack
    hydra init dapp           scaffold the STRK20 starter kit against this stack

  Status — every one of these takes --json for agents
${Object.entries(COMMANDS).map(([n, c]) => `    ${pad("hydra " + n)}  ${c.help}`).join("\n")}

  Examples
    hydra indexer --status --json
    hydra faucet --address 0x34ba… --amount 1e18
    hydra tx 0x07f1…

  HYDRA_UPSTREAM   path to a starknet-privacy checkout
  HYDRA_HOME       where the running stack records itself (default ~/.hydra)
`);
}

if (cmd === undefined || cmd === "tui") {
  const { start } = await import("../../tui/src/app.mjs");
  await start();
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  usage();
} else if (cmd === "up") {
  if (!report(check())) {
    console.error("  environment incomplete — fix the above, then rerun `hydra up`\n");
    process.exit(1);
  }
  const { up } = await import("./up.mjs");
  await up();
} else if (cmd === "down") {
  const { stopStack } = await import("../../core/src/stack.mjs");
  const r = await stopStack();
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else console.log(r.ok ? `\n  signalled ${r.killed.join(", ") || "nothing"}\n` : `\n  ${r.reason}\n`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === "init") {
  const { initDapp } = await import("./init.mjs");
  process.exit((await initDapp(args)) ? 0 : 1);
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
