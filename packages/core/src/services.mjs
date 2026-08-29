/**
 * The status view every surface shares: `hydra status`, `hydra <svc> --status`,
 * and the TUI header all call this. One implementation, so they cannot disagree.
 */

import { readState, pidAlive } from "./state.mjs";
import { probeDevnet, probeIndexer } from "./probe.mjs";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");

/** MCP and skills are files on disk, not processes — presence is the status. */
export function agentStatus() {
  const mcpServer = join(REPO, "packages", "mcp", "src", "server.mjs");
  const skillsDir = join(REPO, ".agents", "skills");
  const skills = ["strk20-privacy", "strk20-privacy-sdk", "strk20-wallet-api", "strk20-anonymizer-contracts"];
  return {
    mcp: { present: existsSync(mcpServer), path: mcpServer },
    skills: {
      installed: skills.filter((s) => existsSync(join(skillsDir, s, "SKILL.md"))),
      expected: skills,
      dir: skillsDir,
    },
  };
}

export async function status() {
  const st = await readState();
  const [devnet, indexer] = await Promise.all([
    probeDevnet(st?.devnetUrl),
    probeIndexer(st?.indexerUrl),
  ]);
  return {
    stack: st ? { startedAt: st.startedAt, poolAddress: st.poolAddress } : null,
    devnet: { ...devnet, pid: st?.devnetPid ?? null, pidAlive: pidAlive(st?.devnetPid) },
    indexer: { ...indexer, pid: st?.indexerPid ?? null, pidAlive: pidAlive(st?.indexerPid) },
    prover: { mode: st?.proving ?? "mock", note: "mock proof provider — no proving service URL needed" },
    agents: agentStatus(),
    accounts: st?.accounts ?? [],
    tokens: st?.tokens ?? null,
  };
}
