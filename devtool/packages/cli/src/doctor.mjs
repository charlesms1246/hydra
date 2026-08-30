/**
 * Verifies the environment against the pins. Reports every problem at once rather
 * than failing on the first, because a developer fixing a toolchain wants the whole
 * list. Says nothing about privacy — that is the linter's job.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PINS, NODE_MIN_MAJOR, INSTALL_HINTS, ARTIFACTS, BUILD_HINTS, UPSTREAM_SHA, UPSTREAM_REPO, GOTCHAS } from "./pins.mjs";

const OK = "ok  ";
const BAD = "MISS";
const WARN = "WARN";

/**
 * Does an unbound IPv4 loopback port refuse, or blackhole?
 *
 * WSL2 with `networkingMode=mirrored` in `.wslconfig` shares the Windows network
 * namespace, and a connect to a *closed* 127.0.0.1 port is dropped rather than reset —
 * it times out after ~135s instead of returning ECONNREFUSED in a millisecond. (`::1`
 * still refuses correctly, which is why this looks fine until something probes IPv4.)
 *
 * That breaks `hydra up` before devnet is ever spawned. `starknet-devnet`'s npm wrapper
 * picks a port with `isFreePort()`, which connects and accepts a port as free ONLY on
 * ECONNREFUSED — every other error is rethrown (`node_modules/starknet-devnet/dist/util.js`).
 * So `up` dies with `connect ETIMEDOUT 127.0.0.1:6050` and no devnet in sight. 6050 is
 * exactly the port the wrapper tries first (DEFAULT_DEVNET_PORT 5050 + its 1000 step).
 *
 * Probed in a child process so a 135s blackhole cannot hang `doctor` itself.
 */
function loopbackProbe() {
  const probe =
    'const s=require("net").createConnection({port:6050,host:"127.0.0.1"});' +
    's.setTimeout(1200,()=>{s.destroy();process.stdout.write("blackholed")});' +
    's.once("connect",()=>{s.end();process.stdout.write("in use")});' +
    's.once("error",(e)=>{s.destroy();process.stdout.write(e.code)});';
  try {
    return execFileSync(process.execPath, ["-e", probe], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function version(cmd, match) {
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.match(match)?.[1] ?? null;
  } catch {
    return null;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));   // packages/cli/src
const REPO_ROOT = join(HERE, "..", "..", "..");

/**
 * Where the starknet-privacy checkout lives.
 *
 * This used to be cwd-relative and only resolved correctly when run from
 * packages/cli — from the repo root it produced "/private/.upstream". Resolve
 * from the module instead, and try both the in-repo and sibling layouts.
 */
export function upstreamPath() {
  if (process.env.HYDRA_UPSTREAM) return process.env.HYDRA_UPSTREAM;
  const candidates = [join(REPO_ROOT, ".upstream"), join(REPO_ROOT, "..", ".upstream")];
  return candidates.find((c) => existsSync(join(c, "Scarb.toml"))) ?? candidates[0];
}

export function check() {
  const rows = [];
  const up = upstreamPath();

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  rows.push({
    status: nodeMajor >= NODE_MIN_MAJOR ? OK : BAD,
    name: "node",
    want: `>= ${NODE_MIN_MAJOR}`,
    got: process.versions.node,
    hint: "nvm install 24 && nvm use 24",
    // No cmd: switching the node version of the process running this tool is not
    // something the tool can do to itself. The user has to do this one.
    cmd: null,
  });

  for (const [name, pin] of Object.entries(PINS)) {
    const got = version(pin.cmd, pin.match);
    rows.push({
      status: got === null ? BAD : pin.exact === null || got === pin.exact ? OK : WARN,
      name,
      want: pin.exact ?? "any",
      got: got ?? "not found",
      hint: INSTALL_HINTS[name],
      cmd: INSTALL_HINTS[name] ?? null,
      cwd: null,
    });
  }

  // Not a version pin, and no longer fatal — `up()` picks devnet's port itself rather than
  // letting the npm wrapper probe for one (see pinDevnetPort in up.mjs). Still reported,
  // because it is a real property of the machine and it makes startup measurably slower.
  const loopback = loopbackProbe();
  const refuses = loopback === "ECONNREFUSED" || loopback === "in use";
  rows.push({
    status: refuses ? OK : WARN,
    name: "loopback refuses",
    want: "ECONNREFUSED",
    got: loopback,
    hint:
      "An unbound 127.0.0.1 port is blackholed here rather than refused — on WSL2 that is\n" +
      "       `networkingMode=mirrored`. `hydra up` handles it: it chooses devnet's port by\n" +
      "       binding instead of by connecting. The cost is a slower first readiness poll,\n" +
      "       because starknet-devnet's own health check waits out its 30s HTTP timeout once\n" +
      "       before devnet answers. Set networkingMode=NAT and `wsl --shutdown` if you want\n" +
      "       that back — but it changes how all of WSL reaches Windows services, so it is\n" +
      "       not something this tool should do for you.",
    cmd: null,
  });

  const hasUpstream = existsSync(join(up, "Scarb.toml"));
  rows.push({
    status: hasUpstream ? OK : BAD,
    name: "upstream checkout",
    want: UPSTREAM_SHA.slice(0, 12),
    got: hasUpstream ? sha(up) ?? "unknown" : "not found",
    hint: `git clone ${UPSTREAM_REPO} <dir> && git -C <dir> checkout ${UPSTREAM_SHA}\n       then set HYDRA_UPSTREAM=<dir>`,
    // Needs a destination and an env var the tool cannot choose for the user.
    cmd: null,
  });

  if (hasUpstream) {
    for (const [key, rel] of Object.entries(ARTIFACTS)) {
      rows.push({
        status: existsSync(join(up, rel)) ? OK : BAD,
        name: `artifact: ${key}`,
        want: "built",
        got: existsSync(join(up, rel)) ? "present" : "missing",
        hint: `(in ${up}) ${BUILD_HINTS[key]}`,
        cmd: BUILD_HINTS[key],
        cwd: up,
      });
    }
  }

  return rows;
}

function sha(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim().slice(0, 12);
  } catch {
    return null;
  }
}

export function report(rows) {
  console.log("");
  for (const r of rows) {
    console.log(`  [${r.status}] ${r.name.padEnd(24)} want ${String(r.want).padEnd(14)} got ${r.got}`);
  }
  const broken = rows.filter((r) => r.status === BAD);
  const drifted = rows.filter((r) => r.status === WARN);
  if (drifted.length) {
    // Was "Version drift"; the loopback row is the first warning that is not about a version.
    console.log("\n  Warnings — the stack should still work, but this is not the verified setup:");
    for (const r of drifted) {
      console.log(`    ${r.name}: want ${r.want}, got ${r.got}`);
      if (r.hint) console.log(`       ${r.hint}`);
    }
  }
  if (broken.length) {
    console.log("\n  Missing:");
    for (const r of broken) console.log(`    ${r.name}\n       ${r.hint}`);
  }
  if (process.env.HYDRA_QUIET !== "1") {
    console.log("  Known traps (none of these are in upstream's e2e README):");
    for (const g of GOTCHAS) {
      console.log(`    - ${g.replace(/(.{1,88})(\s|$)/g, "$1\n      ").trimEnd()}`);
    }
  }
  console.log("");
  return broken.length === 0;
}
