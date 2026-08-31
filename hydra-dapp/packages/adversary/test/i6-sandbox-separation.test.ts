/**
 * I6 — sandbox keys never touch the chain, and no key reaches a browser.
 *
 * `HYDRA_HANDOFF.md` I6: viewing keys are write-once by contract and cannot be rotated, so a
 * key leaked into a browser is compromised permanently with no remedy for the user and none
 * for us. The web surfaces are therefore a read-only feed reader, a sandbox with disposable
 * keys, and a marketing site — none of which authenticates a real identity, decrypts a real
 * payload, or signs a real transaction.
 *
 * Its test has two clauses:
 *
 *   1. "the web packages must not depend on the identity or vault-client packages at all, and
 *      a build-time check must fail if they do" — the dependency check below, which currently
 *      has no `web/` to check and says so out loud rather than passing quietly;
 *   2. "sandbox key material carries a distinct type that on-chain code paths refuse" — the
 *      rest of this file, plus `i6-must-not-compile.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { noteCalldata } from "../../channel/src/note.ts";
import { channelSecret, pointerFor, recoverBlobId, blobIdFrom } from "../../channel/src/pointer.ts";
import { commit } from "../../channel/src/commitment.ts";
import {
  SANDBOX_DOMAIN, VAULT_DOMAIN, POOL_DOMAIN, DOMAINS,
  derive, entropyFrom, rootSeed, expose, requireDomain, fromTestVector} from "../../identity/src/domains.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAPP = join(HERE, "..", "..", "..");
const seed = rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(8), "i6 test vector")));
const sandbox = channelSecret(derive(SANDBOX_DOMAIN, seed), "toy channel");
const real = channelSecret(derive(VAULT_DOMAIN, seed), "real channel");

test("the sandbox domain is a real domain, not a flag on the real one", () => {
  // A boolean "disposable" field would be forgotten at one call site and the type system would
  // never notice. A domain means the keys are cryptographically unrelated and every existing
  // boundary check applies to it for free.
  assert.ok(DOMAINS.includes(SANDBOX_DOMAIN));
  assert.equal(new Set(DOMAINS).size, DOMAINS.length);
  for (const other of [POOL_DOMAIN, VAULT_DOMAIN]) {
    assert.ok(!SANDBOX_DOMAIN.startsWith(other) && !other.startsWith(SANDBOX_DOMAIN));
  }
  // One seed, unrelated keys — the same property I1 asserts between pool and vault.
  const s = expose(derive(SANDBOX_DOMAIN, seed), SANDBOX_DOMAIN);
  const v = expose(derive(VAULT_DOMAIN, seed), VAULT_DOMAIN);
  assert.notDeepEqual(s, v);
  assert.notEqual(s[0], v[0]);
});

test("the sandbox runs the whole channel machinery, which is the point", () => {
  // A sandbox that cannot do what the product does teaches nothing. Everything works; only the
  // route to the chain is closed.
  const blobId = blobIdFrom(new Uint8Array(64).fill(3));
  const pointer = pointerFor(sandbox, blobId, 0);
  assert.deepEqual(recoverBlobId(sandbox, pointer, 0), blobId);
  assert.notDeepEqual(pointerFor(real, blobId, 0), pointer);
  // And a commitment still computes — the sandbox can demonstrate authorship end to end.
  assert.ok(commit(1n, 2n) > 0n);
});

test("a sandbox SECRET is refused at runtime; a sandbox POINTER is not", () => {
  // Secrets carry their domain at runtime, so the boundary holds even after an `as any`.
  assert.throws(() => requireDomain(sandbox, VAULT_DOMAIN), /sandbox\/disposable/);
  // `as never`: the type refuses this now (see `expose`'s `NoInfer`), and the runtime tag is
  // what still has to hold for a call site that got here through an `as any`.
  assert.throws(() => expose(sandbox, VAULT_DOMAIN as never), /sandbox\/disposable/);

  // Pointers do not, and this asserts the weakness rather than hiding it. A pointer is 31
  // bytes of masked blob id headed for a single felt: there is no room for a domain tag, and
  // adding one would either cost a second felt or occupy bits that currently carry the mask.
  // So I6's on-chain refusal is a COMPILE-TIME guarantee for pointers and a runtime one only
  // for secrets. An `as never` at the call site defeats it, which is precisely why
  // `i6-must-not-compile.ts` enumerates the routes instead of relying on a check here.
  const smuggled = pointerFor(sandbox, blobIdFrom(new Uint8Array(8)), 0) as never;
  assert.doesNotThrow(() => noteCalldata(smuggled, 1n),
    "if this now throws, a runtime tag was added and this comment is out of date");
});

test("a real pointer still reaches the chain", () => {
  // Not vacuous: the refusal above must not be "nothing works".
  const calldata = noteCalldata(pointerFor(real, blobIdFrom(new Uint8Array(8)), 0), 7n);
  assert.equal(calldata.length, 2);
});

test("no web package depends on identity or vault-client", () => {
  // I6's build-time check. `web/` does not exist yet — `claude-docs/FRONTEND-SCAFFOLD.md`
  // parks it until Phase 4 — so this cannot pass or fail on evidence today. It reports that
  // plainly instead of going green, because a dependency check that silently passes on an
  // absent directory is how the check comes to exist without ever having run.
  const webDirs = ["web", "app"].map((d) => join(DAPP, d)).filter(existsSync);
  if (webDirs.length === 0) {
    assert.ok(existsSync(join(DAPP, "..", "claude-docs", "docs", "FRONTEND-SCAFFOLD.md")),
      "no web/ to check and no scaffold note explaining why — one of those must be true");
    return;
  }
  for (const dir of webDirs) {
    const offenders = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))
      .filter((f) => {
        try {
          return /from ["'].*(packages\/identity|packages\/vault-client|@hydra-platform\/(identity|vault-client))/
            .test(execFileSync("/usr/bin/cat", [join(dir, f)], { encoding: "utf8" }));
        } catch { return false; }
      });
    assert.deepEqual(offenders, [], `${dir} imports key-handling code:\n${offenders.join("\n")}`);
  }
});

test("no route from sandbox material to the chain compiles", () => {
  const local = join(HERE, "..", "node_modules", ".bin", "tsc");
  const shared = join(HERE, "..", "..", "identity", "node_modules", ".bin", "tsc");
  const tsc = existsSync(local) ? local : existsSync(shared) ? shared : null;
  assert.ok(tsc, "no tsc — run `npm i -D typescript` in hydra-dapp/packages/identity");

  let out = "";
  try {
    execFileSync(tsc, ["--noEmit", "-p", join(HERE, "..", "tsconfig.json")], { encoding: "utf8" });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const lines = out.split("\n").filter((l) => /error TS/.test(l));
  const fixture = lines.filter((l) => l.includes("i6-must-not-compile"));
  assert.ok(fixture.length >= 6,
    `the fixture produced ${fixture.length} type errors, expected at least 6:\n${out}`);
  const other = lines.filter((l) => !/must-not-compile/.test(l));
  assert.deepEqual(other, [], `type errors outside the fixtures:\n${other.join("\n")}`);
});
