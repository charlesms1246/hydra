/**
 * `hydra init dapp` — scaffold the official STRK20 starter kit and point it at
 * whatever stack is running.
 *
 * Scaffolded on demand rather than vendored: it stays current with upstream and
 * hydra does not carry a Next.js tree it did not write. The cost is that this one
 * command needs the network, which is why it is not on the `hydra up` path.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readState } from "../../core/src/state.mjs";

const REPO = "https://github.com/Akashneelesh/strk20-starter-kit";

export async function initDapp(args) {
  const what = args[0];
  if (what !== "dapp") {
    console.error("  usage: hydra init dapp [--dir apps/dapp]");
    return false;
  }
  const i = args.indexOf("--dir");
  const dir = i >= 0 ? args[i + 1] : "apps/dapp";

  if (existsSync(dir)) {
    console.error(`  ${dir} already exists — remove it or pass --dir`);
    return false;
  }

  console.log(`\n  cloning ${REPO} → ${dir}`);
  const r = spawnSync("git", ["clone", "--depth", "1", REPO, dir], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("  clone failed");
    return false;
  }

  const st = await readState();
  const env = st
    ? [
        "# Written by `hydra init dapp` against the stack that was running.",
        `NEXT_PUBLIC_RPC_URL=${st.devnetUrl}`,
        `NEXT_PUBLIC_STRK20_POOL=${st.poolAddress}`,
        `NEXT_PUBLIC_INDEXER_URL=${st.indexerUrl}`,
        `NEXT_PUBLIC_STRK_TOKEN=${st.tokens?.STRK ?? ""}`,
      ]
    : [
        "# No stack was running, so these are unset. Run `hydra up`, then rerun",
        "# `hydra init dapp`, or fill these in yourself.",
        "NEXT_PUBLIC_RPC_URL=",
        "NEXT_PUBLIC_STRK20_POOL=",
        "NEXT_PUBLIC_INDEXER_URL=",
      ];
  await writeFile(join(dir, ".env.local"), env.join("\n") + "\n");

  console.log(`
  scaffolded ${dir}

    cd ${dir} && npm install && npm run dev

  Wrote .env.local${st ? " pointing at the running stack." : " with blanks — no stack was running."}

  Note: the starter kit drives STRK20 through the **Wallet API** — the wallet holds
  the viewing key and does discovery and proving. That is a different route from the
  SDK, and hydra's linter does not see inside it.
`);
  return true;
}
