/**
 * Running a doctor row's fix.
 *
 * These are real shell commands — `curl … | sh`, `cargo build`, `scarb build`.
 * Nothing here runs without an explicit confirmation from the caller, and the
 * exact command is always surfaced first. A tool that silently pipes the
 * internet into a shell is not a tool anyone should install.
 */

import { spawn } from "node:child_process";

/** Rows the tool can actually fix. A row without `cmd` needs a human. */
export function fixable(rows) {
  return rows.filter((r) => r.status.trim() !== "ok" && r.cmd);
}

export function describeFix(row) {
  if (!row) return null;
  if (!row.cmd) {
    return { runnable: false, reason: "no automatic fix — see the hint", hint: row.hint };
  }
  return { runnable: true, cmd: row.cmd, cwd: row.cwd ?? process.cwd() };
}

/**
 * Runs the fix, streaming output through `onLine`. Resolves with the exit code.
 * Uses a login shell so nvm-managed toolchains and ~/.local/bin are on PATH.
 */
export function runFix(row, onLine = () => {}) {
  return new Promise((resolve) => {
    const d = describeFix(row);
    if (!d?.runnable) return resolve({ ok: false, code: null, reason: d?.reason });

    onLine(`$ ${d.cmd}`);
    const child = spawn(d.cmd, {
      shell: true,
      cwd: d.cwd,
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
    });

    const feed = (buf) => {
      for (const line of buf.toString().split("\n")) {
        const t = line.replace(/\r/g, "").trimEnd();
        if (t) onLine(t);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => resolve({ ok: false, code: null, reason: e.message }));
    child.on("close", (code) => resolve({ ok: code === 0, code }));
  });
}
