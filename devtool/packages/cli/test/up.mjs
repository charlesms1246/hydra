/**
 * `hydra-dev up` must refuse to start a second stack over a first.
 *
 * Nothing stopped it. Both ports are chosen by BINDING a free one, so the second `up`
 * does not collide, does not error, and looks normal — then overwrites state.json, after
 * which `down` kills the second stack and reports success while the first one's devnet,
 * discovery service and key-holding control API keep running unrecorded.
 *
 * Driven as a real process because that is the only way to observe `process.exit(2)`, and
 * with a stub node rather than a devnet because the refusal happens before `up()` touches
 * anything. The second case is the one that matters as much: a stale state.json from a
 * crashed stack must NOT block `up`, which is why the guard probes instead of trusting the
 * file.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UP = join(HERE, "..", "src", "up.mjs");

let failed = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (e) {
    console.log(`FAIL  ${name}  — ${e.message}`);
    failed++;
  }
};

/** Answers the two calls probeDevnet makes, and nothing else. */
function stubNode() {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { id, method } = JSON.parse(body || "{}");
      const result = method === "starknet_chainId" ? "0x534e5f5345504f4c4941"
        : method === "starknet_blockNumber" ? 42 : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

/** Run `up()` in its own process, so its exit code is observable. */
function runUp(home, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `const { up } = await import(${JSON.stringify(UP)}); await up();`], {
      env: { ...process.env, HYDRA_HOME: home, HYDRA_RPC: "", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const HOME = mkdtempSync(join(tmpdir(), "hydra-up-"));
const NOWHERE = mkdtempSync(join(tmpdir(), "hydra-noupstream-"));
const { srv, url } = await stubNode();

await check("a second `up` is refused, and names the stack already running", async () => {
  writeFileSync(join(HOME, "state.json"),
    JSON.stringify({ devnetUrl: url, startedAt: "2026-09-05T00:00:00.000Z", poolAddress: "0x1" }));
  const { code, out } = await runUp(HOME, { HYDRA_UPSTREAM: NOWHERE });
  if (code !== 2) throw new Error(`exit ${code}, expected 2 — output: ${out.trim().slice(0, 200)}`);
  if (!out.includes("already running")) throw new Error(`no refusal in output: ${out.trim().slice(0, 200)}`);
  if (!out.includes(url)) throw new Error("refusal does not name the running devnet");
  if (!out.includes("hydra-dev down")) throw new Error("refusal does not name the remedy");
  return "exit 2, names the devnet and the remedy";
});

await check("a stale state file does NOT block `up`", async () => {
  // The devnet in state.json is gone. That is the half-dead stack you restart.
  await new Promise((r) => srv.close(r));
  const { code, out } = await runUp(HOME, { HYDRA_UPSTREAM: NOWHERE });
  if (out.includes("already running")) throw new Error("refused on a state file whose devnet does not answer");
  if (code === 0) throw new Error("expected up() to proceed and then fail on the empty upstream");
  return "proceeded past the guard, then failed on the empty upstream";
});

rmSync(HOME, { recursive: true, force: true });
rmSync(NOWHERE, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall up checks passed");
process.exit(failed ? 1 : 0);
