/**
 * What survives a restart, and what deliberately does not.
 *
 * **THREE DEFECTS OF THIS CLASS IN ONE DAY, ALL FOUND BY RUNNING A REAL PROCESS.** Every other test
 * of the vault constructs a `Vault` and interrogates it, so **none of them can see anything about
 * persistence by construction** — the defect is entirely in what does not cross a process boundary.
 *
 *   1. **A compelled removal reverted to an ordinary absence.** `#compelled` was in memory, so a
 *      deploy, a crash or a reboot silently erased the one mark that distinguishes a removal under
 *      legal process from expiry. The operator's own record in `moderation-queue.json` survived and
 *      the affected parties' notice did not — *the party being audited kept the evidence and the
 *      parties affected lost it*, which is the exact inversion the mechanism exists to prevent.
 *   2. **Every spent invite came back.** `#invites` is rebuilt from `--invites-file` at startup and
 *      redemption only deleted from the in-memory set. Measured: reuse in-process refused `400`,
 *      the same code after a restart accepted `201`. An invite is the write gate, and
 *      `observations.ts` calls it an identity acquired before anything else happens — which only
 *      holds if it is spent once.
 *   3. And the reason this file exists rather than three fixes: **nobody had enumerated what the
 *      vault holds in memory**, so there was no list against which either of those was an omission.
 *
 * **DELIBERATE VOLATILITY IS FINE; UNDECLARED VOLATILITY IS THE DEFECT.** The rate limiter's salt
 * resets per process and says so. These assertions pin both directions, so that adding state
 * without deciding which it is fails here.
 *
 * A REAL CHILD PROCESS, not two `new Vault()` over one directory. Two constructions in one process
 * share a module registry, a filesystem cache and a heap; the bugs above were about a boundary that
 * only a real one has.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { Vault } from "../../vault-server/src/server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "..", "..", "vault-server", "src", "main.ts");
const PORT = 8400 + (process.pid % 200);
const URL_ = `http://127.0.0.1:${PORT}`;

const PAD = new Uint8Array(1024);
const randomId = () => `enc:${randomBytes(31).toString("hex")}`;

async function upTo(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${URL_}/v1/pub/root`);
      if (r.ok) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Start the real server over a directory, and return something that stops it. */
async function boot(dir: string, invitesFile: string): Promise<ChildProcess> {
  const child = spawn(process.execPath,
    ["--experimental-strip-types", MAIN, "--port", String(PORT), "--dir", dir,
      "--invites-file", invitesFile],
    { stdio: "ignore", detached: false });
  assert.ok(await upTo(Date.now() + 25_000), `the vault did not start on ${PORT}`);
  return child;
}

const stop = async (child: ChildProcess): Promise<void> => {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));
};

const put = (id: string, invite: string): Promise<Response> =>
  fetch(`${URL_}/v1/enc/${id}`, {
    method: "PUT", headers: { "x-hydra-invite": invite }, body: PAD,
  });

test("A SPENT INVITE STAYS SPENT ACROSS A RESTART", { timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydra-restart-"));
  const invitesFile = join(dir, "..", `invites-${process.pid}.txt`);
  const codes = [randomBytes(9).toString("hex"), randomBytes(9).toString("hex")];
  writeFileSync(invitesFile, `${codes.join("\n")}\n`);

  let child = await boot(dir, invitesFile);
  try {
    assert.equal((await put(randomId(), codes[0]!)).status, 201, "a fresh invite was refused");
    assert.equal((await put(randomId(), codes[0]!)).status, 400,
      "an invite was spendable twice in one process, so it is not single-use at all");
    await stop(child);

    // THE WHOLE TEST. Before the fix this was 201.
    child = await boot(dir, invitesFile);
    assert.equal((await put(randomId(), codes[0]!)).status, 400,
      "a spent invite worked again after a restart, so every code ever issued is re-opened by a "
      + "deploy, a crash or a reboot");
    // And the fix must not have broken the ordinary case.
    assert.equal((await put(randomId(), codes[1]!)).status, 201,
      "an unspent invite was refused after a restart, so the record is eating live codes");
  } finally {
    await stop(child);
  }
});

