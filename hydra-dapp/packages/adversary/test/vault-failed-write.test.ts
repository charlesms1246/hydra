/**
 * What a vault does when the disk refuses, which is the case nobody had driven.
 *
 * **THE SPEND WAS BEFORE THE ONLY STEP THAT CAN FAIL.** `#upload` checked the prefix, checked the
 * bucket, destroyed the invite, put the object in memory, and *then* wrote to disk. Four things
 * went wrong at once when that write failed, and they compound:
 *
 *   - the uploader was told it failed while readers could fetch it;
 *   - the object was on no disk and in no operator record, and vanished on restart;
 *   - **the invite was gone** — single use, operator-issued — and the client was told only
 *     "invite required", so it had to go back to the organisation and ask for another;
 *   - and the spend was DURABLE while the object was not, so the loss survived the restart that
 *     destroyed the object.
 *
 * The last is the sharpest: the fix that made spends survive a restart is what made this loss
 * permanent.
 *
 * **`restart-survival.test.ts` drives the invite lifecycle hard** — single use, survives restart,
 * unspent codes not eaten — and every case is on the SUCCESSFUL upload path. It establishes that
 * the spend is durable and never asks whether the spend is coupled to the outcome it buys. The
 * same shape as the `lock` refusal: a well-tested property adjacent to the one that matters.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault, MIN_READ_BATCH } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";

const BODY = new Uint8Array(BUCKETS[0]!);

/** A vault with a real store directory, so a real write can be made to fail. */
async function onDisk(invites: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "hydra-vault-"));
  const store = join(dir, "store");
  const v = new Vault({ invites: [...invites], buckets: BUCKETS, dir: store });
  const { url, server } = await serve(v);
  return {
    v, url, store, dir,
    close: () => { server.close(); chmodSync(store, 0o700); rmSync(dir, { recursive: true, force: true }); },
    put: (id: string, invite: string) => fetch(`${url}/v1/enc/${id}`, {
      method: "PUT", headers: { "x-hydra-invite": invite }, body: BODY,
    }),
    /**
     * Ask for ids and assert the READ ITSELF SUCCEEDED before reading the result.
     *
     * **THE FIRST VERSION ASKED FOR ONE ID AND ITS ASSERTION PASSED FOR THE WRONG REASON.** The
     * encrypted endpoint refuses a batch below `MIN_READ_BATCH`, because the claim that the
     * operator cannot tell which blob a reader wanted is only true of a batch. So the read was
     * REFUSED, `found` was absent, `?? {}` turned that into "nothing found", and the test reported
     * that a served object was not served. Caught by mutating the server to serve it and watching
     * the test stay green.
     *
     * Padded to the minimum, and the refusal is now an assertion rather than an empty result: a
     * measurement that fails must not be able to look like the answer it was checking for.
     */
    fetchIds: async (ids: string[]) => {
      const padded = [...ids];
      while (padded.length < MIN_READ_BATCH) padded.push(`enc:pad-${padded.length}`);
      const res = await fetch(`${url}/v1/enc`, { method: "POST", body: JSON.stringify(padded) });
      const body = await res.json() as { found?: Record<string, string>; error?: string };
      assert.ok(body.found, `the read itself was refused, so this says nothing about what is `
        + `stored: ${body.error ?? JSON.stringify(body)}`);
      return Object.keys(body.found);
    },
  };
}

test("A FAILED WRITE DOES NOT SPEND THE INVITE, AND DOES NOT SERVE THE OBJECT", async () => {
  const invites = ["code-one", "code-two"];
  const vault = await onDisk(invites);
  try {
    // A successful upload first, so the failure below is the only difference between them.
    assert.equal((await vault.put("enc:ok", "code-one")).status, 201);

    // Now the disk refuses. Same request shape, same valid invite.
    chmodSync(vault.store, 0o500);
    const refused = await vault.put("enc:lost", "code-two");
    assert.equal(refused.status, 400, "an unwritable store reported success");

    // IT IS NOT SERVED. It was, from `#objects`, while being on no disk at all.
    assert.deepEqual(await vault.fetchIds(["enc:lost"]), [],
      "the vault served an object it had told the uploader it failed to store, and which is on "
      + "no disk and in no operator record");

    // AND THE INVITE SURVIVES, which is the part that cost a source an approach to the
    // organisation that issued it.
    chmodSync(vault.store, 0o700);
    assert.equal((await vault.put("enc:lost", "code-two")).status, 201,
      "a write the vault refused still destroyed the invite, so the uploader must ask the "
      + "organisation for another code — the approach that identifies them");

    assert.ok(existsSync(join(vault.store, "enc:lost.blob")), "the retry stored nothing");
  } finally { vault.close(); }
});

