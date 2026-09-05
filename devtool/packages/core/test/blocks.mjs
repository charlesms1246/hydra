/**
 * `latestBlocks(n)` must refuse an `n` it cannot count with.
 *
 * The loop reads `top - n`, and `Number("abc")` is NaN: `Math.max(-1, NaN)` is NaN, `b > NaN`
 * is false, zero iterations, `{ available: true, blocks: [] }`. The CLI renderer joins that
 * empty array and prints the EMPTY STRING with exit 0 — indistinguishable from a chain with no
 * blocks, on a healthy chain with blocks in it. `Number("")` is 0 and does the same, and `?? 8`
 * never fires for an empty string, so `export HYDRA_BLOCKS=` was enough.
 *
 * The happy path is tested against a stub node in the same file, because a guard that refused
 * everything would pass every test above it.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "..", "cli", "src", "cli.mjs");
const HOME = mkdtempSync(join(tmpdir(), "hydra-blocks-"));
process.env.HYDRA_HOME = HOME;

const { latestBlocks } = await import("../src/chain.mjs");

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

/** Answers blockNumber and getBlockWithTxHashes, and nothing else. */
function stubNode(head = 100) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body || "{}");
      const result =
        method === "starknet_chainId" ? "0x534e5f5345504f4c4941"
        : method === "starknet_blockNumber" ? head
        : method === "starknet_getBlockWithTxHashes"
          ? { block_number: params[0].block_number, block_hash: `0x${params[0].block_number}`, timestamp: 1, transactions: [] }
          : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

for (const bad of ["abc", "", "0", "-1", "2.5", " "]) {
  await check(`refuses HYDRA_BLOCKS=${JSON.stringify(bad)}`, async () => {
    const r = await latestBlocks(bad);
    if (r.available !== false) throw new Error(`available: ${r.available} — a bad count was accepted`);
    // Both fields, and for different consumers: the front ends print `reason`, cli.mjs:147
    // turns `error` into a non-zero exit.
    if (!r.reason || !r.error) throw new Error(`missing reason/error: ${JSON.stringify(r)}`);
    if (!r.reason.includes("HYDRA_BLOCKS")) throw new Error(`does not name the variable: ${r.reason}`);
  });
}

const { srv, url } = await stubNode(100);
writeFileSync(join(HOME, "state.json"), JSON.stringify({ devnetUrl: url, poolAddress: "0x1" }));

await check("a valid count still reads that many blocks", async () => {
  const r = await latestBlocks("3");
  if (!r.available) throw new Error(`unavailable: ${r.reason}`);
  if (r.blocks.length !== 3) throw new Error(`got ${r.blocks.length} blocks, expected 3`);
  if (r.blocks[0].number !== 100) throw new Error("did not start at the head");
  return "3 blocks from head 100";
});

await check("the default is still 8", async () => {
  const r = await latestBlocks();
  if (r.blocks.length !== 8) throw new Error(`got ${r.blocks.length}, expected 8`);
});

// The deliverable: the CLI says so and exits non-zero, rather than printing nothing at exit 0.
await check("`hydra-dev blocks` with a bad HYDRA_BLOCKS exits non-zero and says why", async () => {
  const { code, out } = await new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "blocks"], {
      env: { ...process.env, HYDRA_HOME: HOME, HYDRA_BLOCKS: "abc" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
  if (code === 0) throw new Error(`exit 0 — output was ${JSON.stringify(out)}`);
  if (!out.includes("HYDRA_BLOCKS")) throw new Error(`no explanation: ${JSON.stringify(out)}`);
  return `exit ${code}, "${out.trim()}"`;
});

await new Promise((r) => srv.close(r));
rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall block-count checks passed");
process.exit(failed ? 1 : 0);
