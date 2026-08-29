#!/usr/bin/env node
import { check, report } from "./doctor.mjs";
import { up } from "./up.mjs";

const cmd = process.argv[2] ?? "help";

if (cmd === "doctor") {
  process.exit(report(check()) ? 0 : 1);
} else if (cmd === "up") {
  if (!report(check())) {
    console.error("  environment incomplete — fix the above, then rerun `hydra up`\n");
    process.exit(1);
  }
  await up();
} else {
  console.log(`
  hydra — local STRK20 privacy stack

    hydra doctor    verify toolchain, upstream checkout and build artifacts
    hydra up        devnet + deployed pool + funded accounts + local discovery service

  HYDRA_UPSTREAM   path to a starknet-privacy checkout (default: ../../../.upstream)
`);
  process.exit(cmd === "help" ? 0 : 2);
}
