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
import { UPSTREAM_REPO, UPSTREAM_SHA, INSTALL_HINTS } from "./pins.mjs";
import { discoverOperations, runOperation } from "../../core/src/toolchain.mjs";

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
 * The build artifacts, from the operations the toolchain module already derives.
 *
 * Only ops whose artifact is absent, so a second `up` does not rebuild a working tree. No prompt:
 * these compile source already on the disk with tools the user has agreed to have, and they are
 * what `up` needs to do anything at all.
 */
export async function ensureBuilds() {
  const dir = upstreamPath();
  const todo = discoverOperations(dir)
    .filter((op) => op.group === "build" && op.artifact && !existsSync(join(dir, op.artifact)));
  if (!todo.length) return { ok: true, did: "already built" };
  for (const op of todo) {
    console.log(`\n  building ${op.label} — ${op.cmd}`);
    /*
     * ⚠ AWAITED. `runOperation` returns a Promise; a synchronous call spawns the build and
     * returns immediately, so `r.ok` is `undefined` rather than `false` and a failure is
     * indistinguishable from a success. The first version did exactly that: all five builds
     * started, `prepare()` returned before any finished, and `up` then reported six missing
     * artifacts it had just been told to create. Caught only by running the three steps end to
     * end on a fresh clone — every smaller test passed, because the failure is in the waiting.
     */
    const r = await runOperation(op, dir, (line) => process.stdout.write(`    ${line}\n`));
    if (!r?.ok) return { ok: false, why: `build failed: ${op.id} (${r?.verdict?.text ?? "no result"})` };
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
