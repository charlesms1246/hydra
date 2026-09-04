/**
 * The whole moderation pipeline, driven once against a REAL posted object.
 *
 * Everything in `decisions/0035` was built and tested against a class no user could create — the
 * public blob class had no client path in either direction until `3b4c06f`. So every assumption in
 * the pipeline that was safe only because its subject could not exist has never been tested. This
 * drives the whole thing end to end: post, report, queue, review, decide, remove, appeal, report.
 *
 * It found two before it was finished, and both are the shape that was predicted — a claim about a
 * posted object that nothing could previously contradict:
 *
 *   1. `report()` computes `removedIds` and **the operator's `report` command never printed them**,
 *      while `report.published` on the disclosure table says the report names the ids of removed
 *      public objects. Produced and not consumed, inside the surface built last.
 *   2. `describePost` told a poster "the on-chain record of your publishing still stands" — **and
 *      `postPublic` never touches the chain.** Written from the channel-message model, where
 *      `sendMessage` does publish a commitment. A public post has no commitment, so the sentence
 *      was false to the person deciding whether to post.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Vault } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { removalAuthorityFromFile } from "../../vault-server/src/authority.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { postPublic, fetchPublic, describePost } from "../../client/src/public.ts";
import { serveIntake } from "../../operator/src/intake.ts";
import { FLOOR } from "../../moderation/src/transparency.ts";

const run = promisify(execFile);
const OPERATOR = resolve(import.meta.dirname, "../../operator/src/main.ts");
const SECRET = "a-long-enough-operator-secret";
const ACCOUNT = "0x04a2b3c4";
const VALID = { jsonrpc: "2.0", id: 1, result: ["0x56414c4944"] };

test("POST, REPORT, REVIEW, REMOVE, APPEAL, PUBLISH — against an object a user really made",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "hydra-e2e-"));
    const tokenFile = join(dir, "removal.token");
    const sigFile = join(dir, "sig");
    await writeFile(tokenFile, `${SECRET}\n`);
    await writeFile(sigFile, "0xaaa\n0xbbb\n");
    const operator = (...a: string[]) => run("node", ["--experimental-strip-types", OPERATOR, ...a,
      "--queue", join(dir, "q.json"), "--spool", join(dir, "spool")]);

    const vault = new Vault({ invites: ["inv-0"], buckets: BUCKETS });
    const { url, server } = await serve(vault, 0,
      { removalToken: removalAuthorityFromFile(tokenFile) });
    const intake = await serveIntake(join(dir, "spool"));
    const chain = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(VALID));
    });
    await new Promise<void>((ok) => chain.listen(0, "127.0.0.1", ok));
    const rpc = `http://127.0.0.1:${(chain.address() as { port: number }).port}`;

    try {
      // 1. A REAL POST, by the path a user has.
      const text = "a statement somebody objects to";
      const post = await postPublic(url, new TextEncoder().encode(text), {
        confirmedPublicAt: "2026-09-04T00:00:00Z", reason: "end to end",
      }, "inv-0");
      assert.equal((await fetchPublic(url, [post.id])).found.size, 1, "the post is not readable");

      // 2. A STRANGER REPORTS IT over the public intake endpoint.
      const filed = await fetch(`${intake.url}/v1/report`, {
        method: "POST",
        body: JSON.stringify({ blobId: post.id, body: "this impersonates a real person" }),
      });
      assert.equal(filed.status, 202);

      // 3. It reaches a human's queue.
      await operator("ingest");
      assert.match((await operator("queue")).stdout, new RegExp(post.id));

      // 4. AND THE BODY IS ACTUALLY SHOWN, with the caveat that a count is not a person count.
      const shown = await operator("show", post.id);
      assert.match(shown.stdout, /this impersonates a real person/);
      assert.match(shown.stdout, /count of reports, not of people/);
      assert.match(shown.stdout, new RegExp(`Deciding about: ${post.id}`));

      // 5. A decision, which is a record and NOT a removal.
      const decided = await operator("decide", post.id, "removed", "impersonation");
      const decisionId = decided.stdout.match(/Decision id: (\w+)/)?.[1];
      assert.ok(decisionId, `no decision id printed:\n${decided.stdout}`);
      assert.match(decided.stdout, /still on the vault/);
      assert.equal((await fetchPublic(url, [post.id])).found.size, 1,
        "recording a decision removed the object");

      // 6. The removal, by an operator holding an authority they could not have manufactured.
      const removed = await operator("remove", post.id, "--vault", url,
        "--removal-token-file", tokenFile);
      assert.match(removed.stdout, /Removed/);
      const after = await fetchPublic(url, [post.id]);
      assert.equal(after.found.size, 0, "the object survived its own removal");
      assert.deepEqual(after.missing, [post.id]);

      // 7. THE AUTHOR APPEALS, with an artifact they built without contacting anybody: the digest
      // is a pure function of the decision id, which is why there is no nonce.
      const digest = (await operator("digest", decisionId!)).stdout.split("\n")[0].trim();
      assert.equal(digest.length, 62, "the digest is not a felt an account could sign");
      const appealed = await operator("appeal", decisionId!, ACCOUNT,
        "--signature-file", sigFile, "--rpc", rpc);
      assert.match(appealed.stdout, /Appeal recorded/);
      await operator("appeal-resolve", decisionId!, ACCOUNT, "denied");

      // 8. And it all lands in a report whose bands are intact.
      const month = new Date().toISOString().slice(0, 7);
      const report = (await operator("report", month)).stdout;
      assert.match(report, new RegExp(`impersonation / removed: fewer than ${FLOOR}`));
      assert.match(report, new RegExp(`appeals / decision stood: fewer than ${FLOOR}`));
      // No total, and nothing that is the sum of anything else. Checked on the FIGURE lines only:
      // the first version of this matched the word "totals" in the report's own explanation of why
      // it publishes none, which is the assertion reading prose instead of data.
      const figures = report.split("\n").filter((l) => /^\S.*: .+\.$/.test(l) && !/^Period/.test(l));
      assert.ok(figures.length >= 2, `no figures parsed from the report:\n${report}`);
      assert.ok(!figures.some((l) => /^(total|decisions|reports received)/i.test(l)),
        `the report published an aggregate:\n${figures.join("\n")}`);

      // 9. THE REMOVED ID IS NAMED, which `report.published` says the report does and the
      //    operator's command did not print until this test asked for it.
      assert.match(report, new RegExp(post.id),
        "the report does not name the removed object, though the disclosure table says it does");
    } finally {
      chain.close();
      intake.server.close();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("A PUBLIC POST HAS NO ON-CHAIN COMMITMENT, and the warning must not say it does", () => {
  // `describePost` said "the on-chain record of your publishing still stands", copied from the
  // channel-message model where `sendMessage` really does publish a commitment. `postPublic` makes
  // no chain call at all — the warning was false to the one person it exists to inform.
  //
  // It matters beyond the sentence: `report.published` justifies naming removed public ids on the
  // grounds that "the on-chain commitment still stands, so a removal anybody can verify against it
  // is the mechanism this design chose". With no commitment there is nothing to verify against, so
  // naming them is the cost without the benefit. That is a decision, recorded in `0038`'s follow-up
  // rather than settled here.
  const text = describePost().join(" ");
  assert.ok(!/on-chain record/.test(text),
    "describePost still claims an on-chain record that posting does not create");
  // What it must say instead: removal is not unpublishing, and the timing is visible.
  assert.match(text, /cannot be unpublished/);
  assert.match(text, /no jitter and no cover/);
});
