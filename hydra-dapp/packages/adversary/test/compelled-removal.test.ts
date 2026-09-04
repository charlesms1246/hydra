/**
 * Removing an encrypted object under legal process — `DECISIONS-NEEDED.md` D6.
 *
 * **THE POSITION IN `decisions/0035` §1 CHANGED AND THE OLD REASONING WAS NOT WRONG.** It held that
 * an encrypted object the operator can delete on request is one they can be compelled to delete,
 * and that they cannot know what they are deleting — so the class got a capability instead, with no
 * operator discretion in it. That argument still stands. The decision is that the ordered, auditable
 * version is worth its cost anyway, because the alternative is not the absence of compelled removal:
 * it is an operator complying off the record with nothing counting it.
 *
 * So every test here is a constraint on the path rather than a demonstration that it works.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault, ENCRYPTED_ENDPOINT, PUBLIC_ENDPOINT } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { compelledAuthorityFromFile, compels, MIN_LENGTH }
  from "../../vault-server/src/compelled.ts";
import { removalAuthorityFromFile } from "../../vault-server/src/authority.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { publish, wireBytes } from "../../vault-client/src/blobs.ts";
import { MIN_READ_BATCH } from "../../client/src/read.ts";
import { deleteHashFor } from "../../vault-server/src/delete-hash.ts";

const PROCESS_SECRET = "a-long-enough-compelled-removal-secret";
const REMOVAL_SECRET = "a-long-enough-operator-secret";
const bytes = (b: Parameters<typeof wireBytes>[0]) => wireBytes(b) as unknown as Uint8Array;

async function withVault(fn: (ctx: {
  url: string; vault: Vault; enc: string; pub: string;
  del: (id: string, headers: Record<string, string>) => Promise<Response>;
  batch: (ids: string[]) => Promise<{ found: Record<string, string>; removed?: string[] }>;
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "hydra-compel-"));
  await writeFile(join(dir, "compel"), `${PROCESS_SECRET}\n`);
  await writeFile(join(dir, "removal"), `${REMOVAL_SECRET}\n`);
  const vault = new Vault({ invites: ["a", "b", "c"], buckets: BUCKETS });
  const { url, server } = await serve(vault, 0, {
    compelledAuthority: compelledAuthorityFromFile(join(dir, "compel")),
    removalToken: removalAuthorityFromFile(join(dir, "removal")),
  });
  const enc = "enc:00112233445566778899aabbccddeeff";
  const post = publish(new TextEncoder().encode("a public statement"),
    { confirmedPublicAt: "2026-09-04T00:00:00Z", reason: "compel test" });
  try {
    await fetch(`${url}${ENCRYPTED_ENDPOINT}/${enc}`, {
      method: "PUT", headers: { "x-hydra-invite": "a" }, body: new Uint8Array(BUCKETS[0]),
    });
    await fetch(`${url}${PUBLIC_ENDPOINT}/${post.id}`, {
      method: "PUT", headers: { "x-hydra-invite": "b" }, body: bytes(post),
    });
    await fn({
      url, vault, enc, pub: post.id,
      del: (id, headers) => fetch(`${url}${ENCRYPTED_ENDPOINT}/${id}`, { method: "DELETE", headers }),
      // PADDED TO `MIN_READ_BATCH`, because the vault refuses a smaller encrypted read — asking
      // for one id would say which one you wanted, and that is enforced server-side rather than
      // left to clients. The first version of this helper asked for a single id and got an error
      // object back, which is the rule working.
      batch: async (ids) => {
        const padded = [...ids];
        for (let i = padded.length; i < MIN_READ_BATCH; i++) padded.push(`enc:pad${i}`);
        return (await (await fetch(`${url}${ENCRYPTED_ENDPOINT}`,
          { method: "POST", body: JSON.stringify(padded) })).json()) as never;
      },
    });
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
}

test("A COMPELLED REMOVAL IS DETECTABLE BY THE AFFECTED PARTIES — not just an absence", async () => {
  // THE CONSTRAINT THAT MATTERS MOST. `read.hit` makes a miss indistinguishable from an object that
  // expired or was never sent, which is true and is what makes decoy padding free. If it held here
  // too, a compelled removal would be invisible to the people it happened to, and the whole path
  // would be a backdoor with paperwork.
  await withVault(async ({ enc, del, batch }) => {
    assert.equal((await batch([enc])).found[enc] !== undefined, true, "the object is not there");

    const res = await del(enc, {
      "x-hydra-compelled": PROCESS_SECRET, "x-hydra-process-reference": "case 1234/A",
    });
    assert.equal(res.status, 200);

    const after = await batch([enc]);
    assert.equal(after.found[enc], undefined, "the object survived");
    assert.deepEqual(after.removed, [enc],
      "a compelled removal answered as a plain miss — the people it happened to cannot tell it "
      + "from expiry, which makes this a backdoor with paperwork");

    // AND IT DOES NOT COST THE PADDING PROPERTY. A decoy is an id nobody removed, so it still
    // answers as an ordinary miss; only a real participant holds an id that answers `removed`.
    const padded = await batch([enc, "enc:decoy1", "enc:decoy2"]);
    assert.deepEqual(padded.removed, [enc]);
  });
});

test("A CAPABILITY DELETE LEAVES NO TOMBSTONE, because it is nobody else's business", async () => {
  // A participant deleting their own message is not an outside party reaching in, and advertising
  // it to their counterparty would turn a private act into a notification.
  await withVault(async ({ url, vault, batch }) => {
    const id = "enc:aabbccddeeff00112233445566778899";
    // The upload carries the HASH and the delete carries the TOKEN — the server never sees the
    // preimage until somebody exercises the capability, which is what makes it a capability.
    const token = new Uint8Array(Buffer.from("cafebabe".repeat(8), "hex"));
    await fetch(`${url}${ENCRYPTED_ENDPOINT}/${id}`, {
      method: "PUT",
      headers: { "x-hydra-invite": "c", "x-hydra-delete-hash": deleteHashFor(token) },
      body: new Uint8Array(BUCKETS[0]),
    });
    const gone = vault.handle({ op: "remove", id, token }) as { removed?: boolean };
    assert.equal(gone.removed, true, "the capability delete did not take effect");
    const after = await batch([id]);
    assert.equal(after.found[id], undefined);
    assert.equal(after.removed, undefined,
      "a user deleting their own message was announced to their counterparty");
  });
});

test("THE TWO AUTHORITIES ARE SEPARATE — one never implies the other", async () => {
  // Possession of a public-takedown secret must not reach into private messages, or routine
  // moderation escalates into exactly the drift the class split was built to prevent.
  await withVault(async ({ enc, del, batch }) => {
    // The removal secret, offered as a compelled one.
    assert.equal((await del(enc, {
      "x-hydra-compelled": REMOVAL_SECRET, "x-hydra-process-reference": "case 1",
    })).status, 404);
    // And nothing at all.
    assert.equal((await del(enc, { "x-hydra-compelled": "guess" })).status, 404);
    assert.equal((await batch([enc])).found[enc] !== undefined, true,
      "an encrypted object was removed by something other than the compelled authority");

    // A compelled removal with no process reference is refused: an untraceable one is the outcome
    // this whole path exists to prevent.
    assert.equal((await del(enc, { "x-hydra-compelled": PROCESS_SECRET })).status, 400);
    assert.equal((await del(enc, {
      "x-hydra-compelled": PROCESS_SECRET, "x-hydra-process-reference": "   ",
    })).status, 400);
    assert.equal((await batch([enc])).found[enc] !== undefined, true);
  });
});

test("it is PER ID and encrypted-only, with no bulk form anywhere", async () => {
  await withVault(async ({ pub, vault, url }) => {
    // The public class has its own authority and its own path; this one must not reach it.
    assert.equal(vault.compel(pub, "case 2"), null,
      "a compelled removal reached a public object, collapsing two powers kept apart on purpose");
    assert.equal((await (await fetch(`${url}${PUBLIC_ENDPOINT}`,
      { method: "POST", body: JSON.stringify([pub]) })).json() as
      { found: Record<string, string> }).found[pub] !== undefined, true);

    // An object that was never here records nothing — inventing a tombstone would let anyone
    // holding the authority manufacture evidence that something existed.
    assert.equal(vault.compel("enc:neverhere", "case 3"), null);
    assert.deepEqual(vault.compelledRemovals().map((r) => r.blobId), []);
  });
});

test("the record is four fields and none of them is about content", async () => {
  await withVault(async ({ enc, vault }) => {
    const record = vault.compel(enc, "case 1234/A")!;
    assert.deepEqual(Object.keys(record).sort(), ["at", "blobId", "reference", "underProcess"]);
    assert.equal(record.underProcess, true);
    // An operator asserting what an encrypted object contained is asserting something they cannot
    // know, and a field for it is a field that will eventually hold a guess.
    assert.ok(!JSON.stringify(record).toLowerCase().includes("content"));
  });
});

test("the secret is longer than a removal secret, and neither mint takes a value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hydra-compel-mint-"));
  try {
    await writeFile(join(dir, "short"), "x".repeat(MIN_LENGTH - 1));
    assert.throws(() => compelledAuthorityFromFile(join(dir, "short")),
      /reaches into encrypted objects and is guessable/);
    await writeFile(join(dir, "ok"), "x".repeat(MIN_LENGTH));
    assert.doesNotThrow(() => compelledAuthorityFromFile(join(dir, "ok")));
    // Longer than a removal secret on purpose: this reaches into a conversation the operator
    // cannot read, and configuring the two should not feel like the same act.
    assert.ok(MIN_LENGTH > 16);
    // Constant time, and undefined authority refuses everything — an operator who has not decided
    // they will comply with process has not decided that anyone may.
    assert.equal(compels("anything", undefined), false);
    assert.equal(compels(["x".repeat(MIN_LENGTH)], compelledAuthorityFromFile(join(dir, "ok"))),
      false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("THE PUBLIC PATH'S INDISTINGUISHABILITY IS INTACT — the two answers must not meet", async () => {
  // `hydra fetch` tells a user the vault answers removed, expired and never-posted identically,
  // on purpose, for PUBLIC objects. `D6` makes a compelled removal answer `removed`. Those are
  // only compatible because compulsion reaches the encrypted class alone:
  //
  //   - An ENCRYPTED id is known to channel members and nobody else, so telling a holder it was
  //     removed discloses nothing to anyone not already entitled to know.
  //   - A PUBLIC id is a public value. The same answer would let anybody enumerate which public
  //     objects were taken down — a disclosure the operator makes on the subject's behalf.
  //
  // Asserted rather than inferred from "compel refuses a public object", because the two answers
  // now live in one codebase and nothing but this keeps them apart.
  await withVault(async ({ url, enc, pub, vault, del }) => {
    await del(enc, {
      "x-hydra-compelled": PROCESS_SECRET, "x-hydra-process-reference": "case 9",
    });
    assert.equal(vault.compelledRemovals().length, 1);

    // A public read naming the compelled ENCRYPTED id must not answer about it. The id is on the
    // wrong endpoint, and a caller who has it learned it somewhere this vault is not responsible
    // for — it must still not be confirmed here.
    const crossed = await (await fetch(`${url}${PUBLIC_ENDPOINT}`,
      { method: "POST", body: JSON.stringify([pub, enc]) })).json() as
      { found: Record<string, string>; removed?: string[] };
    assert.equal(crossed.removed, undefined,
      "a read on the PUBLIC endpoint answered about a compelled encrypted object — the two "
      + "classes' answers have met, and a public id would then be enumerable the same way");

    // And a public object that really is gone answers as a plain miss, exactly as before: removed,
    // expired and never-posted stay indistinguishable on that path.
    const takenDown = await fetch(`${url}${PUBLIC_ENDPOINT}/${pub}`,
      { method: "DELETE", headers: { "x-hydra-removal": REMOVAL_SECRET } });
    assert.equal(takenDown.status, 200);
    const after = await (await fetch(`${url}${PUBLIC_ENDPOINT}`,
      { method: "POST", body: JSON.stringify([pub, "pub:neverexisted"]) })).json() as
      { found: Record<string, string>; removed?: string[] };
    assert.deepEqual(after.found, {});
    assert.equal(after.removed, undefined,
      "a public takedown became distinguishable from an object that never existed");
  });
});

/** Store an object the way a client does — through the request path, not a back door. */
function putObject(vault: Vault, blobId: string, invite: string): void {
  const res = vault.handle({
    op: "upload", endpoint: ENCRYPTED_ENDPOINT, id: blobId,
    body: new Uint8Array(BUCKETS[0]!), invite,
  });
  assert.ok(res.ok, `the vault refused the object (${JSON.stringify(res)})`);
}

