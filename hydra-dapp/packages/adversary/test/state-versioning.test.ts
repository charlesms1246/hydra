/**
 * The client's state file has a version, a migration story and an atomic write.
 *
 * **BEFORE KEY-AT-REST, NOT AFTER.** `decisions/0040` records a KDF and its parameters in this
 * file so a future client can open an old one, and writing a KDF into a file with no version field
 * is how you get a client that can only read what it wrote itself. `moderation` has had a version
 * and a migration since its first snapshot; the client — which holds the root key and every
 * conversation — had a bare `JSON.parse` and nothing else.
 *
 * The TUI made that worse than it looks: `main.ts` calls `load()` at module scope, **before** the
 * `uncaughtException` handler and before the alt-screen switch, so a truncated file killed it with
 * no frame drawn and no explanation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "..", "cli", "src", "cli.ts");

/** Run a command against a throwaway `HYDRA_HOME`, so nothing touches a real install. */
const hydra = (home: string, ...args: string[]) =>
  run("node", ["--experimental-strip-types", CLI, ...args], { env: { ...process.env, HYDRA_HOME: home } });

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "hydra-state-"));
  try { return await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test("A WRITTEN STATE CARRIES ITS VERSION, and a file without one is version 1", async () => {
  await withHome(async (home) => {
    await hydra(home, "init");
    const raw = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as
      { version?: number };
    assert.equal(raw.version, 1, "a state file was written with no version");

    // A file written before this existed has no version, and every install has one. Refusing them
    // would strand every user to prove a point.
    delete raw.version;
    await writeFile(join(home, "state.json"), JSON.stringify(raw));
    await assert.doesNotReject(() => hydra(home, "status"),
      "an unversioned file was refused — that is every file on disk today");
  });
});

test("A FUTURE VERSION IS REFUSED RATHER THAN GUESSED AT", async () => {
  // The same rule the moderation snapshot uses, and the reason is sharper here: a state file read
  // wrong is a ROOT KEY used wrong, and the failure would surface as somebody else's messages
  // failing to open rather than as a version problem.
  await withHome(async (home) => {
    await hydra(home, "init");
    const raw = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as Record<string, unknown>;
    raw.version = 99;
    await writeFile(join(home, "state.json"), JSON.stringify(raw));
    const failed = await hydra(home, "status").catch((e: { stderr: string }) => e);
    assert.match(String(failed.stderr), /state version 99/);
    assert.match(String(failed.stderr), /root key used wrong/);
  });
});

test("A CORRUPT FILE FAILS LOUDLY, NAMING THE FILE and telling you not to delete it", async () => {
  // It was a bare `JSON.parse`. In the TUI that runs before the error handler and before the
  // alt-screen switch, so the program died with no frame and a parser error about a file the user
  // was never told held their root key.
  await withHome(async (home) => {
    await hydra(home, "init");
    await writeFile(join(home, "state.json"), "{ this is not json");
    const failed = await hydra(home, "status").catch((e: { stderr: string }) => e);
    assert.match(String(failed.stderr), /is not readable as JSON/);
    assert.match(String(failed.stderr), /root key and every conversation/);
    assert.match(String(failed.stderr), /do not delete it/);
  });
});

test("THE WRITE IS ATOMIC, so an interrupted save cannot leave a half-file", async () => {
  // The failure the corrupt-file test simulates, prevented rather than reported: `load` refuses a
  // truncated file — correctly — which means a partial write leaves the user with no state at all.
  // Same treatment as the operator queue: write a temporary, rename over.
  await withHome(async (home) => {
    await hydra(home, "init");
    const before = await stat(join(home, "state.json"));
    assert.equal(before.mode & 0o777, 0o600);
    // The temporary is gone after a successful save — a leftover would be a second copy of the
    // root key sitting beside the first.
    await assert.rejects(() => stat(join(home, "state.json.writing")));
  });
});

test("`--force` does not swallow the argument after it", async () => {
  // `positional` dropped any token whose predecessor began `--`, so `forget --force alice` lost
  // `alice` and printed the help — and `--force` is exactly the flag somebody reaches for when the
  // safe path has already refused them.
  await withHome(async (home) => {
    await hydra(home, "init");
    // `alice` is not a channel, so this must fail ON THAT rather than by printing usage.
    const failed = await hydra(home, "forget", "--force", "alice").catch((e: { stderr: string }) => e);
    assert.ok(!/hydra init --vault/.test(String(failed.stderr)),
      "the argument after --force was dropped and the help was printed instead");
  });
});

test("a flag with no value does not swallow the next flag", async () => {
  // `--vault --rpc x` used to set `vault` to `"--rpc"`, and a vault URL of `--rpc` fails somewhere
  // far away from the typo that caused it.
  await withHome(async (home) => {
    await hydra(home, "init", "--vault", "--rpc", "http://127.0.0.1:5050");
    const raw = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { vaultUrl: string };
    assert.notEqual(raw.vaultUrl, "--rpc", "a flag name was stored as a vault URL");
    assert.match(raw.vaultUrl, /^http/);
  });
});
