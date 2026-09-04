/**
 * Appealing a decision, end to end through the operator tool.
 *
 * The last of `decisions/0035`'s eight steps to become performable. What this file checks that the
 * unit tests cannot: that an appellant can produce the artifact WITHOUT CONTACTING THE OPERATOR,
 * that the operator verifies it against a chain rather than against the connection it arrived on,
 * and that a decision id survives from the moment it is minted to the moment it is contested.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { appealDigest } from "../../moderation/src/appeals.ts";
import { verifyRequest, verifyReply } from "../../operator/src/verify.ts";
import { Reports } from "../../moderation/src/reports.ts";
import { save } from "../../operator/src/queue.ts";

const run = promisify(execFile);
const MAIN = resolve(import.meta.dirname, "../../operator/src/main.ts");
const ACCOUNT = "0x04a2b3c4";

/** A stand-in for a Starknet node. Records what it was asked, so the request itself is checked. */
async function withChain(
  answer: (req: Record<string, unknown>) => unknown,
  fn: (ctx: { rpc: string; asked: Record<string, unknown>[];
    dir: string; operator: (...a: string[]) => Promise<{ stdout: string }> }) => Promise<void>,
) {
  const asked: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      let raw = "";
      for await (const c of req) raw += c;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      asked.push(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(parsed)));
    })();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const rpc = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = await mkdtemp(join(tmpdir(), "hydra-appeal-"));
  try {
    await fn({ rpc, asked, dir,
      operator: (...a) => run("node", ["--experimental-strip-types", MAIN, ...a,
        "--queue", join(dir, "q.json"), "--spool", join(dir, "spool")]) });
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
}

const VALID = { jsonrpc: "2.0", id: 1, result: ["0x56414c4944"] };
const INVALID = { jsonrpc: "2.0", id: 1, result: ["0x0"] };

/** Seed a queue with one decided object and return its decision id. */
async function decided(dir: string, operator: (...a: string[]) => Promise<{ stdout: string }>) {
  const q = new Reports();
  q.file("pub:contested", "this is impersonation", 0);
  save(join(dir, "q.json"), q);
  const out = await operator("decide", "pub:contested", "removed", "impersonation");
  const id = out.stdout.match(/Decision id: (\w+)/)?.[1];
  assert.ok(id, `decide did not print a decision id:\n${out.stdout}`);
  return id;
}

test("AN APPELLANT LEARNS WHAT TO SIGN WITHOUT CONTACTING THE OPERATOR", async () => {
  // The whole reason the nonce is gone. The digest is a pure function of the decision id, so an
  // appellant computes it themselves — and this test computes it independently of the tool, which
  // is the same thing an appellant's own client would do.
  await withChain(() => VALID, async ({ dir, operator }) => {
    const id = await decided(dir, operator);
    const printed = (await operator("digest", id)).stdout.split("\n")[0].trim();
    assert.equal(printed, appealDigest(id),
      "the tool's digest disagrees with the library's, so an appellant would sign the wrong thing");
    // Nothing was issued, allocated or recorded in order to produce it.
    const onDisk = JSON.parse(await readFile(join(dir, "q.json"), "utf8")) as { appeals: unknown[] };
    assert.deepEqual(onDisk.appeals, [], "asking what to sign created state on the operator's side");
  });
});

test("A SIGNED ARTIFACT IS ACCEPTED, AND THE CHAIN IS WHAT IS ASKED", async () => {
  await withChain(() => VALID, async ({ rpc, asked, dir, operator }) => {
    const id = await decided(dir, operator);
    const sigFile = join(dir, "sig");
    await writeFile(sigFile, "0xaaa\n0xbbb\n");

    const done = await operator("appeal", id, ACCOUNT, "--signature-file", sigFile, "--rpc", rpc);
    assert.match(done.stdout, /Appeal recorded/);

    // The operator asked the ACCOUNT CONTRACT about the digest — not a database, not the sender.
    assert.equal(asked.length, 1);
    const params = (asked[0] as { params: { request: Record<string, unknown> } }).params.request;
    assert.equal(params.contract_address, ACCOUNT);
    // A FELT, NOT THE NAME, and asserted as a SHAPE rather than as a literal. The first version of
    // this line checked `=== "is_valid_signature"` and passed, because it was written from the code
    // and the code was wrong — a real node answered `Invalid nibble found: 0x72`. Copying the value
    // out of the implementation is how a test comes to agree with a bug; checking that it is the
    // kind of thing `starknet_call` accepts is a claim the implementation cannot satisfy by being
    // wrong in the same way.
    assert.match(String(params.entry_point_selector), /^0x[0-9a-f]+$/,
      "the entry point selector is not a felt — starknet_call will refuse it outright");
    assert.ok(BigInt(String(params.entry_point_selector)) < 1n << 250n,
      "the selector is not masked to 250 bits, so it is not a starknet_keccak");
    assert.deepEqual(params.calldata, [`0x${appealDigest(id)}`, "0x2", "0xaaa", "0xbbb"]);

    // It survives the process, and shows up as outstanding.
    assert.match((await operator("appeals")).stdout, new RegExp(`${id}.*${ACCOUNT}`));
  });
});

