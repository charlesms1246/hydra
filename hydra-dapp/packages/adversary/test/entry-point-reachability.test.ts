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
  await writeFile(tokenFile, "s3cret\n"); // trailing newline: a token file is written by a human

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
        { method: "DELETE", headers: { "x-hydra-removal": "s3cret" } });
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
