/**
 * EVERY CAPABILITY THE SERVER HAS IS REACHABLE FROM THE WAY A SERVER IS ACTUALLY STARTED.
 *
 * A new class of defect, and the reason this file exists rather than another case in
 * `operator-view.test.ts`. Every earlier finding in this repo was a claim STRONGER than the
 * code: the table said less was visible than really was, or a mechanism promised a property it
 * did not have. This is the same defect with the opposite sign — a claim about a capability the
 * code CANNOT PERFORM.
 *
 * The instance: `http.ts` refuses a public takedown unless it was started with a `removalToken`,
 * and `main.ts` — the only way anyone starts a vault — never passed one. So the disclosure table
 * carried a takedown row, `operator-view.test.ts` proved takedown worked, `decisions/0035` built
 * a moderation pipeline that ends in one, and a REAL vault refused every takedown that had ever
 * been requested of it. Every test passed the whole time, because every test called `serve()`
 * directly. In-process reachability is not deployment reachability.
 *
 * Nothing looked for this, and the shape of what to look for is the point: an option that only
 * the tests ever pass is a capability that only the tests have. So the first test here is
 * structural and applies to options that do not exist yet — it reads the option names out of
 * `serve()`'s own signature and requires the entry point to PASS each one. The second spends a
 * process to prove the specific thing end to end, because a name can be passed and still be
 * wired to nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PUBLIC_ENDPOINT } from "../../vault-server/src/server.ts";
import { publish, wireBytes } from "../../vault-client/src/blobs.ts";

const HTTP = resolve(import.meta.dirname, "../../vault-server/src/http.ts");
const MAIN = resolve(import.meta.dirname, "../../vault-server/src/main.ts");

/**
 * The option names `serve()` declares, read out of its signature.
 *
 * Deliberately not a hand-kept list. A hand-kept list is a second place to forget the thing that
 * was already forgotten once, and it would have been written — by me, in this commit — containing
 * exactly the options I already knew about.
 */
function serveOptions(): string[] {
  const src = readFileSync(HTTP, "utf8");
  const from = src.indexOf("options: {");
  const to = src.indexOf("} = {},", from);
  assert.ok(from > 0 && to > from, "serve()'s options block has moved — this guard is now blind");
  return [...src.slice(from, to).matchAll(/^ {4}(\w+)\?:/gm)].map((m) => m[1]);
}

/**
 * The ARGUMENTS the entry point actually passes, not the whole file.
 *
 * The first version of this searched all of `main.ts`, and the mutation that deletes the wiring
 * walked straight past it: the name still appeared in the comment explaining the flag and in the
 * `const` that reads the file. A capability is reachable when it is PASSED, so the region that
 * counts is the call.
 */
function passedByMain(): string {
  const src = readFileSync(MAIN, "utf8");
  const from = src.indexOf("await serve(");
  const to = src.indexOf("});", from);
  assert.ok(from > 0 && to > from, "main.ts's serve() call has moved — this guard is now blind");
  return src.slice(from, to);
}

test("EVERY OPTION `serve` ACCEPTS IS REACHABLE FROM THE REAL ENTRY POINT", () => {
  const main = passedByMain();
  const options = serveOptions();
  // If the parse breaks, it must fail loudly rather than pass on an empty set — a guard that
  // finds nothing to check is indistinguishable from a guard that checked and was satisfied.
  assert.ok(options.length >= 4, `only found ${options.length} options; the parse is wrong`);
  assert.ok(options.includes("removalToken"), "the option this guard was written for is missing");

  const unreachable = options.filter((o) => !main.includes(o));
  assert.deepEqual(unreachable, [],
    `${unreachable.join(", ")} can be passed to serve() but main.ts does not pass it, so the `
    + `capability exists only in tests. Wire it to a flag, or delete the option.`);
});

