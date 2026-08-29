/**
 * Tests that check things which can actually be wrong.
 *
 * The live-RPC assertions are deliberately weak about values and strong about shape: a
 * public endpoint being down is not a test failure, but silently reporting a guessed URL
 * where upstream says TODO would be.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { lintConfig, checkEnvironment } from "../src/tools.mjs";
import { NETWORKS, PUBLISHED_CLASS_HASHES, SERVICE_URLS, UNKNOWN, network, feltEq } from "../src/networks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "src", "server.mjs");

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

/* ---------------------------------------------------------------- stdio MCP session */

/** Speaks newline-delimited JSON-RPC to the server over stdio and returns the responses. */
function session(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    const responses = [];
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; stderr: ${stderr.slice(0, 400)}`));
    }, 60_000);

    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        responses.push(JSON.parse(line));
        if (responses.length === requests.filter((r) => r.id !== undefined).length) {
          clearTimeout(timer);
          child.kill();
          resolve(responses);
        }
      }
    });
    child.on("error", reject);
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hydra-test", version: "0" },
  },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

console.log("\nhydra-mcp tests\n");

await test("server starts and answers tools/list with all four tools", async () => {
  const [init, list] = await session([
    INIT,
    INITIALIZED,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  assert.equal(init.result.serverInfo.name, "hydra");
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["check_environment", "lint_config", "pool_state", "resolve_endpoints"]);
});

await test("resolve_endpoints reports both service URLs as UNKNOWN over the wire", async () => {
  const [, call] = await session([
    INIT,
    INITIALIZED,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "resolve_endpoints", arguments: { network: "sepolia" } },
    },
  ]);
  assert.ok(!call.result.isError, `tool errored: ${JSON.stringify(call.result).slice(0, 300)}`);
  const out = JSON.parse(call.result.content[0].text);
  assert.equal(out.provingServiceUrl.value, UNKNOWN);
  assert.equal(out.discoveryServiceUrl.value, UNKNOWN);
  assert.equal(out.poolAddress, NETWORKS.sepolia.pool);
  assert.ok(out.rpc.retired.some((r) => r.host.includes("blastapi")));
  assert.match(out.standingCondition, /auditor can decrypt/i);
});

await test("an unknown network is rejected by the schema, not answered with a guess", async () => {
  const [, call] = await session([
    INIT,
    INITIALIZED,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "resolve_endpoints", arguments: { network: "goerli" } },
    },
  ]);
  assert.ok(call.error || call.result.isError, "expected an error for an unsupported network");
});

/* ------------------------------------------------------------------ data invariants */

await test("no service URL is ever a plausible-looking guess", () => {
  for (const [name, svc] of Object.entries(SERVICE_URLS)) {
    assert.equal(svc.value, UNKNOWN, `${name} must stay UNKNOWN until StarkWare publishes it`);
    assert.doesNotMatch(JSON.stringify(svc.value), /https?:/, `${name} must not carry a URL`);
  }
});

await test("the published pool class hash matches neither deployment (findings/06)", () => {
  for (const [name, net] of Object.entries(NETWORKS)) {
    assert.ok(
      !feltEq(PUBLISHED_CLASS_HASHES.privacyPool, net.recorded.classHash),
      `${name}: recorded class hash unexpectedly equals the published one — if a redeploy ` +
        `made this true, findings/06 needs updating, not this test deleting`
    );
  }
});

await test("the shadow account anonymizer class hash is UNKNOWN, not substituted", () => {
  assert.equal(PUBLISHED_CLASS_HASHES.shadowAccountAnonymizer, UNKNOWN);
});

await test("network() refuses an unknown name", () => {
  assert.throws(() => network("goerli"), /unknown network/);
});

/* --------------------------------------------------- wrappers delegate, not reimplement */

await test("lint_config reports the linter's own finding on its own fixture", () => {
  const out = lintConfig({ path: join(HERE, "..", "..", "linter", "test", "fixtures", "bad-happy-path.ts") });
  const rules = out.findings.map((f) => f.rule);
  assert.ok(rules.includes("HYD001"), `expected HYD001, got ${rules.join(",")}`);
  assert.ok(rules.includes("HYD007"), "the auditor condition must be reported on every pool usage");
});

await test("lint_config on a clean fixture says 'not a privacy claim', not 'safe'", () => {
  const out = lintConfig({ path: join(HERE, "..", "..", "linter", "test", "fixtures", "false-positive-bait.ts") });
  assert.equal(out.findings.length, 0);
  assert.match(out.note, /NOT a privacy claim/);
});

await test("check_environment returns doctor's rows unchanged", () => {
  const out = checkEnvironment();
  assert.ok(out.rows.length > 0);
  assert.ok(out.rows.every((r) => "status" in r && "name" in r && "want" in r && "got" in r));
  assert.ok(out.upstreamPath.endsWith(".upstream"));
});

/* -------------------------------------------------------------------------- skills */

await test("every skill states the auditor condition and cites upstream file:line", () => {
  const dir = join(HERE, "..", "..", "skills");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");
  assert.ok(files.length >= 4, `expected one skill per flow, found ${files.length}`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.match(text, /^---\n/, `${f}: missing frontmatter`);
    assert.match(text, /auditor/i, `${f}: does not mention the auditor`);
    assert.match(
      text,
      /privacy\.cairo:\d+/,
      `${f}: no packages/privacy/src/privacy.cairo:LINE citation — claims must be cited`
    );
    assert.match(text, /UNKNOWN/, `${f}: states nothing as UNKNOWN, which is unlikely to be honest`);
  }
});

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