test("AND A SUCCESSFUL WRITE STILL SPENDS IT", async () => {
  // The other half: not spending on failure must not have become not spending at all. Single use
  // is the whole of what an invite is.
  const vault = await onDisk(["only-code"]);
  try {
    assert.equal((await vault.put("enc:a", "only-code")).status, 201);
    const again = await vault.put("enc:b", "only-code");
    assert.equal(again.status, 400, "the same code bought a second upload");
    assert.match(JSON.stringify(await again.json()), /invite/);
  } finally { vault.close(); }
});

test("A FAILED WRITE DOES NOT PUT THE SERVER'S FILESYSTEM PATH ON THE WIRE", async () => {
  // What an anonymous caller used to receive:
  //     EACCES: permission denied, open '/tmp/…/store/enc:lost.blob'
  // The handler truncated to 80 characters and reasoned about the CALLER's bytes reaching stderr;
  // the outward direction was never considered. 72 characters fit under the limit — a length cap
  // is not a filter.
  const vault = await onDisk(["code-one"]);
  try {
    chmodSync(vault.store, 0o500);
    const res = await vault.put("enc:lost", "code-one");
    const body = JSON.stringify(await res.json());
    assert.ok(!body.includes(vault.store),
      `the refusal names the server's store path to an unauthenticated caller:\n  ${body}`);
    assert.ok(!body.includes(tmpdir()),
      `the refusal leaks a server-side absolute path:\n  ${body}`);
    assert.ok(!/EACCES|ENOENT|EPERM/.test(body),
      `the refusal leaks the operating system's error for a server-side failure:\n  ${body}`);
  } finally { vault.close(); }
});

test("NOTHING IS LEFT ON DISK BY A FAILED WRITE", async () => {
  // A half-written pair — blob without sidecar — would be an object the loader reassembles into
  // something nobody uploaded.
  const vault = await onDisk(["code-one"]);
  try {
    const before = readdirSync(vault.store);
    chmodSync(vault.store, 0o500);
    await vault.put("enc:lost", "code-one");
    chmodSync(vault.store, 0o700);
    assert.deepEqual(readdirSync(vault.store).sort(), before.sort(),
      "a refused upload left something in the store");
  } finally { vault.close(); }
});

test("NO INVITE AND A REJECTED INVITE ARE DIFFERENT REFUSALS", async () => {
  // **THREE FAILURES COLLAPSED INTO "invite required", which is true of one of them.** No header,
  // a code never issued, and a code already spent all said the same thing — so a client that
  // supplied a good code was told it had supplied none, and the case `main.ts` calls NORMAL
  // (running out, because cover spends codes at the cover rate) was the most misdescribed.
  const vault = await onDisk(["code-one"]);
  try {
    const none = await fetch(`${vault.url}/v1/enc/enc:x`, { method: "PUT", body: BODY });
    const noneSaid = JSON.stringify(await none.json());
    assert.match(noneSaid, /x-hydra-invite/,
      `a request with no invite is not told which header carries one:\n  ${noneSaid}`);

    const wrong = await vault.put("enc:y", "never-issued");
    const wrongSaid = JSON.stringify(await wrong.json());
    assert.ok(!/needs an invite/.test(wrongSaid),
      `a client that supplied an invite is told it supplied none:\n  ${wrongSaid}`);
    assert.match(wrongSaid, /already been used|not one this vault issued/,
      `the refusal does not say what was wrong with the code:\n  ${wrongSaid}`);
    assert.match(wrongSaid, /Ask whoever runs this vault/,
      `running out is the expected failure and the refusal names no remedy:\n  ${wrongSaid}`);

    // AND SPENT READS THE SAME AS WRONG, deliberately — see the argument in `server.ts`. Asserted
    // so the merge is a decision the tests hold rather than an accident somebody tidies away.
    assert.equal((await vault.put("enc:a", "code-one")).status, 201);
    const spent = await vault.put("enc:b", "code-one");
    assert.equal(JSON.stringify(await spent.json()), wrongSaid,
      "a spent code and a code that was never issued give different answers, which tells anyone "
      + "holding a code they were not given whether it is still live");
  } finally { vault.close(); }
});
