/**
 * Two processes reading one state file, each saving, the second silently winning.
 *
 * `decisions/0048`. The in-process lock in `gui/src/serialise.ts` cannot see another process, and
 * `gui/src/main.ts:51` says a second one is expected out loud — *"a user may be running the TUI at
 * the same time."* Two clients load the same state, each add a message, each write the whole file
 * back, and **the second write erases the first user's message along with the cover objects queued
 * for it**, leaving a recipient holding a pointer to a blob nobody will ever upload.
 *
 * **THE REFUSAL IS THE FEATURE AND THE RISK.** A false refusal loses a message exactly as surely as
 * a lost update does, so the second test here is the one that matters most: an ordinary sequence of
 * saves from one holder of a state must not start failing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const CLI = join(ROOT, "packages", "cli", "src", "cli.ts");
const STATE = JSON.stringify(join(ROOT, "packages", "cli", "src", "state.ts"));

async function inHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "hydra-cas-"));
  try {
    await run("node", ["--experimental-strip-types", CLI, "init", "--contract", "0x1",
      "--from-block", "1"], { env: { ...process.env, HYDRA_HOME: home } });
    return await fn(home);
  } finally { await rm(home, { recursive: true, force: true }); }
}

const script = (home: string, body: string) =>
  run("node", ["--experimental-strip-types", "--input-type=module", "--eval",
    `import { load, save } from ${STATE};\n${body}`],
    { env: { ...process.env, HYDRA_HOME: home } });

test("A SECOND PROCESS DOES NOT SILENTLY ERASE THE FIRST ONE'S WRITE", async () => {
  await inHome(async (home) => {
    // Both read before either writes — the interleaving, made deterministic by doing it in one
    // process across two loads. `load` returns a fresh object per call, so these are two holders
    // of the same file exactly as two processes are.
    //
    // **THE FIRST WRITE MUST SURVIVE OR THE SECOND MUST REFUSE.** Silently proceeding is the one
    // outcome that is not allowed, because it is the one nobody can see happening.
    const out = await script(home, `
      const a = load();
      const b = load();
      a.account = "written-by-a";
      save(a);
      b.account = "written-by-b";
      try { save(b); console.log("SAVED"); }
      catch (e) { console.log("REFUSED:" + e.message); }
    `);
    assert.match(out.stdout, /^REFUSED:/,
      "the second process overwrote a state it had never read. Whatever the first one did — a "
      + "message, a spent invite, a sequence number — is gone, and nothing said so");
    assert.match(out.stdout, /changed on disk|another/i,
      "the refusal does not say that something else wrote the file, which is the one fact the "
      + "user needs to know what they lost");
    assert.match(out.stdout, /hydra|again|re-?run|retry/i,
      "the refusal names no remedy, so a user is told they cannot save and not what to do");
    // **AND IT MUST NOT SAY NOTHING HAPPENED.** The caller that hits this most is the resident
    // uploader, not a person: by the time the guard fires, `flush` has already put an object in
    // the vault and spent an invite. "Nothing here has been written" is true of the FILE and reads
    // as true of the world, and the remedy that followed it — do it again — is what spends a
    // second invite for an object the vault already holds.
    assert.match(out.stdout, /state file is unchanged/i,
      "the refusal does not distinguish the file from the world, so a reader takes it to mean "
      + "nothing happened");
    assert.match(out.stdout, /invite|already holds|do not simply repeat/i,
      "the refusal tells the reader to repeat the operation without saying what repeating costs — "
      + "and an invite is the one credential a client cannot obtain more of");
  });
});

test("AN ORDINARY SEQUENCE OF SAVES IS NOT REFUSED", async () => {
  // The failure this fix can introduce, and it costs a user exactly what the bug does. A resident
  // client saves on a timer; a CLI command loads once and may save twice. If holding a state
  // across your own writes starts failing, the cure is the disease.
  await inHome(async (home) => {
    const out = await script(home, `
      const s = load();
      for (let i = 0; i < 5; i++) { s.account = "round-" + i; save(s); }
      console.log("OK:" + load().account);
    `);
    assert.match(out.stdout, /^OK:round-4/,
      "saving twice from one loaded state was refused — the client now refuses its own writes, "
      + "which loses a message as surely as the race did");
  });
});

test("A STATE NOBODY LOADED CAN STILL BE SAVED", async () => {
  // `init` builds a state rather than loading one, and there is no file to compare against. A
  // check that refused here would refuse to create an identity at all.
  await inHome(async (home) => {
    const out = await script(home, `
      const s = load();
      save(s);
      console.log("OK");
    `);
    assert.match(out.stdout, /OK/);
  });
});
