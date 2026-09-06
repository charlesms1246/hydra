/**
 * Verifies the environment against the pins. Reports every problem at once rather
 * than failing on the first, because a developer fixing a toolchain wants the whole
 * list. Says nothing about privacy — that is the linter's job.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactsPackage } from "./artifacts.mjs";
import { PINS, NODE_MIN_MAJOR, INSTALL_HINTS, ARTIFACTS, BUILD_HINTS, CAIRO_TARGETS, UPSTREAM_SHA, UPSTREAM_REPO, GOTCHAS } from "./pins.mjs";

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
 * That breaks `hydra-dev up` before devnet is ever spawned. `starknet-devnet`'s npm wrapper
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
      "       `networkingMode=mirrored`. `hydra-dev up` handles it: it chooses devnet's port by\n" +
      "       binding instead of by connecting. The cost is a slower first readiness poll,\n" +
      "       because starknet-devnet's own health check waits out its 30s HTTP timeout once\n" +
      "       before devnet answers. Set networkingMode=NAT and `wsl --shutdown` if you want\n" +
      "       that back — but it changes how all of WSL reaches Windows services, so it is\n" +
      "       not something this tool should do for you.",
    cmd: null,
  });

  const hasUpstream = existsSync(join(up, "Scarb.toml"));
  /*
   * COMPARED, not merely counted. This row scored `hasUpstream ? OK : BAD` and printed `want`
   * beside `got` — so a checkout at the WRONG revision was marked `[ok  ]` and the comparison was
   * left to a human eyeballing two twelve-character hex strings.
   *
   * The pin exists BECAUSE this stack is version-fragile; a row that names a revision and then
   * does not check it is a guard weaker than the thing it is guarding. `WARN` rather than `BAD`
   * for the same reason the pinned tools above use it at line 94: the checkout is present, it is
   * just not the one that was pinned, and `MISS` would say something untrue about a directory
   * that exists. An unknown revision — a checkout that is not a git repository — is not a pass
   * either, because nothing has been shown to match.
   */
  const at = hasUpstream ? sha(up) : null;
  rows.push({
    status: !hasUpstream ? BAD : at === UPSTREAM_SHA.slice(0, 12) ? OK : WARN,
    name: "upstream checkout",
    want: UPSTREAM_SHA.slice(0, 12),
    got: hasUpstream ? at ?? "unknown" : "not found",
    hint: `git clone ${UPSTREAM_REPO} <dir> && git -C <dir> checkout ${UPSTREAM_SHA}\n       then set HYDRA_UPSTREAM=<dir>`,
    // Needs a destination and an env var the tool cannot choose for the user.
    cmd: null,
  });

  /*
   * The optional prebuilt package, and a MISMATCH IS A FAILURE rather than a note.
   *
   * Absent is fine and is not a row worth alarming about — `up` builds from source, which is the
   * supported path and always was. **Present at a different revision is not fine.** Those files
   * declare classes the checkout's own source does not produce, and nothing downstream would
   * notice: the build hints would see artifacts present and skip, and the first symptom would be a
   * `DECLARE` failing several steps later or an address derived from the wrong class hash.
   *
   * `BAD`, not the `WARN` the checkout row uses. There, a human chose a revision and this tool
   * declines to overwrite their choice. Here nobody chose: a package simply does not match the
   * source beside it.
   */
  const pkg = artifactsPackage();
  rows.push({
    // Absent is `OK` because the package is genuinely optional and `up` builds without it. Present
    // at the wrong revision is `BAD` — see the header of `artifacts.mjs` for why that is a failure
    // and not a note.
    status: !pkg || pkg.matches ? OK : BAD,
    name: "artifacts package",
    want: pkg ? UPSTREAM_SHA.slice(0, 12) : "optional",
    got: !pkg
      ? "not installed — up builds the Cairo from source"
      : pkg.matches
        ? `${pkg.files.length} files at ${pkg.upstreamSha.slice(0, 12)}`
        : `built from ${pkg.upstreamSha?.slice(0, 12) ?? "an unreadable manifest"}`,
    /*
     * **UNCONDITIONAL, AND THE ROW COUNT IS THE SMALLER REASON.** A row emitted only when the
     * package happens to be installed makes the table a different length for different users, and
     * `README.md` states its length as a number that `guards.mjs` enforces — so a conditional row
     * would be correct for whoever ran it last and wrong for everyone else.
     *
     * The better reason is what the absent case says. A first-time user watching `up` compile
     * Cairo for ten to fifteen minutes has no way to learn that a package exists which skips it.
     * A row that says so is the only place they would find out.
     */
    hint: pkg && !pkg.matches
      ? "the prebuilt artifacts are from a different upstream revision than the pin.\n"
        + "       Update or remove @hydra/artifacts; `up` builds from source without it."
      : "optional. `@hydra/artifacts` holds the Cairo build outputs for the pinned revision,\n"
        + "       so `up` copies them instead of spending 10-15 minutes in `scarb build`.",
    cmd: null,
  });

  if (hasUpstream) {
    for (const [key, rel] of Object.entries(ARTIFACTS)) {
      const cairo = CAIRO_TARGETS[key];
      const found = cairo ? cairoArtifacts(up, cairo) : null;
      const missing = cairo ? found.missing : existsSync(join(up, rel)) ? [] : [rel];
      rows.push({
        status: missing.length === 0 ? OK : BAD,
        name: `artifact: ${key}`,
        want: cairo ? `${found.expected} files` : "built",
        // The COUNT and the first missing name. A bare "missing" sent a reader to a build hint
        // without telling them whether one class or a whole Scarb project was absent.
        got: missing.length === 0
          ? cairo ? `${found.expected} present` : "present"
          : `${missing.length} missing, e.g. ${missing[0]}`,
        hint: `(in ${up}) ${BUILD_HINTS[key]}`,
        cmd: BUILD_HINTS[key],
        cwd: up,
      });
    }
  }

  return rows;
}

