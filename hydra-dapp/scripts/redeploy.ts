/**
 * Put the platform's contract on the running devnet, and write the env the live suites need.
 *
 * This existed as prose in `claude-docs/TODO.md`: eight commands to copy out, with an accounts
 * file to hand-assemble in the middle. Prose recipes go stale silently — the addresses in
 * `claude-docs/decisions/0007-live-pool-findings.md` were stale within a day, because devnet
 * seeds a fresh chain on every `hydra up` and nothing regenerated them. A script cannot go
 * stale without failing.
 *
 * It is idempotent in the ways that matter: re-declaring an already-declared class is not an
 * error (the hash is recovered from the message), and the invoke is deterministic — the same
 * fixture as `live-chain.test.ts`, so the event it publishes is the event that test looks for.
 *
 *     cd devtool && node packages/cli/src/cli.mjs up
 *     cd hydra-dapp && npm run redeploy
 *     source ~/.hydra/live-env.sh && npm run test:live
 *
 * Devnet only. It reads predeployed private keys out of the node, which is a thing only a
 * throwaway chain has.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { channelSecret, pointerFor, blobIdFrom } from "../packages/channel/src/pointer.ts";
import { noteCalldata } from "../packages/channel/src/note.ts";
import { commit, contentHashFor } from "../packages/channel/src/commitment.ts";
import { sealForChannel, wireBytes } from "../packages/vault-client/src/blobs.ts";
import { rootSeed, entropyFrom, derive, VAULT_DOMAIN, fromTestVector }
  from "../packages/identity/src/domains.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(HERE, "..", "contracts");
const HYDRA = join(homedir(), ".hydra");
const ACCOUNTS = join(HYDRA, "sncast-accounts.json");
const ENV_FILE = join(HYDRA, "live-env.sh");

type State = {
  devnetUrl: string;
  controlUrl: string;
  poolAddress: string;
  accounts: { name: string; address: string; flows?: boolean }[];
};

const state = JSON.parse(readFileSync(join(HYDRA, "state.json"), "utf8")) as State;
const RPC = state.devnetUrl;

async function rpc(method: string, params: unknown): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function sh(cmd: string, args: string[], cwd = CONTRACTS): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ---------------------------------------------------------------------------
// 1. An sncast accounts file, built from what the node will tell anyone who asks
// ---------------------------------------------------------------------------

type Predeployed = { address: string; public_key: string; private_key: string };

const predeployed = await rpc("devnet_getPredeployedAccounts", []) as Predeployed[];

/**
 * An account nothing else signs for.
 *
 * NOT alice or bob: the control API holds in-process account objects for those and signs with
 * them, and two signers for one address do not see each other's nonces. Running the live suites
 * in parallel failed one run in six with an opaque `starknet_addInvokeTransaction` error, which
 * is exactly how long it takes to stop believing it is a race.
 *
 * NOT admin either — that is the relayer that submits every `executeOutside`.
 *
 * `hydra up` predeploys a third user account for this. If it is missing, the chain came up with
 * an older default and sharing an account would reintroduce the race, so this stops rather than
 * quietly picking alice.
 */
const busy = new Set(state.accounts
  .filter((a) => a.flows || a.name === "admin")
  .map((a) => BigInt(a.address)));
const deployer = predeployed.find((p) => !busy.has(BigInt(p.address)));
if (!deployer) {
  throw new Error(
    "every predeployed account is already driven by the control API or the relayer. "
    + "Bring the stack up with at least three user accounts (HYDRA_ACCOUNTS=3) so direct "
    + "signing has an account to itself.");
}
const classHash = await rpc("starknet_getClassHashAt", ["latest", deployer.address]) as string;

// The network key is sncast's name for the chain id the node reports. Devnet says SN_SEPOLIA.
writeFileSync(ACCOUNTS, JSON.stringify({
  "alpha-sepolia": {
    deployer: {
      address: deployer.address,
      class_hash: classHash,
      deployed: true,
      legacy: false,
      private_key: deployer.private_key,
      public_key: deployer.public_key,
      type: "open_zeppelin",
    },
  },
}, null, 2) + "\n");

const cast = (...args: string[]) =>
  sh("sncast", ["--json", "--accounts-file", ACCOUNTS, "--account", "deployer", ...args]);

// ---------------------------------------------------------------------------
// 2. Build, declare, deploy
// ---------------------------------------------------------------------------

console.log(`deployer ${deployer.address} (not driven by the control API)`);
console.log("scarb build");
sh("scarb", ["build"]);

console.log("declare Channel");
let declared: string;
try {
  const out = cast("declare", "--contract-name", "Channel", "--url", RPC);
  declared = JSON.parse(out.trim().split("\n").filter(Boolean).pop()!).class_hash;
} catch (e) {
  // Already declared is not a failure — a redeploy against a chain that survived the last run
  // should still produce a working stack, and the hash is in the message.
  const text = `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`;
  const found = text.match(/0x0?[0-9a-fA-F]{60,64}/);
  if (!/already declared/i.test(text) || !found) throw new Error(`declare failed:\n${text}`);
  declared = found[0];
  console.log("  (already declared)");
}
console.log(`  class ${declared}`);

console.log("deploy");
const deployOut = cast("deploy", "--class-hash", declared, "--url", RPC);
const channel: string = JSON.parse(deployOut.trim().split("\n").filter(Boolean).pop()!).contract_address;
console.log(`  at ${channel}`);

// ---------------------------------------------------------------------------
// 3. Publish the event `live-chain.test.ts` looks for
// ---------------------------------------------------------------------------

// The same fixture, imported rather than copied. A second definition of these two felts is a
// second thing to keep in step, and the whole point of the test is that they agree.
const chan = channelSecret(
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(11), "live")))),
  "alice→bob",
);
const content = new TextEncoder().encode("a real message, on a real chain");
const blob = sealForChannel(chan, content);
const pointer = pointerFor(chan, blobIdFrom(wireBytes(blob) as unknown as Uint8Array), 0);
const [p, c] = noteCalldata(pointer, commit(42n, contentHashFor(content)));

console.log("invoke privacy_invoke");
cast("invoke", "--contract-address", channel, "--function", "privacy_invoke",
  "--arguments", `${p}, ${c}`, "--url", RPC);
console.log(`  pointer ${p}\n  commitment ${c}`);

// ---------------------------------------------------------------------------
// 4. The env, so nobody has to reassemble it by hand
// ---------------------------------------------------------------------------

writeFileSync(ENV_FILE, [
  "# Written by hydra-dapp/scripts/redeploy.ts. Devnet only; regenerated on every `hydra up`.",
  `export HYDRA_RPC=${RPC}`,
  `export HYDRA_CHANNEL=${channel}`,
  `export HYDRA_CONTROL=${state.controlUrl}`,
  `export HYDRA_POOL=${state.poolAddress}`,
  "",
].join("\n"));

console.log(`\nwrote ${ENV_FILE}\n  source ${ENV_FILE} && npm run test:live`);
