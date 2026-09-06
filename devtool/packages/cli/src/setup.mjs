/**
 * What `hydra-dev up` does before it can bring a stack up: the checkout, the toolchain, the builds.
 *
 * Every one of these already existed as something a user had to do by hand after reading a hint.
 * `doctor.mjs` has held the exact upstream clone command as a STRING since it was written —
 * `git clone ${UPSTREAM_REPO} <dir> && git -C <dir> checkout ${UPSTREAM_SHA}` — and printed it for
 * somebody to copy. `toolchain.mjs` `discoverOperations` derives every build op including the
 * `--ignore-cairo-version` case, and the TUI runs them behind one keypress. **The machinery was
 * written and it was behind the steps.** This drives the same functions from the CLI.
 *
 * ## WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not install a Cairo toolchain for you. That is the tool's stated position and it is not
 * squeamishness: `scarb`, `snforge`, `starknet-devnet` and `cargo` install by piping a remote
 * script into a shell, and a program that does that on your behalf because you typed `up` has made
 * a decision that was yours. So a missing tool is a QUESTION, with the command shown first.
 *
 * ## The three rules the prompting follows
 *
 * **One question per install, never a blanket yes.** Five downloads behind one prompt is consent
 * nobody gave. `ask()` is called once per tool, in sequence.
 *
 * **Say what it will do before doing it.** Each prompt prints the exact command that will run and
 * where it fetches from, so "yes" is answering a specific question. This matches what `up`'s own
 * confirm already does when it admits it cannot be cancelled.
 *
 * **Non-interactive must work and must never assume yes.** With no TTY — CI, an agent, a pipe —
 * `ask()` returns false and the caller reports what is missing and exits. `--yes` is the way to
 * consent in advance, and it has to be typed. **A TTY check that treats "no terminal" as consent
 * is how a build machine ends up running an installer nobody approved.**
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";

import { check, upstreamPath } from "./doctor.mjs";
import { UPSTREAM_REPO, UPSTREAM_SHA, INSTALL_HINTS, ARTIFACTS, BUILD_HINTS } from "./pins.mjs";

/**
 * Ask, or refuse.
 *
 * Returns **false** when there is no terminal, never true. The whole point of the flag is that
 * consent is typed once, somewhere a person can see it, rather than inferred from the absence of a
 * keyboard.
 */
export async function ask(question, { yes = false } = {}) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

const run = (cmd, args, cwd) =>
  spawnSync(cmd, args, { cwd, stdio: "inherit" }).status === 0;

/**
 * The upstream checkout, at the pin.
 *
 * Clones when absent. When present at the wrong revision it says so and offers the fetch — which
 * is only detectable because the `upstream checkout` doctor row compares rather than counts; it
 * used to mark any checkout `[ok  ]` and leave two hex strings for a human to eyeball.
 */
export async function ensureUpstream({ yes = false } = {}) {
  const dir = upstreamPath();
  const at = () => {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim().slice(0, 12) : null;
  };

  if (!existsSync(join(dir, "Scarb.toml"))) {
    console.log(`\n  the pool source is not here yet. It is a separate repository:`);
    console.log(`      git clone ${UPSTREAM_REPO} ${dir}`);
    console.log(`      git -C ${dir} checkout ${UPSTREAM_SHA}`);
    console.log(`  About 40MB from github.com. Nothing is built yet.`);
    if (!await ask("  clone it?", { yes })) return { ok: false, why: "no pool source" };
    if (!run("git", ["clone", UPSTREAM_REPO, dir])) return { ok: false, why: "clone failed" };
    if (!run("git", ["-C", dir, "checkout", UPSTREAM_SHA])) return { ok: false, why: "checkout failed" };
    return { ok: true, did: "cloned" };
  }

  const head = at();
  if (head === UPSTREAM_SHA.slice(0, 12)) return { ok: true, did: "already at the pin" };
  console.log(`\n  the checkout is at ${head ?? "an unknown revision"}, the pin is ${UPSTREAM_SHA.slice(0, 12)}.`);
  console.log(`      git -C ${dir} fetch origin && git -C ${dir} checkout ${UPSTREAM_SHA}`);
  console.log("  This stack is version-fragile; a different revision is why builds fail oddly.");
  if (!await ask("  move it to the pin?", { yes })) return { ok: false, why: `checkout at ${head}` };
  if (!run("git", ["-C", dir, "fetch", "origin"])) return { ok: false, why: "fetch failed" };
  if (!run("git", ["-C", dir, "checkout", UPSTREAM_SHA])) return { ok: false, why: "checkout failed" };
  return { ok: true, did: "moved to the pin" };
}

/**
 * The pinned tools, one question each.
 *
 * Reads the doctor's own rows rather than re-deriving what is missing, so this cannot disagree
 * with what `hydra-dev doctor` prints. A row that is `WARN` — present but the wrong version — is
 * reported and NOT offered an install: overwriting somebody's toolchain because it drifted is a
 * larger decision than installing one they do not have.
 */
