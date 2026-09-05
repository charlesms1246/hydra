/**
 * What the resident client says before it has a screen.
 *
 * **THE IDENTITY PAGE TELLS A USER TO RUN `hydra lock`, AND DOING THAT MADE THE TUI CRASH.**
 * `main.ts` called `load()` at module top level, so a locked state file threw and Node printed a
 * file path, a source excerpt, a caret and five stack frames. The sentence saying what to do was in
 * there, between the excerpt and the frames.
 *
 * The CLI has handled this since it existed. The TUI had not — **the same defect as
 * `ensureFromBlock` living in `cli.ts` and never being called from here**, and the third instance
 * of that shape found in one day. `front-end-parity.test.ts` asserts the shared-module cases; this
 * one covers startup, which happens before any of that file's surfaces exist.
 *
 * REAL PROCESSES, because the defect was in what a process printed and died with. It runs the real
 * CLI to make and lock a state, then runs the real TUI against it. `openState()` deliberately sits
 * ABOVE the "needs a terminal" guard in `main.ts`, so this reaches it without a pty.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "..", "cli", "src", "cli.ts");
const TUI = join(HERE, "..", "..", "tui", "src", "main.ts");

/** Run a client entry point and give back everything it said and the code it left with. */
function run(script: string, args: string[], env: Record<string, string>) {
  try {
    const out = execFileSync("node", [script, ...args],
      { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("A LOCKED STATE FILE IS A SENTENCE, NOT A STACK TRACE", () => {
  const home = mkdtempSync(join(tmpdir(), "hydra-lock-"));
  try {
    // `--from-block 1` so `init` does not go looking for a deployment block on a node that is not
    // there; this test is about startup, and a ten-second connect timeout is not its business.
    const made = run(CLI, ["init", "--contract", "0x1", "--from-block", "1"], { HYDRA_HOME: home });
    assert.equal(made.code, 0, `init failed:\n${made.out}`);

    const locked = run(CLI, ["lock", "--i-have-written-the-phrase-down"],
      { HYDRA_HOME: home, HYDRA_PASSPHRASE: "correct horse battery staple" });
    assert.equal(locked.code, 0, `lock failed:\n${locked.out}`);

    // The thing a user does next: start the resident client, having done what it told them to.
    const started = run(TUI, [], { HYDRA_HOME: home, HYDRA_PASSPHRASE: "" });

    assert.match(started.out, /is locked\. Set HYDRA_PASSPHRASE to open it/,
      `the TUI did not say why it would not start:\n${started.out}`);
    assert.ok(!started.out.includes("at load ("),
      `the TUI died with a stack trace, so the sentence explaining what to do is buried between a `
      + `source excerpt and five stack frames:\n${started.out}`);
    assert.ok(!/^\s*\^/m.test(started.out),
      `the TUI printed a source excerpt and a caret at a user:\n${started.out}`);
    assert.ok(!started.out.includes("Node.js v"),
      `the TUI crashed rather than exited:\n${started.out}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("AND AN UNLOCKED ONE GETS PAST STARTUP to the terminal check", () => {
  // The other half: this must not have turned every startup into a refusal. With no tty the TUI
  // is expected to reach its own "needs a terminal" guard, which sits BELOW `openState()`.
  const home = mkdtempSync(join(tmpdir(), "hydra-open-"));
  try {
    const made = run(CLI, ["init", "--contract", "0x1", "--from-block", "1"], { HYDRA_HOME: home });
    assert.equal(made.code, 0, `init failed:\n${made.out}`);
    const started = run(TUI, [], { HYDRA_HOME: home });
    assert.match(started.out, /needs a terminal/,
      `an unlocked state did not reach the terminal check, so startup refuses something it `
      + `should open:\n${started.out}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
