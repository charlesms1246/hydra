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
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "..", "cli", "src", "cli.ts");
const TUI = join(HERE, "..", "..", "tui", "src", "main.ts");
const PHRASE = "correct horse battery staple";

/** Run a command under a pty, sending keystrokes on a clock, and give back everything it printed. */
function inPty(command: string, home: string, keys: { after: number; send: string }[]) {
  return new Promise<string>((resolve) => {
    const child = spawn("script", ["-qec", command, "/dev/null"], {
      env: { ...process.env, HYDRA_HOME: home, TERM: "xterm-256color",
        COLUMNS: "80", LINES: "24", HYDRA_PASSPHRASE: "" },
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    for (const k of keys) setTimeout(() => child.stdin.write(k.send), k.after);
    const stop = setTimeout(() => child.kill("SIGKILL"), 9000);
    child.on("close", () => { clearTimeout(stop); resolve(out.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\r/g, "")); });
  });
}

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
      { HYDRA_HOME: home, HYDRA_PASSPHRASE: PHRASE });
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

/**
 * The passphrase prompt, through a real terminal, with a key pressed afterwards.
 *
 * **THE ASSERTION THAT MATTERS IS THE LAST ONE.** `promptPassphrase` used to read stdin with
 * `for await (const chunk of stdin)` and return from inside the loop — and Node destroys a readable
 * when its async iteration ends early. The CLI never noticed, because it exits and never reads
 * another key. The TUI drew its first frame perfectly and then **ignored every keystroke forever**.
 *
 * A test that checked the prompt returned the right string would have passed. A test that checked a
 * frame was drawn would have passed. Only pressing a key afterwards fails, and only in a pty,
 * because `promptPassphrase` returns `null` immediately when stdin is not a TTY.
 *
 * `script` is how a pty gets allocated without a native dependency. Its flags differ across
 * platforms, so an environment without a working one SKIPS with a reason rather than failing —
 * a skip that says what it did not check is honest; a pass would not be.
 */
test("THE PASSPHRASE PROMPT HANDS THE TERMINAL BACK — a key still works afterwards", async (t) => {
  try {
    execFileSync("script", ["-qec", "true", "/dev/null"], { stdio: "ignore" });
  } catch {
    return t.skip("no util-linux `script`, so no pty: the raw-mode handoff is UNCHECKED here");
  }

  const home = mkdtempSync(join(tmpdir(), "hydra-prompt-"));
  try {
    const made = run(CLI, ["init", "--contract", "0x1", "--from-block", "1"], { HYDRA_HOME: home });
    assert.equal(made.code, 0, `init failed:\n${made.out}`);
    const locked = run(CLI, ["lock", "--i-have-written-the-phrase-down"],
      { HYDRA_HOME: home, HYDRA_PASSPHRASE: PHRASE });
    assert.equal(locked.code, 0, `lock failed:\n${locked.out}`);

    const out = await inPty(`node ${TUI}`, home, [
      // Typed separately and not in one chunk, because that is how a person types: the prompt
      // stops at the newline and anything after it in the SAME chunk is dropped.
      // ABSOLUTE delays from launch, not gaps. The first version read as a sequence and had `q`
      // at 1500 firing before `6` at 2500, so the test failed with the exact message the real
      // defect produces — a caption that was true of the run I meant rather than the run I sent.
      { after: 1200, send: `${PHRASE}\r` },
      { after: 3000, send: "6" },
      { after: 4500, send: "q" },
    ]);

    assert.match(out, /passphrase:/,
      `the TUI did not ask for a passphrase on a locked state:\n${out}`);
    assert.match(out, /HYDRA/, `no frame was drawn after the passphrase:\n${out}`);
    assert.match(out, /f flush now/,
      "pressing 6 did not reach the Status page, so the prompt handed back a terminal the program "
      + `cannot read — a dead keyboard on the first frame, which looks like a hang:\n${out}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
