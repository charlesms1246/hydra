/**
 * `save()` wrote through one temporary path shared by every process on the machine.
 *
 * **THE COMMENT WAS TRUE ABOUT READERS AND THE SECOND WRITER ARRIVED LATER.** `state.ts` says the
 * write goes via a temporary file and a rename so that *"a reader sees the old file or the new one
 * and never a half of either"* — and that is exactly right, for readers, against the failure it was
 * written for, which is one process interrupted mid-write. It reasons about nobody else writing.
 *
 * With two processes on one `HYDRA_HOME` the atomicity works against the user: writer A is partway
 * through `writeFileSync` on the shared temporary path when writer B **renames that same file into
 * place**. The rename is atomic and publishes bytes that were already partial, so `load()` refuses
 * the result — correctly, and the user has a state file they cannot open and no identity behind it.
 * The same contention crashes the loser, because `chmodSync` and `renameSync` at the end of `save`
 * name a path another process has already renamed away: ENOENT, out of the one function every front
 * end calls to save, as a stack of Node internals.
 *
 * Driven concurrently against two real `hydra` processes by another lane; **the number of torn
 * files they measured is a contention rate under a hammer and not a production rate, and it is
 * partly the crash hiding the corruption** — a process that dies on `chmod` is a process that did
 * not go on to publish a partial file. Neither number belongs in this file. What belongs here is
 * the property, asserted where it is deterministic: two writers must not name one path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const CLI = join(ROOT, "packages", "cli", "src", "cli.ts");

const OTHER = "PARTIAL BYTES FROM ANOTHER WRITER, MID-WRITE, NOT VALID JSON {{{";

test("A SAVE DOES NOT WRITE THROUGH A PATH ANOTHER PROCESS IS USING", async () => {
  const home = await mkdtemp(join(tmpdir(), "hydra-tmp-path-"));
  try {
    await run("node", ["--experimental-strip-types", CLI, "init", "--contract", "0x1",
      "--from-block", "1"], { env: { ...process.env, HYDRA_HOME: home } });

    // **A SECOND WRITER, STOPPED MID-`writeFileSync`.** Its bytes are on disk under the temporary
    // name it chose and it has not renamed yet. Planting the file is the deterministic stand-in
    // for the instant the real race happens in; what is asserted below is not the timing but the
    // thing that makes the timing matter, which is whether our save touches a name it did not
    // create.
    const theirs = join(home, "state.json.writing");
    await writeFile(theirs, OTHER, { mode: 0o600 });

    // An ordinary save, through the same function every front end calls.
    const script = join(home, "save-once.ts");
    await writeFile(script, `import { load, save } from ${JSON.stringify(
      join(ROOT, "packages", "cli", "src", "state.ts"))};\nsave(load());\n`);
    await run("node", ["--experimental-strip-types", script],
      { env: { ...process.env, HYDRA_HOME: home } });

    // The other writer's file is untouched: same bytes, still there, still its own.
    await assert.doesNotReject(stat(theirs),
      "our save renamed another process's in-progress temporary file into place. Those bytes were "
      + "half of a state; the file the user now has is unopenable and their identity is behind it");
    assert.equal(await readFile(theirs, "utf8"), OTHER,
      "our save wrote over another process's in-progress temporary file, so whichever of us "
      + "renames second publishes a mixture neither of us wrote");

    // And ours went through: a per-writer path must not cost the write it exists to protect.
    const saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as
      { seedHex?: string };
    assert.ok(saved.seedHex, "the save did not produce a readable state");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("A SAVE THAT THROWS DOES NOT LEAVE THE ROOT KEY IN A TEMPORARY FILE", async () => {
  // **THE COST OF THE FIX ABOVE, PAID.** The shared path had one accidental virtue: a temporary
  // left behind by a dead process was overwritten by the next save, so at most one ever existed.
  // Per-writer names accumulate — and `state-versioning.test.ts` says what each one is, *"a second
  // copy of the root key sitting beside the first"*. A unique name without cleanup trades a
  // corruption for a pile of seeds in a directory, which is not a trade worth making quietly.
  //
  // Driven through a real failing `rename`, because the success path deletes nothing: it renames
  // the temporary away, so a test that only saves successfully cannot tell whether the `finally`
  // is there at all.
  const home = await mkdtemp(join(tmpdir(), "hydra-tmp-throw-"));
  try {
    // A directory where the state file goes, so `renameSync` fails after the bytes are written.
    await mkdir(join(home, "state.json"));

    const script = join(home, "save-onto-a-directory.ts");
    await writeFile(script,
      `import { init } from ${JSON.stringify(join(ROOT, "packages", "cli", "src", "commands.ts"))};\n`
      + `import { save } from ${JSON.stringify(join(ROOT, "packages", "cli", "src", "state.ts"))};\n`
      + `save(init({ vaultUrl: "http://127.0.0.1:1", contract: "0x1", fromBlock: 1 }));\n`);
    await assert.rejects(
      run("node", ["--experimental-strip-types", script],
        { env: { ...process.env, HYDRA_HOME: home } }),
      "the save succeeded, so this test never reached the failure it exists for");

    const left = (await readdir(home)).filter((f) => f.startsWith("state.json.writing"));
    assert.deepEqual(left, [],
      "a failed save left its temporary behind, and that file is a copy of the root key and every "
      + "message, at rest, under a name nothing will ever overwrite");
  } finally { await rm(home, { recursive: true, force: true }); }
});
