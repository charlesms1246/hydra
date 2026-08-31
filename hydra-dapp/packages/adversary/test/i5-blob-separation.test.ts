/**
 * I5 — public and encrypted blobs never share keys, identifiers, or code paths.
 *
 * `claude-docs/HYDRA_HANDOFF.md` I5, described there as "the most dangerous failure mode in
 * the product": a private message accidentally published is unrecoverable. It cannot be
 * un-read, and the author cannot be warned, because we do not know who they are.
 *
 * Its acceptance condition has two halves and this file asserts both:
 *
 *   1. "a fuzz/property test that attempts to publish an encrypted blob through every code
 *      path and asserts each one fails" — the runtime checks below;
 *   2. "a type-level separation that makes the mistake uncompilable" — `i5-must-not-compile.ts`
 *      attempts eight routes and tsc must reject all of them.
 *
 * The standing rule this enforces, from §4: **publishing is never a mode, always an act.** Any
 * change that makes it easier to publish accidentally is a regression regardless of how it
 * tests, which is why `publish` takes a mandatory intent argument that cannot be defaulted and
 * why nothing anywhere converts one blob class into the other.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  sealForChannel, publish, wireBytes, uploadPathFor,
  ENCRYPTED_ENDPOINT, PUBLIC_ENDPOINT, isPublic,
} from "../../vault-client/src/blobs.ts";
import { rootSeed, entropyFrom, derive, VAULT_DOMAIN, fromTestVector} from "../../identity/src/domains.ts";
import { channelSecret } from "../../channel/src/pointer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const seed = rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(9), "i5 test vector")));
const chan = channelSecret(derive(VAULT_DOMAIN, seed), "alice→bob");
const intent = { confirmedPublicAt: "2026-08-30T00:00:00Z", reason: "test" };

test("the two classes never share an id namespace", () => {
  // A shared namespace is how a public read of a private id becomes possible at all. Fuzzed
  // over the same plaintexts in both classes, because identical content is the case where a
  // content-addressed scheme would collide if the class were not part of the id.
  const encIds = new Set<string>();
  const pubIds = new Set<string>();
  for (let i = 0; i < 256; i++) {
    const bytes = new Uint8Array(32).fill(i);
    encIds.add(sealForChannel(chan, bytes).id);
    pubIds.add(publish(bytes, intent).id);
  }
  assert.equal(encIds.size, 256);
  assert.equal(pubIds.size, 256);
  for (const id of encIds) assert.ok(!pubIds.has(id), `id ${id} exists in both namespaces`);
  // And the class is legible from the id alone, so a mis-routed id is caught at the boundary
  // rather than by whatever happens to be listening.
  for (const id of encIds) assert.ok(id.startsWith("enc:"));
  for (const id of pubIds) assert.ok(id.startsWith("pub:"));
});

test("the same plaintext gives unrelated ids in the two classes", () => {
  // If the public id were a function of the content alone, an operator holding a public blob
  // could test whether a given encrypted blob is the same document.
  const bytes = new TextEncoder().encode("the same words either way");
  const enc = sealForChannel(chan, bytes);
  const pub = publish(bytes, intent);
  assert.notEqual(enc.id.slice(4), pub.id.slice(4));
});

test("every upload path an encrypted blob can take is the encrypted endpoint", () => {
  // The fuzz I5 asks for: try to route an encrypted blob out through the public door, by
  // every means the runtime allows.
  for (let i = 0; i < 128; i++) {
    const enc = sealForChannel(chan, new Uint8Array(16).fill(i));
    assert.equal(uploadPathFor(enc), `${ENCRYPTED_ENDPOINT}/${enc.id}`);
    assert.ok(!uploadPathFor(enc).startsWith(PUBLIC_ENDPOINT));
    // Naming the public endpoint explicitly is refused at runtime as well as by the type.
    assert.throws(() => uploadPathFor(enc, PUBLIC_ENDPOINT as never), /encrypted/i);
    assert.equal(isPublic(enc), false);
  }
});

test("a forged class tag does not survive the boundary", () => {
  // What an unsound call site looks like after an `as any`, or after a blob is round-tripped
  // through JSON by a caller who reconstructed it by hand. The id is the authority, not the
  // tag, because the id is the thing the vault actually stores under.
  const enc = sealForChannel(chan, new Uint8Array([7, 7, 7]));
  const forged = { ...enc, class: "public" } as never;
  assert.throws(() => uploadPathFor(forged), /disagree|encrypted/i);
  assert.equal(isPublic(forged), false);
});

test("publishing requires a stated intent, and keeps it", () => {
  // Publishing is an act, not a mode. The intent is mandatory, is recorded on the blob, and
  // is not something a caller can pass through from somewhere else — it names a moment and a
  // reason, which is what makes an accidental publish visible after the fact.
  const pub = publish(new Uint8Array([1]), intent);
  assert.equal(pub.intent.reason, "test");
  assert.equal(pub.intent.confirmedPublicAt, intent.confirmedPublicAt);
  assert.throws(() => publish(new Uint8Array([1]), { confirmedPublicAt: "", reason: "" } as never),
    /intent/i);
});

test("no export converts one blob class into the other", () => {
  // The audit that outlives the types: a future function with an honest-looking name that
  // takes an EncryptedBlob and returns a PublicBlob would satisfy every test above.
  // /usr/bin/grep, not the shell's — the shell's here is gitignore-aware and an audit that
  // silently skips files is not an audit.
  const src = join(HERE, "..", "..", "vault-client", "src");
  // grep exits 1 on no match and execFileSync throws for that — but no match is the PASSING
  // case here, so it has to be caught rather than allowed to fail the test.
  let out = "";
  try {
    out = execFileSync("/usr/bin/grep", ["-rhoE", "EncryptedBlob\\)[^{]*: *PublicBlob", src],
      { encoding: "utf8" }).trim();
  } catch { out = ""; }
  assert.equal(out, "", `a function converts encrypted to public:\n${out}`);
  // And exactly one place constructs a PublicBlob, so there is one thing to review.
  const constructors = readFileSync(join(src, "blobs.ts"), "utf8")
    .split("\n").filter((l) => /^export function \w+[^;]*\): PublicBlob/.test(l));
  assert.equal(constructors.length, 1, `${constructors.length} exports construct a PublicBlob`);
  assert.match(constructors[0], /^export function publish\b/);
});

test("none of the eight publish routes compiles", () => {
  const local = join(HERE, "..", "node_modules", ".bin", "tsc");
  const shared = join(HERE, "..", "..", "identity", "node_modules", ".bin", "tsc");
  const tsc = existsSync(local) ? local : existsSync(shared) ? shared : null;
  // A missing type-checker is a FAILURE, not a skip: an unrun build check reported as green
  // is how a build-time guarantee stops being one.
  assert.ok(tsc, "no tsc — run `npm i -D typescript` in hydra-dapp/packages/identity");

  let out = "";
  try {
    execFileSync(tsc, ["--noEmit", "-p", join(HERE, "..", "tsconfig.json")], { encoding: "utf8" });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const lines = out.split("\n").filter((l) => /error TS/.test(l));
  // Counted by DISTINCT LINE, not by error. Eight errors on seven routes passes a count check
  // while one route silently compiles — and the route that compiles is the one that publishes
  // a private message. Every numbered attempt has to be rejected on its own.
  const fixture = lines.filter((l) => l.includes("i5-must-not-compile"));
  const offending = new Set(fixture.map((l) => l.match(/\((\d+),/)?.[1]).filter(Boolean));
  const attempts = readFileSync(join(HERE, "i5-must-not-compile.ts"), "utf8")
    .split("\n").filter((l) => /^\/\/ \d+\./.test(l)).length;
  assert.equal(offending.size, attempts,
    `${attempts} numbered routes, ${offending.size} rejected — one of them compiles:\n${out}`);
  // Nothing ELSE may fail to type-check, or this passes for the wrong reason. Every
  // `*-must-not-compile.ts` is excluded, not just this one: they exist to fail, and a new
  // invariant's fixture must not break an older invariant's build gate.
  const other = lines.filter((l) => !/must-not-compile/.test(l));
  assert.deepEqual(other, [], `type errors outside the fixtures:\n${other.join("\n")}`);
});