export async function ensureToolchain({ yes = false } = {}) {
  const missing = check().filter((r) => r.status === "MISS" && INSTALL_HINTS[r.name]);
  const drifted = check().filter((r) => r.status === "WARN" && INSTALL_HINTS[r.name]);
  for (const r of drifted) {
    console.log(`\n  ${r.name} is ${r.got}, the pin is ${r.want}. Left alone — replacing a`);
    console.log("  toolchain you already have is your call, not this command's.");
  }
  const failed = [];
  for (const r of missing) {
    console.log(`\n  ${r.name} is not installed. The documented way to get it:`);
    console.log(`      ${INSTALL_HINTS[r.name]}`);
    console.log("  That fetches and runs an installer from the vendor's own site.");
    if (!await ask(`  run it?`, { yes })) { failed.push(r.name); continue; }
    if (!run("sh", ["-c", INSTALL_HINTS[r.name]])) failed.push(r.name);
  }
  return failed.length ? { ok: false, why: `still missing: ${failed.join(", ")}` } : { ok: true };
}

/**
 * The build artifacts, driven from the doctor's OWN remedies.
 *
 * Reads `ARTIFACTS`/`BUILD_HINTS` — the same pair `hydra-dev doctor` prints as the fix for each
 * missing row — so this cannot build a different set from the one the doctor then checks.
 *
 * It used `discoverOperations` first, which was the wrong source and failed in a way only an
 * end-to-end run showed: that function derives the **Cairo and Rust** operations by walking the
 * workspace manifests, and two of the six artifacts are npm builds (`cd sdk && npm ci && npm run
 * build`, and the same for `client`) that it does not and should not know about. So `up` built
 * four of six, reported success, and then failed its own doctor check on `sdkDist` and
 * `clientDist` — having never attempted them. `testToken` missed for a related reason: its
 * remedy is three `scarb build`s in three separate non-workspace projects, which is a shell
 * command rather than an operation.
 *
 * No prompt: these compile source already on the disk with tools the user has agreed to have, and
 * they are what `up` needs to do anything at all. `npm ci` inside the checkout fetches from the
 * public registry, which is the one thing here that reaches the network — named in the log line
 * before it runs, for the same reason the toolchain prompts name their downloads.
 */
/** The artifact keys `doctor` currently reports as missing. */
const missingArtifacts = () => new Set(check()
  .filter((r) => r.status === "MISS" && r.name.startsWith("artifact: "))
  .map((r) => r.name.slice("artifact: ".length)));

export async function ensureBuilds() {
  const dir = upstreamPath();
  /*
   * **THIS ASKED `existsSync` ITSELF, WHICH IS THE THING THE DOCSTRING ABOVE SAYS IT DOES NOT DO.**
   * It read the same `ARTIFACTS`/`BUILD_HINTS` pair as `doctor` and then re-implemented the
   * presence test — so the two agreed only while they were wrong in the same way. The moment
   * `doctor` learned that `ARTIFACTS` names indexes and samples rather than sets, `up` would have
   * gone on reporting "already built" for a `testToken` whose ekubo and vesu projects were absent,
   * while `doctor` called it MISS. Two answers to one question, from one pair of pins.
   *
   * Reading the rows makes the claim above true rather than aspirational.
   */
  const missing = missingArtifacts();
  const todo = Object.keys(ARTIFACTS).filter((key) => missing.has(key) && BUILD_HINTS[key]);
  if (!todo.length) return { ok: true, did: "already built" };
  for (const key of todo) {
    console.log(`\n  building ${key} — ${BUILD_HINTS[key]}`);
    if (!run("sh", ["-c", BUILD_HINTS[key]], dir)) return { ok: false, why: `build failed: ${key}` };
    // The remedy having exited 0 is not the same as the artifacts existing — a build that succeeds
    // and writes somewhere else is exactly the case `up` then reports as missing. Re-asked through
    // the doctor for the reason above: a check here that was weaker than the one `up` finishes on
    // would pass a build the next step rejects.
    if (missingArtifacts().has(key)) {
      return { ok: false, why: `${key} built without error and its artifacts are still absent` };
    }
  }
  return { ok: true, did: `built ${todo.length}` };
}

/** Everything `up` needs before it can start a stack. Stops at the first refusal. */
export async function prepare({ yes = false } = {}) {
  for (const [what, step] of [
    ["toolchain", () => ensureToolchain({ yes })],
    ["pool source", () => ensureUpstream({ yes })],
    ["builds", () => ensureBuilds()],
  ]) {
    const r = await step();
    if (!r.ok) {
      console.error(`\n  cannot continue — ${what}: ${r.why}`);
      if (!process.stdin.isTTY && !yes) {
        console.error("  There is no terminal to ask on. Re-run with --yes to consent in advance,");
        console.error("  or run `hydra-dev doctor` and follow the commands it prints.");
      }
      return false;
    }
  }
  return true;
}