test("A VAULT STARTED THE REAL WAY CAN ACTUALLY PERFORM A TAKEDOWN", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hydra-entry-"));
  const tokenFile = join(dir, "removal.token");
  // Trailing newline: a token file is written by a human and an editor adds one. Long enough to
  // clear `MIN_LENGTH` — an authority that removes anyone's public post is not a six-letter word,
  // and `touch removal.token` used to produce a server announcing takedown as ENABLED and matching
  // a caller who sent an empty header.
  const secret = "a-long-enough-operator-secret";
  await writeFile(tokenFile, `${secret}\n`);

  const started = (args: string[]) => new Promise<{
    url: string; stop: () => void; banner: Promise<string>;
  }>((ok, fail) => {
    const child = execFile("node", ["--experimental-strip-types", MAIN, "--port", "0", ...args]);
    let out = "";
    const banner = new Promise<string>((done) => child.on("close", () => done(out)));
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = out.match(/vault on (http:\/\/\S+)/);
      if (m) ok({ url: m[1], stop: () => child.kill(), banner });
    });
    child.on("error", fail);
    child.on("close", () => fail(new Error(`the vault exited without serving:\n${out}`)));
  });

  const post = publish(new TextEncoder().encode("a public statement"),
    { confirmedPublicAt: "2026-09-03T00:00:00Z", reason: "entry-point reachability" });
  const body = wireBytes(post) as unknown as Uint8Array;

  const takedown = async (args: string[]) => {
    const { url, stop, banner } = await started(args);
    try {
      const put = await fetch(`${url}${PUBLIC_ENDPOINT}/${post.id}`, { method: "PUT", body });
      assert.equal(put.status, 201, "the post did not store");
      const del = await fetch(`${url}${PUBLIC_ENDPOINT}/${post.id}`,
        { method: "DELETE", headers: { "x-hydra-removal": secret } });
      // Asked for as a BATCH, because there is no GET by id here — a request naming one object
      // names it to the operator, so a read is a POST of a padded id list. See `read.ts`.
      const after = await fetch(`${url}${PUBLIC_ENDPOINT}`,
        { method: "POST", body: JSON.stringify([post.id]) });
      const { found } = await after.json() as { found: Record<string, string> };
      return { del: del.status, present: post.id in found };
    } finally { stop(); await banner; }
  };

  try {
    // THE REGRESSION. Before the flag existed this was 404 — the operator's own token, against
    // their own vault, refused, with the object still there afterwards.
    const wired = await takedown(["--removal-token-file", tokenFile]);
    assert.equal(wired.del, 200,
      "a vault started from main.ts refused a takedown carrying the configured token");
    assert.equal(wired.present, false, "the takedown was accepted and removed nothing");

    // And the default is still the safe one: no flag, no removals by anyone.
    const bare = await takedown([]).catch((e: Error) => e);
    assert.ok(!(bare instanceof Error), String(bare));
    assert.equal(bare.del, 404, "a vault with no removal token configured performed a takedown");
    assert.equal(bare.present, true, "the object was removed by a vault that has no removal token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("THE STARTUP BANNER SAYS WHETHER TAKEDOWN WORKS, so the next one announces itself", async () => {
  // The cheap half of the guard, and the half that would have caught this without anyone
  // suspecting it. Every other capability's state is printed at startup — the limiter, transport
  // observation, read logging, TLS — and takedown was the one that was not, which is exactly why
  // a vault that could not perform it looked identical to one that could.
  const child = execFile("node", ["--experimental-strip-types", MAIN, "--port", "0"]);
  const banner = await new Promise<string>((ok) => {
    let out = "";
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("transport ")) { child.kill(); ok(out); }
    });
  });
  assert.match(banner, /takedown\s+public takedown DISABLED/,
    "a vault that cannot take anything down did not say so when it started");
});

test("THE VAULT MINTS INVITE CODES, and says what handing them out decides", async () => {
  // Nothing generated codes; `--invites` took a list somebody typed. An operator inventing codes
  // by hand invents one per person, and that single habit undoes every other defence here: the
  // code arrives in the same request as the object, so it names the uploader with no cryptography.
  // `invite.issuance` on the DERIVABLE table carries the disclosure; this is the warning at the
  // point where the choice is actually made.
  const { stdout, stderr } = await promisify(execFile)("node",
    ["--experimental-strip-types", MAIN, "--generate-invites", "12"]);
  const codes = stdout.trim().split("\n");
  assert.equal(codes.length, 12);
  assert.equal(new Set(codes).size, 12, "two codes collided");
  for (const c of codes) {
    assert.match(c, /^[0-9a-f]{32}$/, "a code is not 128 bits of hex, so it may be guessable");
  }
  // The warning, and the part of it that is easy to leave out: the open-batch practice is not free.
  assert.match(stderr, /PRIVACY DECISION/);
  assert.match(stderr, /A code you give to one named person is an identity/);
  assert.match(stderr, /PUBLISH A BATCH OPENLY/);
  assert.match(stderr, /not free/,
    "the open-batch practice is presented without its cost — an open code is usable by anyone");
  assert.match(stderr, /rate limiting that anyone can exhaust/);
  // And it does not start a server: minting is not running.
  assert.ok(!stdout.includes("vault on"), "generating codes started a vault");
});

