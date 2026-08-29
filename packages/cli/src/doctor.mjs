/**
 * Verifies the environment against the pins. Reports every problem at once rather
 * than failing on the first, because a developer fixing a toolchain wants the whole
 * list. Says nothing about privacy — that is the linter's job.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PINS, NODE_MIN_MAJOR, INSTALL_HINTS, ARTIFACTS, BUILD_HINTS, UPSTREAM_SHA, UPSTREAM_REPO, GOTCHAS } from "./pins.mjs";

const OK = "ok  ";
const BAD = "MISS";
const WARN = "WARN";

function version(cmd, match) {
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.match(match)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function upstreamPath() {
  return process.env.HYDRA_UPSTREAM ?? join(process.cwd(), "..", "..", "..", ".upstream");
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
    console.log("\n  Version drift — the stack may still work, but this is unverified:");
    for (const r of drifted) console.log(`    ${r.name}: want ${r.want}, got ${r.got}`);
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
