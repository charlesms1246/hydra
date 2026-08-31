/**
 * I1 — no derivation path between pool keys and vault keys.
 *
 * `claude-docs/HYDRA_HANDOFF.md` I1: the pool encrypts the user's private viewing key to an auditor
 * key read from contract storage — mandatory, no opt-out, no substitution, and write-once
 * on the user's side (`.upstream/packages/privacy/src/privacy.cairo:331-350`). The
 * auditor key itself IS rotatable by the security governor (`privacy.cairo:1151-1154`),
 * which only widens the audience — see `claude-docs/decisions/0001-key-domains.md`. Anyone
 * holding any generation of that key decrypts every note, derives every channel key and
 * reads the social graph.
 * So the pool cannot be a confidentiality boundary, and vault content keys must live in
 * a derivation domain with no path to or from the pool viewing key **in either
 * direction**.
 *
 * WHAT THIS TEST CAN AND CANNOT DO. It cannot prove no derivation path exists — no test
 * can; that is a claim about all possible functions. What it proves is narrower and
 * still worth having:
 *
 *   1. the two domains are cryptographically separated, so one root seed yields
 *      unrelated keys — and if `derive` ever stops mixing the domain in, this fails;
 *   2. the API refuses to carry material across the boundary at RUNTIME;
 *   3. the API refuses it at COMPILE TIME, which is the "fails the build" half of the
 *      handoff's acceptance condition;
 *   4. exactly one function mints a seed and exactly one reads raw bytes, so the
 *      audit surface is two functions rather than a package.
 *
 * The residual risk it does NOT cover is named in `claude-docs/decisions/0001-key-domains.md`:
 * a shared *upstream* seed. If one wallet signature or passphrase ever feeds both the
 * SDK's viewing-key derivation and `rootSeed`, every assertion below still passes and
 * I1 is still broken. That is why nothing here derives a pool key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  POOL_DOMAIN, VAULT_DOMAIN, DOMAINS,
  rootSeed, randomEntropy, entropyFrom, derive, subKey, requireDomain, expose, adoptPoolKey, fromTestVector} from "../src/domains.ts";
import { contentKey, vaultRoot } from "../src/vault-key.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const seed = rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(7), "test vector")));

test("the two domains are distinct, and neither is a prefix of the other", () => {
  assert.notEqual(POOL_DOMAIN, VAULT_DOMAIN);
  // A prefix collision defeats separation in any construction that concatenates the
  // tag with a label. Cheap to assert, easy to reintroduce.
  assert.ok(!POOL_DOMAIN.startsWith(VAULT_DOMAIN));
  assert.ok(!VAULT_DOMAIN.startsWith(POOL_DOMAIN));
  assert.equal(new Set(DOMAINS).size, DOMAINS.length);
});

test("one seed yields unrelated keys in the two domains", () => {
  const pool = expose(derive(POOL_DOMAIN, seed), POOL_DOMAIN);
  const vault = expose(derive(VAULT_DOMAIN, seed), VAULT_DOMAIN);
  assert.equal(pool.length, 32);
  assert.notDeepEqual(pool, vault);
  // Not merely different: no shared prefix. A `derive` that appended the domain after
  // the KDF, or truncated one shared stream, passes the check above and fails this.
  assert.notEqual(pool[0], vault[0]);
  // Labels separate within a domain too.
  const a = expose(derive(VAULT_DOMAIN, seed, "a"), VAULT_DOMAIN);
  const b = expose(derive(VAULT_DOMAIN, seed, "b"), VAULT_DOMAIN);
  assert.notDeepEqual(a, b);
  // Deterministic, or none of the above is reproducible.
  assert.deepEqual(a, expose(derive(VAULT_DOMAIN, seed, "a"), VAULT_DOMAIN));
  // And a different seed gives a different key, which is what makes it a seed.
  assert.notDeepEqual(a, expose(derive(VAULT_DOMAIN, rootSeed(randomEntropy()), "a"), VAULT_DOMAIN));
});

test("a pool secret cannot be used where a vault secret is required — at runtime", () => {
  const pool = derive(POOL_DOMAIN, seed);
  assert.throws(() => requireDomain(pool, VAULT_DOMAIN), /pool\/viewing-key/);
  // `as never` because the type now refuses this outright — `expose`'s domain parameter is
  // `NoInfer<D>`, so it cannot widen to the union of the two domains the way it used to. The
  // runtime tag is still asserted, because a call site that arrived through an `as any` is the
  // one that matters and the type cannot reach it.
  assert.throws(() => expose(pool, VAULT_DOMAIN as never), /pool\/viewing-key/);
  // What an unsound call site looks like after an `as any`. The runtime tag has to stop
  // it even though the type already did.
  assert.throws(() => contentKey(pool as never, "blob-1"), /pool\/viewing-key/);
});

test("sub-keys stay in their domain and are scoped per blob", () => {
  const root = vaultRoot(seed);
  assert.equal(root.domain, VAULT_DOMAIN);
  const one = contentKey(root, "blob-1");
  const two = contentKey(root, "blob-2");
  assert.equal(one.domain, VAULT_DOMAIN);
  assert.notDeepEqual(expose(one, VAULT_DOMAIN), expose(two, VAULT_DOMAIN));
  assert.notDeepEqual(expose(one, VAULT_DOMAIN), expose(root, VAULT_DOMAIN));
  // subKey carries the domain with it — it takes no domain argument, so it cannot cross.
  assert.equal(subKey(derive(POOL_DOMAIN, seed), "x").domain, POOL_DOMAIN);
});

test("an adopted pool viewing key is tagged, and is not a seed", () => {
  // We never DERIVE a pool viewing key. The SDK does, and this tags it the moment it
  // enters our code so every later use is checked.
  const adopted = adoptPoolKey(0x1234n);
  assert.equal(adopted.domain, POOL_DOMAIN);
  assert.throws(() => requireDomain(adopted, VAULT_DOMAIN), /pool\/viewing-key/);
  assert.equal(expose(adopted, POOL_DOMAIN).at(-2), 0x12);
});

test("exactly one function mints a seed, and exactly one reads raw bytes", () => {
  // /usr/bin/grep, not the shell's: in this environment `grep` is a function wrapping
  // --ignore-files, and an audit that silently skips files is not an audit.
  // grep exits 1 on no match, which execFileSync throws for — and zero matches is the
  // interesting failure here, not an error.
  const count = (re: string) => {
    try {
      return execFileSync("/usr/bin/grep", ["-rhoE", re, join(HERE, "..", "src")], { encoding: "utf8" })
        .split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  assert.equal(count("^export function rootSeed\\b"), 1, "not exactly one place mints a Seed");
  // Entropy enters through a closed set of NAMED sources and nowhere else. This used to be a
  // `(bytes, provenance)` pair, which meant `entropyFrom(expose(poolSecret, …), "wallet")`
  // compiled — the escrowed key becoming the root of a real identity, with a reassuring string
  // beside it. The count is asserted so a new adapter is a deliberate act.
  // Six, and the last two were deliberate acts this line forced.
  //
  // `fromChannelWrap` (X3DH) is the only adapter whose material this system did not choose: the
  // initiator picks 32 bytes and wraps them to the recipient's prekey bundle. `fromStoredSeed`
  // is a client's own root read back off disk, which a client that can be restarted must do.
  //
  // Both are entropy SOURCES rather than adopt-style shortcuts, so the bytes are still
  // stretched through `rootSeed`/`derive` and never become a `Secret` directly.
  assert.equal(count("^export const from[A-Z][a-zA-Z]* = "), 6,
    "the set of external entropy sources changed — each one is a way key material gets in");
  assert.equal(count("^export function entropyFrom\\b"), 1, "more than one entropy entry point");
  assert.equal(count("^export function expose\\b"), 1, "not exactly one place reads raw key bytes");
  // And no other export may hand out a Uint8Array of key material.
  assert.equal(count("^export function [a-zA-Z]+[^;]*\\): Uint8Array"), 1,
    "a second export returns raw key bytes");
});

test("test material is never used outside a test", () => {
  // `fromTestVector` exists because tests need reproducible seeds, and hiding it behind a flag
  // would be worse than naming it. What makes that safe is that it never appears in `src/`.
  const hits = (() => {
    try {
      return execFileSync("/usr/bin/grep",
        ["-rl", "fromTestVector", join(HERE, "..", "src")], { encoding: "utf8" })
        .split("\n").filter(Boolean);
    } catch { return []; }
  })();
  assert.deepEqual(hits.filter((f) => !f.endsWith("domains.ts")), [],
    `test-vector entropy is used in production code:\n${hits.join("\n")}`);
});

test("the cross-domain derivation does not compile", () => {
  // The handoff's acceptance condition: the test "fails the build when deliberately
  // broken". This is that check. `i1-must-not-compile.ts` attempts every route from a
  // pool Secret into the vault domain; tsc must reject all of them.
  const local = join(HERE, "..", "node_modules", ".bin", "tsc");
  const shared = join(HERE, "..", "..", "..", "..", "packages", "linter", "node_modules", ".bin", "tsc");
  const tsc = existsSync(local) ? local : existsSync(shared) ? shared : null;
  // A missing type-checker is a FAILURE, not a skip. Treating an unrun build check as
  // green is exactly how a build-time guarantee stops being one.
  assert.ok(tsc, "no tsc — run `npm i -D typescript` in platform/packages/identity");

  let out = "";
  try {
    execFileSync(tsc, ["--noEmit", "-p", join(HERE, "..", "tsconfig.json")], { encoding: "utf8" });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const lines = out.split("\n").filter((l) => /error TS/.test(l));
  // Counted by DISTINCT LINE against the number of numbered attempts, not by error. Eight errors
  // across seven routes passes a count check while one route silently compiles — and the route
  // that compiles is the one that puts the escrowed pool key into the vault domain. The same
  // defect was fixed in `i5-blob-separation.test.ts` and `x3dh.test.ts`; this is the third.
  const fixture = lines.filter((l) => l.includes("i1-must-not-compile"));
  const offending = new Set(fixture.map((l) => l.match(/\((\d+),/)?.[1]).filter(Boolean));
  const attempts = readFileSync(join(HERE, "i1-must-not-compile.ts"), "utf8")
    .split("\n").filter((l) => /^\/\/ \d+[a-z]?\./.test(l)).length;
  assert.equal(offending.size, attempts,
    `${attempts} numbered routes, ${offending.size} rejected — one of them compiles:\n${out}`);
  // Nothing ELSE may fail to type-check, or this test passes for the wrong reason.
  const other = lines.filter((l) => !l.includes("i1-must-not-compile"));
  assert.deepEqual(other, [], `type errors outside the fixture:\n${other.join("\n")}`);
});
