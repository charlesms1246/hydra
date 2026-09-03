/**
 * The moderator's tool, driven end to end — the surface whose absence the audit found.
 *
 * `decisions/0035` designed eight moderation steps and `moderation/src` had no callers outside its
 * own tests, so every one of them was a library call with no way to perform it. Proving the
 * library works is not proving the pipeline is operable: that is E-UNREACHABLE's lesson one level
 * up, and it is why this file spawns the real binary rather than importing its functions.
 *
 * The queue must also SURVIVE THE PROCESS. A tool that forgets between invocations reproduces the
 * defect it was written to fix, and nothing in a single-process test would notice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Vault, PUBLIC_ENDPOINT } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { removalAuthorityFromFile } from "../../vault-server/src/authority.ts";
import { publish, wireBytes } from "../../vault-client/src/blobs.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { Reports } from "../../moderation/src/reports.ts";
import { save } from "../../operator/src/queue.ts";

const run = promisify(execFile);
const MAIN = resolve(import.meta.dirname, "../../operator/src/main.ts");
const SECRET = "a-long-enough-operator-secret";

const operator = (dir: string, ...argv: string[]) =>
  run("node", ["--experimental-strip-types", MAIN, ...argv, "--queue", join(dir, "q.json")]);

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hydra-operator-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("A REPORT SURVIVES INTO A DECISION ACROSS SEPARATE PROCESSES", async () => {
  await withDir(async (dir) => {
    // Intake, written by whatever files reports — the tool reads a queue, it does not receive.
    const q = new Reports();
    q.file("pub:abc", "this impersonates me", Date.UTC(2026, 8, 1));
    q.file("pub:abc", "and it is still up", Date.UTC(2026, 8, 2));
    save(join(dir, "q.json"), q);

    const listed = await operator(dir, "queue");
    assert.match(listed.stdout, /pub:abc/);
    assert.match(listed.stdout, /2 reports/, "the review's report count did not survive the file");

    // What a reviewer is shown, INCLUDING the caveat. A count that arrives without its limit
    // reads as weight of numbers while carrying none — `no-accounts` means fifty reports may be
    // one adversary with a loop, and a reviewer under time pressure reads it as corroboration.
    const shown = await operator(dir, "show", "pub:abc");
    assert.match(shown.stdout, /this impersonates me/);
    assert.match(shown.stdout, /and it is still up/, "the second distinct body was dropped");
    assert.ok(/not|cannot|may be/i.test(shown.stdout),
      `the report count was shown without its caveat:\n${shown.stdout}`);

    // A DECISION IS NOT A REMOVAL, and the tool says so rather than implying the post is gone.
    const decided = await operator(dir, "decide", "pub:abc", "removed", "impersonation");
    assert.match(decided.stdout, /still on the vault/i,
      "recording a decision implied the object had been taken down");

    // A THIRD process sees it. This is the clause a single-process test cannot make.
    const after = await operator(dir, "queue");
    assert.match(after.stdout, /Nothing waiting/);
    const report = await operator(dir, "report", "2026-09");
    assert.match(report.stdout, /impersonation \/ removed: fewer than 5/,
      `the decision did not reach the transparency report:\n${report.stdout}`);
  });
});

test("THE STORED QUEUE HOLDS NO BODY FOR A DECIDED OBJECT", async () => {
  // The retention property the store's own comment claims, checked against the bytes on disk
  // rather than the API. A report body is what a stranger wrote about someone; it is kept exactly
  // as long as a human still has to read it, and `decide` drops it. `DECISIONS-NEEDED.md` D8.
  await withDir(async (dir) => {
    const q = new Reports();
    q.file("pub:gone", "a body that must not outlive the review", 1);
    q.file("pub:kept", "a body that is still needed", 2);
    save(join(dir, "q.json"), q);
    await operator(dir, "decide", "pub:gone", "kept", "harassment");

    const onDisk = await readFile(join(dir, "q.json"), "utf8");
    assert.ok(!onDisk.includes("must not outlive"),
      `a decided object's report body is still in the queue file:\n${onDisk}`);
    assert.ok(onDisk.includes("still needed"), "an OPEN review lost its body, which is the point");
    // And the decision record kept the minimum and nothing else.
    const decided = JSON.parse(onDisk).decided as Record<string, unknown>[];
    assert.deepEqual(Object.keys(decided[0]).sort(), ["at", "blobId", "category", "outcome"]);
  });
});

test("A CORRUPT QUEUE IS REFUSED RATHER THAN STARTED FROM EMPTY", async () => {
  // The failure that silently discards a queue of real reports. Starting empty is the friendly
  // behaviour and it destroys the thing the tool exists to protect.
  await withDir(async (dir) => {
    await writeFile(join(dir, "q.json"), "{ this is not json");
    await assert.rejects(() => operator(dir, "queue"), /not readable as a queue|Refusing/);
  });
});

test("THE TOOL PERFORMS A REAL TAKEDOWN AGAINST A REAL VAULT", async () => {
  await withDir(async (dir) => {
    const tokenFile = join(dir, "removal.token");
    await writeFile(tokenFile, `${SECRET}\n`);
    const post = publish(new TextEncoder().encode("a public statement"),
      { confirmedPublicAt: "2026-09-03T00:00:00Z", reason: "operator tool test" });

    const vault = new Vault({ invites: [], buckets: BUCKETS });
    const { url, server } = await serve(vault, 0,
      { removalToken: removalAuthorityFromFile(tokenFile) });
    try {
      await fetch(`${url}${PUBLIC_ENDPOINT}/${post.id}`,
        { method: "PUT", body: wireBytes(post) as unknown as Uint8Array });
      assert.equal(vault.observe().rows.length, 1, "the post did not store");

      const done = await operator(dir, "remove", post.id, "--vault", url,
        "--removal-token-file", tokenFile);
      assert.match(done.stdout, /Removed/);
      assert.equal(vault.observe().rows.length, 0, "the tool reported a removal that did not happen");

      // A wrong secret fails, and the message does not claim to know which failure it was — the
      // vault answers 404 for both, on purpose, so that probing ids reveals nothing.
      await writeFile(join(dir, "wrong.token"), "a-different-operator-secret");
      const refused = await operator(dir, "remove", post.id, "--vault", url,
        "--removal-token-file", join(dir, "wrong.token")).catch((e: { stdout: string }) => e);
      assert.match(refused.stdout, /refused \(404\)/);
      assert.match(refused.stdout, /does not distinguish/);
    } finally { server.close(); }
  });
});

test("the tool refuses to remove without an authority, rather than trying and failing", async () => {
  await withDir(async (dir) => {
    await assert.rejects(() => operator(dir, "remove", "pub:x", "--vault", "http://127.0.0.1:1"),
      /removal-token-file/);
    // And a short secret never becomes an authority, so it cannot reach the network at all.
    await writeFile(join(dir, "weak.token"), "short");
    await assert.rejects(() => operator(dir, "remove", "pub:x", "--vault", "http://127.0.0.1:1",
      "--removal-token-file", join(dir, "weak.token")), /guessable/);
  });
});

test("A REPORT BODY CANNOT REDRAW THE REVIEWER'S SCREEN", async () => {
  // Hostile input arriving at a terminal, which is what a report body IS: written by a stranger,
  // read by an operator. ANSI escapes move the cursor, recolour, clear the screen and overwrite
  // the lines above — so an attacker who can emit them can make one object's reports appear under
  // another object's id, and the reviewer decides on what they were shown.
  await withDir(async (dir) => {
    const q = new Reports();
    const attack = "\u001b[2J\u001b[H" + "pub:innocent has no reports" + "\u0007\r";
    q.file("pub:hostile", attack, 1);
    q.file("pub:hostile", "a plain one", 2);
    save(join(dir, "q.json"), q);

    const shown = await operator(dir, "show", "pub:hostile");
    // No raw escape reaches the terminal.
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(shown.stdout),
      "a control character from a report body reached the terminal unescaped");
    // Replaced rather than dropped: a reviewer seeing <1b> learns the body contained one, which a
    // silently cleaned string hides. The readable part still arrives.
    assert.match(shown.stdout, /<1b>/, "escapes were removed silently instead of being shown");
    assert.match(shown.stdout, /pub:innocent has no reports/);
    assert.match(shown.stdout, /a plain one/);
  });
});

test("THE BODIES A REVIEWER NEEDS ARE ACTUALLY SHOWN, which they were not", async () => {
  // `summarise`'s doc says "what a reviewer is shown" and it printed a count, a caveat and the
  // decision history — no bodies. Everything behind BODIES_KEPT — keeping 32, deduplicating by
  // DISTINCT body, the whole argument about an adversary who floods first owning the framing —
  // exists to put the right text in front of a human, and nothing displayed it. Found by building
  // the tool, which is the same way the pipeline's missing surface was found.
  await withDir(async (dir) => {
    const q = new Reports();
    // The framing attack, exactly as `reports.ts` describes it: a frivolous report first, the
    // genuine one after. Both must reach the reviewer or the dedup design achieves nothing.
    q.file("pub:framed", "i just don't like it", 1);
    for (let i = 0; i < 50; i++) q.file("pub:framed", "i just don't like it", 2 + i);
    q.file("pub:framed", "it publishes my home address", 60);
    save(join(dir, "q.json"), q);

    const shown = await operator(dir, "show", "pub:framed");
    assert.match(shown.stdout, /publishes my home address/,
      "the genuine report did not reach the reviewer — the flood owned the framing");
    assert.match(shown.stdout, /52 reports/, "the volume was not shown");
    // And the flood occupies ONE slot, because dedup is by distinct body.
    assert.equal(shown.stdout.match(/i just don't like it/g)?.length, 1,
      "a repeated body was shown more than once, so a loop can still fill the reviewer's screen");
  });
});
