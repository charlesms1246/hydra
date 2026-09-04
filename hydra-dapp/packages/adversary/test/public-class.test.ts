/**
 * The public class, end to end — the surface that existed everywhere except in a client.
 *
 * `decisions/0035` scoped the whole moderation pipeline to "public blobs only". The vault serves
 * `/v1/pub`, `RemovalAuthority` guards takedowns of it, report intake refuses anything that is not
 * a `pub:` id, the transparency report filters on the same prefix, and `removedIds` publishes the
 * ids of removed public objects.
 *
 * **AND NO CLIENT COULD CREATE ONE OR READ ONE.** `publish()` had no caller outside tests, the only
 * two `class: "public"` constructions in the repo were both inside `blobs.ts`, and no client source
 * touched `PUBLIC_ENDPOINT`. An operator tool, an intake endpoint, an appeal path and a
 * transparency report had been built for a class of object no user could bring into existence.
 *
 * It hid behind a name: `hydra publish` means "sign this so anyone holding your bundle can prove
 * you wrote it" — a claim about attribution INSIDE AN ENCRYPTED CHANNEL — and reads like the public
 * surface. The commands are `post` and `fetch` for that reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Vault, PUBLIC_ENDPOINT } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { publish, publicIdFor, openPublic, wireBytes } from "../../vault-client/src/blobs.ts";
import { postPublic, fetchPublic, describePost, describeFetch }
  from "../../client/src/public.ts";
import { OBSERVABLE_IDS } from "../../vault-server/src/observations.ts";

const intent = { confirmedPublicAt: "2026-09-04T00:00:00Z", reason: "public-class test" };
const bytes = (b: Parameters<typeof wireBytes>[0]) => wireBytes(b) as unknown as Uint8Array;

async function withVault(
  invites: string[],
  fn: (url: string, vault: Vault) => Promise<void>,
) {
  const vault = new Vault({ invites, buckets: BUCKETS });
  const { url, server } = await serve(vault);
  try { await fn(url, vault); } finally { server.close(); }
}

test("A POST CAN BE MADE AND READ BACK, which no client could do", async () => {
  await withVault(["inv-0"], async (url) => {
    const text = "a statement made in public, on purpose";
    const blob = await postPublic(url, new TextEncoder().encode(text), intent, "inv-0");
    assert.match(blob.id, /^pub:/);

    const { found, missing, substituted } = await fetchPublic(url, [blob.id]);
    assert.deepEqual(missing, []);
    assert.deepEqual(substituted, []);
    assert.equal(new TextDecoder().decode(found.get(blob.id)!), text,
      "the post did not survive the round trip");
  });
});

test("THE PADDING COMES OFF EXACTLY, whatever the length", async () => {
  // The length prefix lives inside the padded region, so this is the check that it is being read
  // back rather than the plaintext being whatever survived the bucket.
  await withVault(Array.from({ length: 6 }, (_, i) => `inv-${i}`), async (url) => {
    for (const [i, n] of [0, 1, 17, 800, 1020].entries()) {
      const body = new Uint8Array(n).fill(0xab);
      const blob = await postPublic(url, body, intent, `inv-${i}`);
      const { found } = await fetchPublic(url, [blob.id]);
      const back = found.get(blob.id)!;
      assert.equal(back.length, n, `a ${n}-byte post came back ${back.length} bytes`);
      assert.ok(back.every((b) => b === 0xab));
    }
  });
});

test("A SUBSTITUTED BLOB IS REFUSED, and the public class needs no key to substitute", async () => {
  // The attack the encrypted class has been guarded against since `conversation.test.ts` and the
  // public class had no guard for at all — because nothing fetched a public blob, so nothing could
  // check one. It is EASIER here: every encrypted message in a channel opens under one key, so a
  // swap yields real plaintext in the wrong place; a public object needs no key, so a swap costs
  // the operator nothing whatsoever and reads as genuine.
  await withVault(["a", "b"], async (url) => {
    const one = await postPublic(url, new TextEncoder().encode("the real statement"), intent, "a");
    const two = await postPublic(url, new TextEncoder().encode("something else entirely"),
      intent, "b");

    // A vault that answers one id with the other's bytes.
    const lying: typeof fetch = async (input, init) => {
      const res = await fetch(input as string, init);
      if (!String(input).endsWith(PUBLIC_ENDPOINT)) return res;
      const body = await res.json() as { found: Record<string, string> };
      return new Response(JSON.stringify({ found: { [one.id]: body.found[two.id] } }),
        { headers: { "content-type": "application/json" } });
    };
    const { found, substituted } = await fetchPublic(url, [one.id, two.id], lying);
    assert.deepEqual(substituted, [one.id], "the substitution was not detected");
    assert.equal(found.size, 0, "substituted bytes were returned as content");

    // And the check is against the id ASKED FOR, not one derived from what arrived — deriving from
    // the response makes every answer self-consistent and the check vacuous.
    assert.throws(() => openPublic(one.id, bytes(two)), /does not hash to its bytes/);
    assert.equal(publicIdFor(bytes(two)), two.id);
  });
});

test("a missing post is not distinguishable from a removed or expired one", async () => {
  await withVault([], async (url) => {
    const { found, missing, substituted } = await fetchPublic(url, ["pub:deadbeef"]);
    assert.equal(found.size, 0);
    assert.deepEqual(missing, ["pub:deadbeef"]);
    assert.deepEqual(substituted, []);
  });
});

test("WHAT IT COSTS IS SAID BEFORE IT HAPPENS, on the page that performs the act", () => {
  // Rule 7. Both of these go in front of a person immediately before they act, and each carries
  // the thing that is genuinely different about the public class rather than a generic warning.
  const post = describePost().join(" ");
  assert.match(post, /THIS IS PUBLIC/);
  // The one people get wrong: removal is not unpublishing.
  assert.match(post, /cannot be unpublished/);
  // And the timing, which the encrypted class defends and this one cannot.
  assert.match(post, /no jitter and no cover/);

  const read = describeFetch(["pub:abc"]).join(" ");
  assert.match(read, /wanted\s+exactly that/);
  // It must not claim padding it does not do.
  assert.ok(!/decoy|padded batch/i.test(read) || /cannot be padded/.test(read),
    "the fetch warning implies a padding defence the public class does not have");
  assert.match(read, /content-addressed, so a copy from anywhere verifies the same/);
});

test("the disclosure table carries the public read, which nothing else covered", () => {
  // `read.hit` says decoy padding is free because a miss looks like an object never sent — true,
  // and it does not rescue this. A channel read asks for its whole DERIVED set, so `read.channelSet`
  // leaks the grouping rather than which object was wanted. A public id is wanted on its own.
  //
  // The exemption was already in the code — `server.ts` skips the minimum batch for the public
  // endpoint "by design", because the id is the capability there — and nothing said what the
  // exemption cost. Rule 4: a capability whose exposure is undocumented is unfinished.
  assert.ok(OBSERVABLE_IDS.includes("read.publicObject"),
    "a public read names one object and no row says so");
});
