/**
 * The state file, encrypted with a passphrase — `decisions/0040`.
 *
 * The client used to say its root key was on disk in the clear, that `0600` was the only protection
 * there is, and that it was "not for anyone whose safety depends on it". Its users are sources.
 *
 * **THE WHOLE FILE, NOT THE SEED FIELD**, because the state holds every message as text and nobody
 * is prosecuted for the messages they were going to send. And the property is narrow on purpose:
 * a seized disk, not a running machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { seal, open as openEnvelope, isEnvelope, refusePassphrase, MIN_PASSPHRASE }
  from "../../cli/src/at-rest.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "..", "cli", "src", "cli.ts");
const PHRASE = "seven blue horses in a quiet field";

const hydra = (home: string, env: Record<string, string>, ...args: string[]) =>
  run("node", ["--experimental-strip-types", CLI, ...args],
    { env: { ...process.env, HYDRA_HOME: home, ...env } });

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "hydra-lock-"));
  try { return await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test("A LOCKED FILE CONTAINS NO SEED AND NO MESSAGE TEXT", async () => {
  await withHome(async (home) => {
    await hydra(home, {}, "init");
    const before = await readFile(join(home, "state.json"), "utf8");
    const seed = (JSON.parse(before) as { seedHex: string }).seedHex;
    assert.ok(seed.length > 32, "the fixture has no seed, so this proves nothing");

    await hydra(home, { HYDRA_PASSPHRASE: PHRASE }, "lock", "--i-have-written-the-phrase-down");
    const after = await readFile(join(home, "state.json"), "utf8");
    assert.ok(isEnvelope(JSON.parse(after)), "the file is not an envelope");
    // The check that matters: the seed is not in the bytes on disk, anywhere.
    assert.ok(!after.includes(seed), "the root key is still readable in the locked file");
    assert.ok(!/seedHex/.test(after), "the plaintext structure survived encryption");
  });
});

test("IT OPENS WITH THE PASSPHRASE AND REFUSES WITHOUT IT", async () => {
  await withHome(async (home) => {
    await hydra(home, {}, "init");
    await hydra(home, { HYDRA_PASSPHRASE: PHRASE }, "lock", "--i-have-written-the-phrase-down");

    await assert.doesNotReject(() => hydra(home, { HYDRA_PASSPHRASE: PHRASE }, "status"));

    const wrong = await hydra(home, { HYDRA_PASSPHRASE: "eight blue horses in a field" }, "status")
      .catch((e: { stderr: string }) => e);
    assert.match(String(wrong.stderr), /does not open this state file/);
    // The refusal says there is no recovery, at the moment somebody is looking for one.
    assert.match(String(wrong.stderr), /THERE IS NO RECOVERY/);

    const none = await hydra(home, { HYDRA_PASSPHRASE: "" }, "status")
      .catch((e: { stderr: string }) => e);
    assert.match(String(none.stderr), /is locked/);
  });
});

test("A WRONG PASSPHRASE IS A REFUSAL, NEVER PLAUSIBLE-LOOKING BYTES", () => {
  // GCM's tag is what makes this a refusal. Without it the client would decrypt garbage into a
  // seed and derive a working-looking identity nobody else can talk to — a failure that surfaces
  // as everyone else's messages not opening, which nobody would trace back to a typo.
  const envelope = seal('{"seedHex":"abc"}', PHRASE);
  assert.throws(() => openEnvelope(envelope, `${PHRASE} `), /does not open/);
  assert.equal(openEnvelope(envelope, PHRASE), '{"seedHex":"abc"}');

  // Tampering with the ciphertext is refused too, so a vault-style substitution has no analogue.
  const bent = { ...envelope, ciphertextHex: `00${envelope.ciphertextHex.slice(2)}` };
  assert.throws(() => openEnvelope(bent, PHRASE), /does not open/);
});

test("THE PARAMETERS TRAVEL WITH THE FILE, so it can still be opened next year", () => {
  // A file nobody can open next year is not encrypted, it is lost — which is why state versioning
  // had to land before this. The salt and cost are in the envelope, not compiled into the reader.
  const envelope = seal("hello", PHRASE);
  assert.equal(envelope.version, 2);
  assert.equal(envelope.kdf.name, "scrypt");
  assert.ok(envelope.kdf.N >= 1 << 16, "the cost was lowered without anybody saying so");
  assert.equal(envelope.kdf.saltHex.length, 32);
  // A fresh salt per save: two files under one passphrase share no derived key, so a change to
  // the state cannot be spotted by comparing headers.
  assert.notEqual(seal("hello", PHRASE).kdf.saltHex, envelope.kdf.saltHex);
});

test("LOCKING IS AN OPERATION WITH A NAME AND A CONFIRMATION", async () => {
  // `decisions/0040` §5: forgetting the passphrase destroys every conversation permanently, and
  // that was an OMISSION rather than an operation — invisible to the destructive-operations table
  // by construction, because that table enumerates operations.
  await withHome(async (home) => {
    await hydra(home, {}, "init");
    const refused = await hydra(home, { HYDRA_PASSPHRASE: PHRASE }, "lock")
      .catch((e: { stderr: string }) => e);
    assert.match(String(refused.stderr), /if you forget the/i);
    assert.match(String(refused.stderr), /SECOND\s*\n?\s*COPY OF THE SECRET|second copy of the secret/i);
    // And it did not lock: a warning that acts anyway is not a confirmation.
    const raw = await readFile(join(home, "state.json"), "utf8");
    assert.ok(!isEnvelope(JSON.parse(raw)), "it locked despite refusing to");
  });
});

test("a short passphrase is refused, and the refusal is not a strength meter", () => {
  // A meter tells somebody their guessable phrase is "strong" once it has a digit in it, which is
  // worse than saying nothing. This refuses only what is definitely not a passphrase.
  assert.throws(() => refusePassphrase(""), /empty passphrase/);
  assert.throws(() => refusePassphrase("x".repeat(MIN_PASSPHRASE - 1)), /short enough to enumerate/);
  assert.doesNotThrow(() => refusePassphrase("x".repeat(MIN_PASSPHRASE)));
});

test("AN ORDINARY SAVE NEVER SILENTLY UNLOCKS THE FILE", async () => {
  // The failure that would remove the protection at the moment of a routine write, with nothing
  // said. Every command that saves must keep the file locked.
  await withHome(async (home) => {
    await hydra(home, {}, "init");
    await hydra(home, { HYDRA_PASSPHRASE: PHRASE }, "lock", "--i-have-written-the-phrase-down");
    await hydra(home, { HYDRA_PASSPHRASE: PHRASE }, "rotate");
    const after = await readFile(join(home, "state.json"), "utf8");
    assert.ok(isEnvelope(JSON.parse(after)),
      "an ordinary command wrote the state back in the clear");
  });
});

test("unlocking announces what it removes rather than reporting success", async () => {
  await withHome(async (home) => {
    await hydra(home, {}, "init");
    await hydra(home, { HYDRA_PASSPHRASE: PHRASE }, "lock", "--i-have-written-the-phrase-down");
    const refused = await hydra(home, { HYDRA_PASSPHRASE: PHRASE }, "unlock")
      .catch((e: { stderr: string }) => e);
    assert.match(String(refused.stderr), /back to disk in the clear/);
    await hydra(home, { HYDRA_PASSPHRASE: PHRASE }, "unlock", "--force");
    const after = await readFile(join(home, "state.json"), "utf8");
    assert.ok(!isEnvelope(JSON.parse(after)));
    await writeFile(join(home, "note"), "");
  });
});

test("THE EXPOSURE WINDOW IS STATED, and stated as what it actually is", async () => {
  // `decisions/0040` §1 chose an agent with an idle timeout so the window would be A NUMBER. That
  // is not built, and the interim is an environment variable — which is a LONGER and vaguer window
  // than the design calls for, not a shorter one. Claiming a number we do not have would be worse
  // than admitting the condition we do.
  const { KEY_LOCKED } = await import("../../claims/src/warnings.ts");
  const text = KEY_LOCKED.full.join(" ");
  assert.match(text, /HOW LONG THE KEY IS EXPOSED/);
  assert.match(text, /HYDRA_PASSPHRASE/, "the mechanism actually in use is not named");
  assert.match(text, /visible to anything else running as you/,
    "the environment variable's own exposure is not disclosed");
  assert.match(text, /not built yet/,
    "the client implies it has the agent that decisions/0040 chose, which it does not");
  // And it does not claim the three-case table without the middle row, which is the one people
  // read past: encrypted at rest says nothing about a machine that is running.
  assert.match(text, /device seized while running\s+— NO/);
});

test("THE PASSPHRASE COMES FROM A FILE, not from the shell history", async () => {
  // **THE ENVIRONMENT VARIABLE UNDOES THE PROPERTY IT PROTECTS.** `export HYDRA_PASSPHRASE=…` lands
  // in the shell history — unencrypted, on the same disk as the encrypted state file — so the one
  // threat encryption at rest exists for, a seized disk, would hand over both halves at once.
  //
  // `authority.ts` already carries the argument one mechanism over: "a secret in argv is in the
  // process table and in a shell history". The removal token, the compelled token and the invites
  // all follow it; the client's own passphrase was the last secret that did not.
  await withHome(async (home) => {
    await hydra(home, {}, "init");
    const file = join(home, "phrase");
    await writeFile(file, `${PHRASE}\n`);

    await hydra(home, {}, "lock", "--i-have-written-the-phrase-down", "--passphrase-file", file);
    const raw = await readFile(join(home, "state.json"), "utf8");
    assert.ok(isEnvelope(JSON.parse(raw)), "--passphrase-file did not lock the state");

    // And it opens with the file, with no environment variable anywhere.
    await assert.doesNotReject(() => hydra(home, {}, "status", "--passphrase-file", file));
  });
});

test("the environment variable still works and says what it costs", async () => {
  // Kept for scripting, and treated the way `--invites` was: not removed, told the truth about.
  await withHome(async (home) => {
    await hydra(home, {}, "init");
    const file = join(home, "phrase");
    await writeFile(file, PHRASE);
    await hydra(home, {}, "lock", "--i-have-written-the-phrase-down", "--passphrase-file", file);

    const { stderr } = await hydra(home, { HYDRA_PASSPHRASE: PHRASE }, "status");
    assert.match(stderr, /shell history/,
      "reading the passphrase from the environment said nothing about where it ends up");
    assert.match(stderr, /same disk as the file/);
    assert.match(stderr, /--passphrase-file/, "the warning does not name the better option");
  });
});
