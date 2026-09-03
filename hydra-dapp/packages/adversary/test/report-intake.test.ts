/**
 * Report intake — the first row of the moderation disclosure table, finally reachable.
 *
 * `report.filed` describes what an operator learns when a report arrives, and until this existed
 * **nothing could file one**: `Reports.file()` had no caller outside its own tests. E-UNREACHABLE
 * for the third time, and the most visible instance — a table opening with an event that could not
 * happen.
 *
 * The loop under test is a stranger's HTTP request becoming a review a human reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { serveIntake, MAX_BODY, MAX_SPOOL_BYTES } from "../../operator/src/intake.ts";
import { MODERATION_OBSERVABLE_IDS } from "../../moderation/src/observations.ts";

const run = promisify(execFile);
const MAIN = resolve(import.meta.dirname, "../../operator/src/main.ts");

async function withIntake<T>(
  fn: (ctx: { url: string; dir: string; spool: string;
    file: (r: unknown) => Promise<Response>;
    operator: (...a: string[]) => Promise<{ stdout: string }> }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hydra-intake-"));
  const spool = join(dir, "reports.spool");
  const { url, server } = await serveIntake(spool);
  try {
    return await fn({
      url, dir, spool,
      file: (r: unknown) => fetch(`${url}/v1/report`, { method: "POST", body: JSON.stringify(r) }),
      operator: (...a: string[]) => run("node", ["--experimental-strip-types", MAIN, ...a,
        "--queue", join(dir, "q.json"), "--spool", spool]),
    });
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
}

test("A STRANGER'S REPORT BECOMES A REVIEW A HUMAN READS", async () => {
  await withIntake(async ({ file, operator }) => {
    const res = await file({ blobId: "pub:abc123", body: "this post publishes my address" });
    assert.equal(res.status, 202);
    // NO HANDLE IS RETURNED. An identifier a reporter could quote back would be a thing to look
    // them up by, and `decisions/0035` §2 keeps nothing to look up.
    const replied = await res.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(replied).sort(), ["filed", "ok"]);

    const ingested = await operator("ingest");
    assert.match(ingested.stdout, /Filed 1 report\./);
    assert.match(ingested.stdout, /1 review now waiting/);
    const shown = await operator("show", "pub:abc123");
    assert.match(shown.stdout, /publishes my address/,
      "the report reached the spool and the queue but not the reviewer");
  });
});

test("AN ENCRYPTED OBJECT IS REFUSED WITH THE REASON, not accepted and dropped", async () => {
  // `decisions/0035` §2: "A reporter who believes they have been heard and has not is worse served
  // than one told the truth." Accepting a report nobody can act on is the failure that looks like
  // success from the outside.
  await withIntake(async ({ file, spool }) => {
    const res = await file({ blobId: "enc:deadbeef", body: "someone sent me something awful" });
    assert.equal(res.status, 422);
    const body = await res.json() as { because?: string };
    assert.match(String(body.because), /nobody but the people in the conversation/);
    // And it says what the reporter CAN do, rather than only what this service cannot.
    assert.match(String(body.because), /blocking and deleting are yours to do/);
    assert.ok(!existsSync(spool), "a refused report was spooled anyway");
  });
});

test("THE SPOOL RECORDS NOTHING ABOUT WHO SENT IT", async () => {
  // The two-world property `no-accounts` is held to everywhere else, applied to the newest
  // surface: the operator SEES a connection — that is why `report.connection` is on the
  // disclosure table — but what they KEEP must not carry it.
  await withIntake(async ({ file, spool, url }) => {
    await file({ blobId: "pub:one", body: "a report" });
    const written = await readFile(spool, "utf8");
    const line = JSON.parse(written.trim()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(line).sort(), ["at", "blobId", "body"]);
    for (const trace of ["127.0.0.1", "::1", url, "user-agent", "remoteAddress"]) {
      assert.ok(!written.toLowerCase().includes(trace.toLowerCase()),
        `the spool contains ${trace}, which is something about the sender`);
    }
  });
});

test("the connection a reporter makes is on the disclosure table", () => {
  // Rule 4: a capability whose exposure is undocumented is unfinished. `report.filed` was written
  // before intake existed and says a reporter identity is "deliberately absent" — true of the
  // RECORD and not of the socket. A table describing the record rather than the observer
  // under-claims, which is the dangerous direction.
  assert.ok(MODERATION_OBSERVABLE_IDS.includes("report.connection"),
    "intake terminates a stranger's connection and no row says so");
});

test("a report too long to be one is refused, and never held", async () => {
  await withIntake(async ({ file, spool }) => {
    assert.equal((await file({ blobId: "pub:x", body: "x".repeat(MAX_BODY + 1) })).status, 413);
    // Refused while READING, not after: a body is not held in order to discover it is too big.
    assert.equal((await file({ blobId: "pub:x", body: "x".repeat(MAX_BODY * 3) })).status, 413);
    assert.ok(!existsSync(spool), "an over-long report was spooled");
    // The boundary itself, so the check is not off by one in the permissive direction.
    assert.equal((await file({ blobId: "pub:x", body: "x".repeat(MAX_BODY) })).status, 202);
  });
});

test("nothing but a well-formed report is accepted", async () => {
  await withIntake(async ({ file, url }) => {
    for (const bad of [{ blobId: "pub:x" }, { body: "no id" }, { blobId: "pub:x", body: "" },
      { blobId: "pub:x", body: "   " }, { blobId: 7, body: "wrong type" }]) {
      assert.equal((await file(bad)).status, 400, `${JSON.stringify(bad)} was accepted`);
    }
    assert.equal((await fetch(`${url}/v1/report`, { method: "POST", body: "not json" })).status, 400);
    // And nothing else on the service answers. It does one thing.
    assert.equal((await fetch(`${url}/v1/report`)).status, 404);
    assert.equal((await fetch(`${url}/v1/pub/anything`)).status, 404);
  });
});

test("INGEST SAVES BEFORE IT CLEARS, so a failure loses nothing", async () => {
  // The ordering that matters. Clearing first and then failing to save discards reports a
  // reporter was told had been filed — and nothing would ever know they existed.
  await withIntake(async ({ file, spool, dir, operator }) => {
    await file({ blobId: "pub:keepme", body: "must survive a failed ingest" });
    // A queue path that cannot be written: `save` throws, and the spool must still be there.
    const readOnly = join(dir, "locked");
    await writeFile(readOnly, "");
    await chmod(readOnly, 0o400);
    await assert.rejects(() => run("node", ["--experimental-strip-types", MAIN, "ingest",
      "--queue", join(readOnly, "q.json"), "--spool", spool]));
    assert.ok(existsSync(spool), "ingest cleared the spool despite failing to save the queue");
    assert.match(await readFile(spool, "utf8"), /must survive/);
    // And a real ingest afterwards still gets it.
    await operator("ingest");
    assert.match((await operator("show", "pub:keepme")).stdout, /must survive/);
  });
});

test("one unreadable line does not discard the reports behind it", async () => {
  // The spool is appended to by a public endpoint, so a truncated last line is what a crash
  // mid-append looks like. Refusing the whole file would let one bad line destroy every real
  // report after it — and the count is reported rather than swallowed.
  await withIntake(async ({ file, spool, operator }) => {
    await file({ blobId: "pub:first", body: "before the corruption" });
    await writeFile(spool, `${await readFile(spool, "utf8")}{"blobId":"pub:trunc","bo\n`,
      { flag: "w" });
    await file({ blobId: "pub:last", body: "after the corruption" });

    const ingested = await operator("ingest");
    assert.match(ingested.stdout, /Filed 2 reports\. Skipped 1 unreadable line\./);
    assert.match((await operator("show", "pub:last")).stdout, /after the corruption/);
  });
});

test("A FULL SPOOL REFUSES RATHER THAN FILLING THE DISK", async () => {
  // `decisions/0035` bounds the QUEUE structurally — one review per object, so ten thousand
  // reports against one post make one review. That does not bound the SPOOL, which is pre-dedup
  // and grows with the adversary's effort. An unbounded file on the operator's disk is the
  // flooding attack succeeding one stage earlier than the design looked for it.
  await withIntake(async ({ file, spool, operator }) => {
    await writeFile(spool, Buffer.alloc(MAX_SPOOL_BYTES + 1, 0x20));
    const res = await file({ blobId: "pub:x", body: "arriving at a full spool" });
    assert.equal(res.status, 503, "intake kept writing to a spool past its cap");
    // Refusing is the lesser harm and it is honest: a 503 tells a reporter to come back, where
    // filling the disk stops the service for everyone including the operator.
    assert.match(String((await res.json() as { error: string }).error), /try again later/);
    // And an operator who runs `ingest` is never near it — the cap is a backstop, not a policy.
    await operator("ingest");
    assert.ok(!existsSync(spool), "ingest left the full spool in place");
    assert.equal((await file({ blobId: "pub:x", body: "after ingest" })).status, 202);
  });
});

test("the limiter applies to reporting, and refuses rather than dropping", async () => {
  // Per-peer limiting is the SECONDARY defence in `0035` §2 and adds no new disclosure — it turns
  // on `rate.peerBucket`, which is already on the vault's table. The primary defence is structural
  // and needs no reporter identity, which is why this is a configuration choice and not a default.
  const dir = await mkdtemp(join(tmpdir(), "hydra-intake-rl-"));
  const spool = join(dir, "reports.spool");
  const { url, server } = await serveIntake(spool, 0,
    { rateLimit: { mode: "per-peer", perMinute: 2 } });
  try {
    const send = () => fetch(`${url}/v1/report`,
      { method: "POST", body: JSON.stringify({ blobId: "pub:x", body: "a report" }) });
    assert.equal((await send()).status, 202);
    assert.equal((await send()).status, 202);
    const third = await send();
    assert.equal(third.status, 429, "the limiter let a third report through in the same window");
    // A refusal, not a silent drop: a reporter who is rate limited is told, because one who
    // believes they have been heard and has not is worse served than one told the truth.
    assert.match(String((await third.json() as { error: string }).error), /too many requests/);
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});
