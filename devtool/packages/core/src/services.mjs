/**
 * The status view every surface shares: `hydra-dev status`, `hydra-dev <svc> --status`,
 * and the TUI header all call this. One implementation, so they cannot disagree.
 */

import { readState, pidAlive } from "./state.mjs";
import { probeDevnet, probeIndexer } from "./probe.mjs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
/** `.agents/` is repo-wide, not the devtool's — it stays a level above after the split. */
const ROOT = join(REPO, "..");

/** Names of whatever is in a `<name>/SKILL.md` layout under `dir`. */
function skillsIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The third-party bundle `skills-lock.json` pins, if it is pinned at all. */
function pinnedSkills() {
  try {
    return Object.keys(JSON.parse(readFileSync(join(REPO, "skills-lock.json"), "utf8")).skills ?? {}).sort();
  } catch {
    return [];
  }
}

/**
 * MCP and skills are files on disk, not processes — presence is the status.
 *
 * There are two skill sets and they are not the same thing. `packages/skills` holds
 * HYDRA's own, installed by `node packages/skills/install.mjs`; `skills-lock.json`
 * pins a third-party bundle from `welttowelt/strk20-skills`. This used to count only
 * the pinned four, against a hardcoded list, so a machine with all six of HYDRA's own
 * skills installed and none of the third-party ones reported `0/4` — technically true
 * of a set nobody had asked about, and read as "no skills" everywhere it was shown.
 */
export function agentStatus() {
  const mcpServer = join(REPO, "packages", "mcp", "src", "server.mjs");
  const skillsDir = join(ROOT, ".agents", "skills");
  const installed = skillsIn(skillsDir);
  const own = skillsIn(join(REPO, "packages", "skills"));
  const pinned = pinnedSkills();
  const expected = [...new Set([...own, ...pinned])].sort();
  return {
    mcp: { present: existsSync(mcpServer), path: mcpServer },
    skills: {
      installed: installed.filter((s) => expected.includes(s)),
      expected,
      dir: skillsDir,
      own: { available: own, installed: own.filter((s) => installed.includes(s)) },
      thirdParty: { pinned, installed: pinned.filter((s) => installed.includes(s)) },
    },
  };
}

/**
 * What the MCP server exposes, without starting it.
 *
 * `manifest.mjs` has no dependencies precisely so this can read it — importing
 * `server.mjs` would pull in the MCP SDK and zod, which are dependencies of
 * `packages/mcp` alone. Returns null rather than throwing when the package is not
 * there at all: `packages/mcp/` is gitignored, so a fresh clone genuinely has no
 * manifest to read, and "no MCP server here" is a state this must survive.
 *
 * The dynamic import is cached by the loader after the first call, so the 2-second
 * status poll pays for it once.
 */
export async function mcpTools() {
  const f = join(REPO, "packages", "mcp", "src", "manifest.mjs");
  if (!existsSync(f)) return null;
  try {
    const m = await import(pathToFileURL(f).href);
    return Array.isArray(m.TOOLS) ? m.TOOLS : null;
  } catch {
    return null;
  }
}

export async function status() {
  const st = await readState();
  const [devnet, indexer, tools] = await Promise.all([
    probeDevnet(st?.devnetUrl),
    probeIndexer(st?.indexerUrl),
    mcpTools(),
  ]);
  const agents = agentStatus();
  return {
    stack: st ? { startedAt: st.startedAt, poolAddress: st.poolAddress } : null,
    devnet: { ...devnet, pid: st?.devnetPid ?? null, pidAlive: pidAlive(st?.devnetPid) },
    indexer: { ...indexer, pid: st?.indexerPid ?? null, pidAlive: pidAlive(st?.indexerPid) },
    prover: { mode: st?.proving ?? "mock", note: "mock proof provider — no proving service URL needed" },
    agents: { ...agents, mcp: { ...agents.mcp, tools } },
    accounts: st?.accounts ?? [],
    tokens: st?.tokens ?? null,
  };
}