test("and the startup banner says it too, beside the other capability states", async () => {
  // The banner already announces the limiter, storage, takedown and transport. The invite count
  // was printed as a bare number, which reads as inventory rather than as a decision.
  const child = execFile("node", ["--experimental-strip-types", MAIN, "--port", "0",
    "--invites", "a,b"]);
  const banner = await new Promise<string>((ok) => {
    let out = "";
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("transport ")) { child.kill(); ok(out); }
    });
  });
  assert.match(banner, /invites {2}2/);
  assert.match(banner, /whether they are an identity/,
    "the invite count is printed as inventory, with nothing saying what issuing them decides");
});

test("VAULT FILES ARE 0600 AND ITS STORE 0700 — it holds other people's ciphertext", async () => {
  // Every other persistence path in this repo sets the mode deliberately — the client's state
  // file, the operator's queue, the intake spool — and the vault was the one that did not, while
  // holding the objects. A vault on a shared host was serving its store to every account on the
  // box. Checked on a REWRITE as well as a create: `writeFileSync`'s mode applies only when the
  // file does not already exist, and a rewritten sidecar is the common case here.
  const { Vault, ENCRYPTED_ENDPOINT: ENC } = await import("../../vault-server/src/server.ts");
  const { BUCKETS } = await import("../../vault-client/src/buckets.ts");
  const { mkdtemp, stat, chmod } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "hydra-modes-"));
  const store = join(dir, "store");
  const vault = new Vault({ invites: ["a", "b"], buckets: BUCKETS, dir: store });
  const id = "enc:00112233445566778899aabbccddeeff";
  vault.handle({ op: "upload", endpoint: ENC, id, body: new Uint8Array(BUCKETS[0]), invite: "a" });

  assert.equal((await stat(store)).mode & 0o777, 0o700, "the store directory is listable by others");
  for (const f of [`${id}.blob`, `${id}.json`]) {
    assert.equal((await stat(join(store, f))).mode & 0o777, 0o600, `${f} is readable by others`);
  }

  // Loosen them and rewrite: the mode must be reasserted, not left to creation.
  await chmod(join(store, `${id}.json`), 0o644);
  vault.handle({ op: "upload", endpoint: ENC, id, body: new Uint8Array(BUCKETS[0]), invite: "b" });
  assert.equal((await stat(join(store, `${id}.json`))).mode & 0o777, 0o600,
    "a rewritten sidecar kept its old permissions — the mode argument alone does nothing here");
  await rm(dir, { recursive: true, force: true });
});

test("INVITE CODES COME FROM A FILE, because argv is the process table", async () => {
  // `authority.ts` and `compelled.ts` both take a path for exactly this reason, and an invite is
  // the credential a source's anonymity rests on: a code leaked to `ps` links it to whoever ran
  // the vault at that moment, which is the join `invite.issuance` is on the disclosure table for.
  const dir = await mkdtemp(join(tmpdir(), "hydra-invites-"));
  const file = join(dir, "codes.txt");
  await writeFile(file, "code-one\n\n  code-two  \n");
  const started = (args: string[]) => new Promise<{ url: string; stop: () => void }>((ok, fail) => {
    const child = execFile("node", ["--experimental-strip-types", MAIN, "--port", "0", ...args]);
    let out = "";
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = out.match(/vault on (http:\/\/\S+)/);
      if (m) ok({ url: m[1], stop: () => child.kill() });
    });
    child.on("close", () => fail(new Error(`did not serve:\n${out}`)));
  });

  const { url, stop } = await started(["--invites-file", file]);
  try {
    // Both codes are honoured, and surrounding whitespace does not make one unusable.
    const post = await import("../../vault-client/src/blobs.ts");
    const blob = post.publish(new TextEncoder().encode("x"),
      { confirmedPublicAt: "2026-09-04T00:00:00Z", reason: "invites-file" });
    const res = await fetch(`${url}/v1/pub/${blob.id}`, {
      method: "PUT",
      headers: { "x-hydra-invite": "code-two" },
      body: post.wireBytes(blob) as unknown as Uint8Array,
    });
    assert.equal(res.status, 201, "a code with surrounding whitespace was not honoured");
  } finally { stop(); await rm(dir, { recursive: true, force: true }); }
});