/** True when the vault will not serve this id. */
function gone(vault: Vault, blobId: string): boolean {
  const res = vault.handle({ op: "fetch", endpoint: ENCRYPTED_ENDPOINT, ids: [blobId] });
  return !(res.ok && res.op === "fetch" && res.found.get(blobId) !== undefined);
}

/**
 * **THE TOMBSTONE MUST OUTLIVE THE PROCESS, AND IT DID NOT.**
 *
 * Found by driving compelled removal against a real vault process for the first time. `#compelled`
 * was an in-memory `Map`, so a restart — a deploy, a crash, a reboot — silently reverted a
 * compelled removal to an ordinary absence. Measured: the affected party's client reported the
 * removal under legal process, the vault was restarted, and the next read said **nothing at all**.
 * The message was simply not there.
 *
 * That is the single outcome the mechanism exists to prevent. `decisions/0035` and the
 * `compelled.removal` row both rest on the removal being distinguishable from expiry **by the
 * people it happened to** — and the operator's own record in `moderation-queue.json` survived the
 * restart while theirs did not. **The party being audited kept the evidence; the parties affected
 * lost it.**
 *
 * Not reachable by any hermetic test that builds one `Vault` and asks it questions: the defect is
 * entirely in what does not cross a process boundary.
 */
test("A COMPELLED REMOVAL IS STILL A COMPELLED REMOVAL AFTER A RESTART", () => {
  const dir = mkdtempSync(join(tmpdir(), "hydra-compelled-"));
  const id = `${ENCRYPTED_ENDPOINT.slice(4)}:${"a".repeat(62)}`.replace(/^\//, "");
  const blobId = `enc:${"a".repeat(62)}`;

  const first = new Vault({ dir, invites: ["code"] });
  putObject(first, blobId, "code");
  assert.ok(first.compel(blobId, "CASE-1"), "the object was not there to compel");
  assert.equal(first.compelledRemovals().length, 1);

  // A NEW PROCESS over the same directory. This is the whole test.
  const second = new Vault({ dir, invites: ["code"] });
  const survived = second.compelledRemovals();
  assert.equal(survived.length, 1,
    "the compelled removal did not survive a restart, so it now looks like ordinary expiry to "
    + "the people it happened to");
  assert.equal(survived[0]!.blobId, blobId);
  assert.equal(survived[0]!.reference, "CASE-1");
  assert.equal(survived[0]!.underProcess, true);

  // And the object really is gone — a tombstone that resurrected the bytes would be worse than
  // no tombstone at all.
  assert.equal(gone(second, blobId), true,
    "a restart brought back an object removed under process");
  void id;
});

test("the tombstone file is not mistaken for an object's metadata", () => {
  // `#load` treats every `.json` in the store as a sidecar. A tombstone parsed as an object would
  // resurrect the very id it exists to record the removal of, which is why it is not named `.json`.
  const dir = mkdtempSync(join(tmpdir(), "hydra-compelled-"));
  const blobId = `enc:${"b".repeat(62)}`;
  const first = new Vault({ dir, invites: ["code"] });
  putObject(first, blobId, "code");
  first.compel(blobId, "CASE-2");

  assert.ok(!Vault.COMPELLED_FILE.endsWith(".json"),
    "the tombstone file ends in .json, so the loader will read it as an object sidecar");
  const restarted = new Vault({ dir, invites: ["code"] });
  assert.equal(gone(restarted, blobId), true);
  assert.equal(restarted.compelledRemovals().length, 1);
});

test("a vault with no directory still compels, and simply keeps nothing", () => {
  // The in-memory configuration is what every other test uses; persistence must not become a
  // precondition for the mechanism working at all.
  const v = new Vault({ invites: ["code"] });
  const blobId = `enc:${"c".repeat(62)}`;
  putObject(v, blobId, "code");
  assert.ok(v.compel(blobId, "CASE-3"));
  assert.equal(v.compelledRemovals().length, 1);
});