/**
 * Every file a Cairo key's builds should have produced, and which of them are absent.
 *
 * **READ FROM THE INDEXES RATHER THAN FROM A LIST.** `*.starknet_artifacts.json` is Scarb's own
 * manifest of what it wrote: each entry names a `sierra` and usually a `casm` file beside it. So
 * this asks the build what it produced and then checks the tree for it, which covers a class that
 * did not exist when this was written. See `CAIRO_TARGETS` in `pins.mjs` for what is declared and
 * what is derived, and why that split is the fix rather than a longer list.
 *
 * **A MISSING `target/dev` IS A MISS, NOT AN EMPTY ANSWER.** This is the case that made the old
 * check wrong: with all of `e2e/contracts/ekubo/target/dev` gone there are no indexes to read, and
 * "no indexes found" must not resolve to "nothing missing". Each declared root that yields no
 * index is reported as the missing thing itself, which is why the return carries a root's own path
 * rather than a file inside it.
 */
function cairoArtifacts(up, { roots, test }) {
  const missing = [];
  let expected = 0;
  for (const root of roots) {
    const dir = join(up, root, "target", "dev");
    let indexes = [];
    try {
      indexes = readdirSync(dir).filter((f) =>
        f.endsWith(".starknet_artifacts.json") && f.includes(".test.") === test);
    } catch {
      // The directory itself is absent. Nothing to enumerate and nothing to conclude from that.
    }
    if (indexes.length === 0) {
      missing.push(join(root, "target", "dev"));
      continue;
    }
    for (const index of indexes) {
      expected++;
      let contracts = [];
      try {
        contracts = JSON.parse(readFileSync(join(dir, index), "utf8")).contracts ?? [];
      } catch {
        // An index that cannot be parsed is an index that proves nothing about the files it names.
        missing.push(join(root, "target", "dev", index));
        continue;
      }
      for (const c of contracts) {
        for (const file of Object.values(c.artifacts ?? {})) {
          if (!file) continue;   // `casm` is null when the target did not emit one.
          expected++;
          if (!existsSync(join(dir, file))) missing.push(join(root, "target", "dev", file));
        }
      }
    }
  }
  return { expected, missing };
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