test("AN UNVERIFIABLE ARTIFACT RECORDS NOTHING AND BURNS NOTHING", async () => {
  // Two properties in one, and the second is the reversal `decisions/0037` argued for. A failed
  // attempt must leave no trace — anyone can submit one naming any account — and it must not
  // consume the appellant's one chance, or knowing a decision id would be enough to deny somebody
  // their appeal at the moment they have no other recourse.
  let valid = false;
  await withChain(() => (valid ? VALID : INVALID), async ({ rpc, dir, operator }) => {
    const id = await decided(dir, operator);
    const sigFile = join(dir, "sig");
    await writeFile(sigFile, "0xforged\n");

    for (let i = 0; i < 3; i++) {
      const refused = await operator("appeal", id, ACCOUNT, "--signature-file", sigFile,
        "--rpc", rpc).catch((e: { stdout: string }) => e);
      assert.match(refused.stdout, /Not recorded: the signature did not verify/);
      // And it does not claim to know which failure it was, because it cannot.
      assert.match(refused.stdout, /network failure and a bad signature both refuse/);
    }
    const onDisk = JSON.parse(await readFile(join(dir, "q.json"), "utf8")) as { appeals: unknown[] };
    assert.deepEqual(onDisk.appeals, [], "a failed attempt was recorded against an account");

    // The real appellant still gets through.
    valid = true;
    assert.match((await operator("appeal", id, ACCOUNT, "--signature-file", sigFile,
      "--rpc", rpc)).stdout, /Appeal recorded/);
  });
});

test("a decision that is not in this queue is said so, not blamed on the signature", async () => {
  await withChain(() => VALID, async ({ rpc, dir, operator }) => {
    await decided(dir, operator);
    const sigFile = join(dir, "sig");
    await writeFile(sigFile, "0xaaa\n");
    const missing = await operator("appeal", "not-a-decision", ACCOUNT, "--signature-file", sigFile,
      "--rpc", rpc).catch((e: { stdout: string }) => e);
    assert.match(missing.stdout, /No decision not-a-decision in this queue/);
  });
});

test("A RESOLVED APPEAL REACHES THE TRANSPARENCY REPORT, on the same floor", async () => {
  await withChain(() => VALID, async ({ rpc, dir, operator }) => {
    const id = await decided(dir, operator);
    const sigFile = join(dir, "sig");
    await writeFile(sigFile, "0xaaa\n");
    await operator("appeal", id, ACCOUNT, "--signature-file", sigFile, "--rpc", rpc);

    // Before resolution it is not an outcome, so it appears nowhere.
    const month = new Date().toISOString().slice(0, 7);
    const before = await operator("report", month);
    assert.ok(!/appeal/i.test(before.stdout), "a pending appeal was published");

    const resolved = await operator("appeal-resolve", id, ACCOUNT, "upheld");
    // Says what it did NOT do: a removal is not undone by reversing the decision.
    assert.match(resolved.stdout, /object is NOT restored/);

    const after = await operator("report", month);
    assert.match(after.stdout, /appeals \/ decision reversed: fewer than 5/,
      `the resolved appeal did not reach the report:\n${after.stdout}`);
    // "upheld" is spelled out, because the bare word is read both ways.
    assert.ok(!/upheld:/.test(after.stdout));
  });
});

test("only a recognised reply counts as valid — anything else fails closed", () => {
  // The failure mode worth naming, since nothing hermetic can talk to a real account: a contract
  // returning a shape nobody recognises must be read as a REFUSAL. Accepting on the unknown would
  // mean acting on an appeal from somebody who could not sign for the account, and there is no
  // other identity in this system that would catch it.
  assert.ok(verifyReply({ result: ["0x56414c4944"] }));
  assert.ok(verifyReply({ result: ["0x1"] }));
  for (const reply of [{ result: ["0x0"] }, { result: [] }, { result: ["0x1", "0x1"] },
    { result: "0x1" }, { error: { code: 40 } }, {}, null, undefined, "VALID"]) {
    assert.ok(!verifyReply(reply), `${JSON.stringify(reply)} was read as a valid signature`);
  }
  // And the request names the account as the contract to ask, not as data.
  const req = verifyRequest("0xacc", "abcd", ["0x1"]);
  assert.equal(req.params.request.contract_address, "0xacc");
});