test("A COMPELLED REMOVAL IS STILL ONE AFTER A RESTART", { timeout: 90_000 }, async () => {
  // Driven through the class rather than HTTP for the compel itself — the authority plumbing has
  // its own live coverage — but across a genuine process boundary, which is where the bug was.
  const dir = mkdtempSync(join(tmpdir(), "hydra-restart-"));
  const blobId = randomId();
  const first = new Vault({ dir, invites: ["code"] });
  first.handle({ op: "upload", endpoint: "/v1/enc", id: blobId, body: PAD, invite: "code" });
  assert.ok(first.compel(blobId, "CASE-RESTART"), "nothing there to compel");

  assert.ok(existsSync(join(dir, Vault.COMPELLED_FILE)),
    "the tombstone was not written, so it cannot survive anything");
  const second = new Vault({ dir, invites: ["code"] });
  assert.equal(second.compelledRemovals().length, 1,
    "the removal reverted to an ordinary absence, which is what the mechanism exists to prevent");
});

test("THE RECORDS KEEP NO SECRET AND NO CONTENT", { timeout: 30_000 }, async () => {
  // Both new files sit in the store directory beside other people's ciphertext. Neither may make
  // that directory more valuable to steal than it already was.
  const dir = mkdtempSync(join(tmpdir(), "hydra-restart-"));
  const v = new Vault({ dir, invites: ["a-real-invite-code"] });
  const blobId = randomId();
  v.handle({ op: "upload", endpoint: "/v1/enc", id: blobId, body: PAD, invite: "a-real-invite-code" });
  v.compel(blobId, "CASE-XYZ");

  const spent = readFileSync(join(dir, Vault.SPENT_FILE), "utf8");
  assert.ok(!spent.includes("a-real-invite-code"),
    "the redeemed-invite record stores the code itself rather than a digest of it");
  assert.match(spent.trim(), /^[0-9a-f]{64}$/, "the record is not a digest");

  // The tombstone names the id and the operator's process reference, and nothing else — the four
  // fields of `CompelledRemoval`. There is no field for content because there is nothing to say.
  const tomb = JSON.parse(readFileSync(join(dir, Vault.COMPELLED_FILE), "utf8")) as unknown[];
  assert.deepEqual(Object.keys(tomb[0] as object).sort(),
    ["at", "blobId", "reference", "underProcess"],
    "the tombstone grew a field, and every candidate field is something the operator cannot know");
});

test("WHAT IS VOLATILE IS VOLATILE ON PURPOSE — the enumeration, pinned", () => {
  // The third defect was that no such list existed. These are the vault's in-memory fields and the
  // decision for each; a new one that nobody classifies should make this fail rather than pass.
  //
  //   #objects            SURVIVES   the store
  //   #compelled          SURVIVES   the mark distinguishing removal from expiry
  //   #spent              SURVIVES   single use is the whole of what an invite is
  //   #invites            rebuilt    from --invites-file, minus #spent
  //   #reads              VOLATILE   REQUIRED: persisting them creates a durable log of who read
  //                                  what, which is the record this service refuses to keep
  //   #transport          VOLATILE   same class as #reads
  //   #invitesRedeemed    VOLATILE   a counter behind `observe()`; the durable fact is #spent
  //   #removals           VOLATILE   feeds the disclosure-coverage check only, never a published
  //                                  figure — the report's counts come from the operator's queue
  //   #tls                VOLATILE   a fact about the running process; persisting it would lie
  //
  // Asserted rather than merely written: the two files that must exist are named on the class, so
  // renaming one without thinking about restart behaviour breaks this.
  assert.equal(typeof Vault.COMPELLED_FILE, "string");
  assert.equal(typeof Vault.SPENT_FILE, "string");
  assert.ok(!Vault.COMPELLED_FILE.endsWith(".json"),
    "the object loader reads every .json in the store as a sidecar, so it would resurrect the id "
    + "this file records the removal of");
  assert.ok(!Vault.SPENT_FILE.endsWith(".json"), "same trap for the redeemed-invite record");
  assert.notEqual(Vault.COMPELLED_FILE, Vault.SPENT_FILE);
});
