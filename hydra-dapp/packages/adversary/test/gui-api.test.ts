/**
 * The local API a GUI drives — and I6 first, before anything else in this file.
 *
 * **THE BROWSER GETS NO KEY MATERIAL, EVER.** The page sends commands and renders results; the
 * seed, the prekey privates and a channel's addressing keys stay in the local process. An API is
 * the obvious way to create a path around that guarantee, because a response body is just JSON and
 * nobody notices a field until it is in production.
 *
 * **SEARCHED BY VALUE, NOT BY FIELD NAME.** The guard reads the ACTUAL secrets out of a real state
 * and looks for those strings in every response. A check for field names — `seedHex`, `private` —
 * is the wording-not-property mistake in its purest form: it passes the moment somebody renames a
 * field, nests it, or serialises it some other way, and it would not have caught the thing it
 * exists to catch. A substring of the real secret cannot be renamed away.
 *
 * It also sweeps every long string in the state generically, so a secret nobody thought to
 * enumerate is caught by the same test. The exclusions are BY VALUE — the contract address and the
 * URLs, which are public and belong in a response — rather than by field, for the same reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import { request } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeOf } from "../src/prose.ts";
import { randomBytes } from "node:crypto";

import { guiServer, problemOf, type FlushAttempt, type StateSource }
  from "../../gui/src/server.ts";
import { serialise, type Exclusive } from "../../gui/src/serialise.ts";
import { init, publishBundle, open, accept, sendMessage, readChannel, flush,
  encodeWire, openAndSend, rotatePrekey, fetchPosts, SIGNED_MARK, UNVERIFIABLE_MARK }
  from "../../cli/src/commands.ts";
import { describePost } from "../../client/src/public.ts";
import { memoryChain } from "../../cli/src/chain.ts";
import { MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";
import type { State } from "../../cli/src/state.ts";
import { Vault } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { describe as describeLinkability, NOT_DISCOUNTED } from "../../channel/src/crowd.ts";
import { recordFor, encodeRecord, RECORD_FELTS } from "../../handshake/src/record.ts";
import { createStore, mintOneTime } from "../../handshake/src/prekeys.ts";
import { rootSeed, entropyFrom, fromTestVector, derive, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import { LOOKUP_KEY_NOT_PERSON, LOOKUP_NO_ONE_TIME, LOOKUP_NODE_SEES,
  INVITE_VAULT_SEES, INVITE_UNSCHEDULED } from "../../claims/src/warnings.ts";

const GUI = join(import.meta.dirname, "..", "..", "gui", "src");
const TOKEN = "0123456789abcdef0123456789abcdef";
/**
 * A THIRD PARTY WHO HAS PUBLISHED A RECORD, and a node that will serve it.
 *
 * The whole point of `lookup` is a peer the client has never met and holds no file from, so the
 * fixture has to be somebody neither `alice` nor `bob` has ever spoken to. `ORG_ADDRESS` is the
 * one `bundle-lookup.test.ts` uses, against the same encoder.
 */
const ORG_ADDRESS = "0x2afa2039a4173a1c327f6bb87d49bac815c5c50dfd9afa57f24609c2426c157";
const NO_RECORD = "0x2993";
const orgStore = (() => { const s = createStore(); mintOneTime(s, 2); return s; })();
const org = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(21), "an organisation"))));

/**
 * A `fetch` that is a node for the RPC and the real vault for everything else.
 *
 * **THE SPLIT IS THE INSTRUMENT.** Every request a lookup makes lands in `asked`, so a test can
 * assert on the ORDER and the DESTINATIONS rather than on the result — which is the only way to
 * check the property `LOOKUP_NODE_SEES` actually claims.
 */
function nodeAndVault(state: State, asked: string[] = []): { fetchImpl: typeof fetch;
  asked: string[] } {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    asked.push(at);
    if (!at.startsWith(state.rpcUrl)) return fetch(url as string, init);
    const req = JSON.parse(String(init?.body)) as
      { params: { request: { calldata: string[] } } };
    const isIdLookup = req.params.request.calldata.length === 1;
    // The address is the first felt of the id call; anything but the organisation owns nothing.
    const wanted = BigInt(req.params.request.calldata[0]!) === BigInt(ORG_ADDRESS);
    const felts = encodeRecord(recordFor(org, orgStore, BigInt(ORG_ADDRESS)));
    const result = isIdLookup
      ? [wanted ? "0x1092" : "0x0"]
      : [`0x${RECORD_FELTS.toString(16)}`, ...felts.map((f) => `0x${f.toString(16)}`)];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
      { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

const BLOCK = 30_000;
const T0 = 1_800_000_000_000;
const FILE = "/home/somebody/.hydra-msg/state.json";

/**
 * Two clients that have really spoken, so channels and history hold real key material.
 *
 * A REAL VAULT ON A REAL SOCKET. The first version pointed at `127.0.0.1:8080` with nothing
 * listening, and every test in this file failed after 10.5 seconds — undici's connect timeout,
 * which is the same signature that made the TUI suite take three and a half minutes. A fixture
 * that is merely absent is not a fixture.
 */
async function conversed(): Promise<{ alice: State; bob: State; close: () => void }> {
  // REAL-SHAPED CODES, 128 bits of hex, because the vault mints them that way and because a
  // five-character `inv-0` makes the I6 search meaningless — it would match any prose that
  // happened to contain it, and it is too short to be a credible secret to hunt for.
  const invites = Array.from({ length: 40 }, () => randomBytes(16).toString("hex"));
  const v = new Vault({ invites: [...invites], buckets: BUCKETS });
  const { url, server } = await serve(v);
  const alice = init({ vaultUrl: url, contract: "0xc0ffee", fromBlock: 7,
    blockMs: BLOCK, invites: [...invites] });
  const bob = init({ vaultUrl: url, contract: "0xc0ffee", fromBlock: 7,
    blockMs: BLOCK, invites: [...invites] });
  accept(bob, "with-alice", open(alice, "with-bob", publishBundle(bob)));
  const chain = memoryChain();
  const sent = await sendMessage(alice, chain, "with-bob", "ephemeral", "the usual place", T0);
  await flush(alice, sent.uploadAt + MIN_JITTER_BLOCKS * BLOCK, undefined, Infinity);
  await readChannel(bob, chain, "with-alice");
  return { alice, bob, close: () => server.close() };
}

async function running(source: StateSource, token = TOKEN, over: Partial<{
  chainFor: (s: State) => never; now: () => number; exclusive: Exclusive;
  stateNow: () => StateSource; save: (s: State) => void;
  lastFlush: () => FlushAttempt | null; fetchImpl: typeof fetch;
}> = {}) {
  const saved: State[] = [];
  // Every `stateNow` the server takes, in order. A concurrency test needs to know WHEN a handler
  // reached its snapshot, not just what was in it — see the G1 test, which is meaningless without
  // evidence that the two requests actually overlapped.
  const snapshots: StateSource[] = [];
  const base_ = { stateNow: () => source, save: (s: State) => { saved.push(s); }, ...over };
  const server = guiServer({
    token,
    chainFor: (s) => memoryChain() as never,
    // A node that serves nothing by default. A test that means to look somebody UP passes its own;
    // one that does not must still not reach the real network by accident, and a default of the
    // global `fetch` is how a suite acquires a 10.5-second undici timeout it cannot explain.
    fetchImpl: (async () => { throw new Error("this test did not expect a network request"); }
    ) as unknown as typeof fetch,
    now: () => T0,
    exclusive: serialise(),
    lastFlush: () => null,
    ...over,
    stateNow: () => { const got = base_.stateNow(); snapshots.push(got); return got; },
    save: base_.save,
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const get = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { headers: { "x-hydra-token": token }, ...init });
  return { server, base, saved, snapshots, get, close: () => server.close() };
}

/**
 * Every route, with the method that reaches it.
 *
 * **THE WRITE ROUTES WERE MISSING AND THAT IS THE GUARD GAP, NOT A LEAK.** Swept by hand against
 * the real secrets when they were added: nothing leaked. But `send`, `read` and `flush` are the
 * routes whose responses are BUILT from a fresh operation rather than from stored state — a read
 * returns what just came off the vault, a send returns what `sendMessage` just produced — so they
 * are where a new field carrying key material would first appear, and they were the three the
 * sweep did not look at. Same shape as an entry-point list that had quietly stopped covering seven
 * pages: the check was not wrong, it had stopped being complete.
 */
const ROUTES = (channel: string, bundle = ""): [string, string, unknown?][] => [
  ["GET", "/v1/gui/status"],
  ["GET", "/v1/gui/channels"],
  ["GET", `/v1/gui/channels/${channel}/messages`],
  // FIRST OF THE WRITES BECAUSE IT IS THE ONE THAT BUILDS A RESPONSE FROM A STRANGER'S KEYS.
  // `lookup` decodes a bundle off the chain and opens a channel from it, so it handles material
  // that did not come out of this state at all — which is a new way for the sweep below to be
  // incomplete rather than an old one repeated, and it is a route whose response is constructed
  // rather than stored.
  ["POST", "/v1/gui/lookup", { name: "swept", address: ORG_ADDRESS }],
  // `invite` for the same reason as `lookup` — a response built from a bundle that did not come
  // out of this state — and `collect` because it is the only route whose result comes off the
  // VAULT rather than out of stored state or the chain, so it is the one place a mailbox object
  // could arrive carrying more than it should.
  ["POST", "/v1/gui/invite", { name: "swept-invite", bundle }],
  ["POST", "/v1/gui/collect"],
  ["POST", `/v1/gui/channels/${channel}/send`, { text: "swept" }],
  ["POST", `/v1/gui/channels/${channel}/read`],
  ["POST", "/v1/gui/flush"],
  // AND THE PUBLIC CLASS, WHICH IS THE ONE ROUTE WHOSE OUTPUT IS PUBLIC BY CONSTRUCTION. Every
  // other response here is read by the page that asked; a post's id is meant to be handed to
  // strangers, so a secret that reached this response would be a secret the caller is being
  // encouraged to distribute. Included in the sweep for that reason and not for symmetry.
  ["POST", "/v1/gui/post", { text: "swept", reason: "swept" }],
  ["GET", "/v1/gui/post"],
];

/**
 * The values in a state that are public by construction, BY VALUE.
 *
 * Shared by the two guards that need it, so there is one list to audit rather than two that drift.
 * A field-name exclusion would let a secret through the moment somebody renamed or nested it;
 * naming the value means each entry says "this exact string is public", which is checkable.
 */
function publicValues(state: State): Set<string> {
  return new Set<string>([
    state.contract, state.rpcUrl, state.vaultUrl, FILE,
    // A PEER FINGERPRINT IS A HASH OF TWO PUBLIC KEYS and it is the thing users read to each other
    // out of band to check they are talking to who they think. Its second half is the first 16 hex
    // of the peer's SIGNING key, public by construction. Withholding it would break the only
    // verification a human can perform.
    ...Object.values(state.channels).map((c) => c.peer),
    // A BLOB ID IS THE PUBLIC HANDLE the vault is asked for by anyone fetching the object, and
    // `vault-server/src/observations.ts` already publishes that the operator sees it.
    //
    // **AND THAT REASON IS NOT SUFFICIENT ON ITS OWN, WHICH IS WHY THE REAL ONE IS HERE.**
    // `deletion.ts` says a blob id is not a delete capability and is public by construction —
    // true, and it does not settle this, because a vault object's id IS the address you present to
    // fetch it, so "public" and "harmless in a browser" are two claims and only the first was
    // made. The exclusion is justified by I6 itself: an id is safe in a page precisely because
    // what makes the object READABLE is the content key, and the content key is the thing I6
    // forbids ever reaching the browser — asserted directly, by value, in the sweep below. Take
    // that assertion away and this exclusion stops being true. Written out because an exclusion
    // resting on its own conclusion is the kind that survives a review and should not.
    ...Object.values(state.channels).flatMap((c) => c.history.map((h) => h.id)),
  ]);
}

/** Every string in the state long enough to be key material. Recursive, so nothing is missed. */
function longStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") { if (value.length >= 32) out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) longStrings(v, out); return out; }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) longStrings(v, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// I6 — first in the file, so every endpoint is born under it.
// ---------------------------------------------------------------------------

test("I6: NO RESPONSE CARRIES KEY MATERIAL — searched by value, not by field name", async () => {
  const { alice, bob, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE },
    TOKEN, { fetchImpl: nodeAndVault(alice).fetchImpl });
  try {
    const bodies: string[] = [];
    // BOB'S REAL BUNDLE, so `invite` handles key material that did not come out of the state this
    // API is serving — the sweep then covers a response constructed from somebody else's keys.
    for (const [method, route, payload] of ROUTES("with-bob", encodeWire(publishBundle(bob)))) {
      bodies.push(await (await api.get(route, method === "GET" ? {} : {
        method, ...(payload ? { body: JSON.stringify(payload) } : {}),
      })).text());
    }
    const all = bodies.join("\n");
    // A sweep of six empty bodies proves nothing, and a route that 500s returns a short one.
    assert.ok(all.length > 1000, `the ${ROUTES("with-bob").length} routes returned ${all.length} `
      + "characters between them, which is too little to have exercised them — the sweep would "
      + "pass on nothing");
    // **AND THE SWEEP MUST HAVE SEEN A LOOKUP THAT WORKED.** A refusal is a short body that
    // carries no bundle, so a `lookup` that quietly started 400ing would leave every assertion
    // below passing on a response that never handled a key. Asserted rather than assumed, for the
    // reason the vacuity floors elsewhere in this repo exist.
    // Matched on a claim id rather than on `"op": "lookup"`, because `send` pretty-prints and a
    // literal written without its space passes nothing and reports a broken route. The id only
    // appears in a lookup that got far enough to attach its caveats.
    assert.ok(all.includes("lookup.nodeSees"),
      "no lookup succeeded during the sweep, so the route contributed nothing to search");
    assert.ok(all.includes("invite.vaultSees"),
      "no invite succeeded during the sweep, so the route contributed nothing to search");
    assert.ok(all.includes(`"op": "collect"`),
      "no collect succeeded during the sweep, so the route contributed nothing to search");

    // The named secrets, taken as VALUES out of the state this API is serving.
    const named: [string, string][] = [
      ["the vault root seed", alice.seedHex],
      ...Object.entries(alice.prekeys.signed).map(([e, k]) => [`signed prekey ${e}`, k] as [string, string]),
      ...Object.entries(alice.prekeys.oneTime).map(([i, k]) => [`one-time prekey ${i}`, k] as [string, string]),
      ...Object.entries(alice.channels).flatMap(([n, c]) =>
        [["addressSend", (c as never as Record<string, string>).addressSendHex],
         ["addressRecv", (c as never as Record<string, string>).addressRecvHex]]
          .filter(([, v]) => typeof v === "string")
          .map(([w, v]) => [`${n} ${w}`, v] as [string, string])),
      ...alice.invites.slice(0, 5).map((code, i) => [`invite code ${i}`, code] as [string, string]),
    ];
    for (const [what, secret] of named) {
      assert.ok(secret && secret.length > 8, `the test could not find ${what} to look for it`);
      assert.ok(!all.includes(secret),
        `${what} appears in a GUI response. The browser now holds key material, which is the one `
        + "thing I6 forbids, and no amount of transport security makes it not so");
    }

    // And generically, so a secret nobody enumerated is caught by the same test.
    //
    // **THE EXCLUSIONS ARE BY VALUE AND EACH ONE IS A CLAIM.** A field-name exclusion would let a
    // secret through the moment it was renamed into an excluded field; naming the value means the
    // exclusion says "this exact string is public", which is checkable.
    const public_ = publicValues(alice);
    for (const s of longStrings(alice)) {
      if (public_.has(s)) continue;
      assert.ok(!all.includes(s),
        `a ${s.length}-character string from the state appears in a GUI response and is not one of `
        + `the public values: ${s.slice(0, 24)}…`);
    }
  } finally { api.close(); closeVault(); }
});

// ---------------------------------------------------------------------------
// The read-only surface
// ---------------------------------------------------------------------------

test("status reports the client without reporting its keys", async () => {
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    const body = await (await api.get("/v1/gui/status")).json() as Record<string, never>;
    assert.equal(typeof body.fingerprint, "string");
    assert.equal(body.stateFile, FILE);
    assert.equal((body.chain as never as Record<string, unknown>).fromBlock, 7);
    assert.equal(body.route, "direct");
    // A COUNT, NEVER THE CODES. A page holding invites is a page that can spend them.
    assert.equal(body.invitesLeft, alice.invites.length);
    assert.equal(typeof body.invitesLeft, "number");
    assert.ok(!("invites" in body), "the status body carries the invite codes themselves");
  } finally { api.close(); closeVault(); }
});

test("channels lists what a page needs to tell two conversations apart", async () => {
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    const body = await (await api.get("/v1/gui/channels")).json() as
      { channels: Record<string, unknown>[] };
    assert.equal(body.channels.length, 1);
    const [c] = body.channels;
    assert.equal(c!.name, "with-bob");
    assert.equal(c!.role, "initiator");
    assert.equal(typeof c!.messages, "number");
    assert.equal(c!.removedUnderProcess, 0);
  } finally { api.close(); closeVault(); }
});

test("MESSAGES CARRY THEIR ATTRIBUTION — I7 on a third surface", async () => {
  // A name without what backs it is the thing I7 forbids, and a JSON field is where it would go
  // missing quietly: a page cannot render a distinction the API did not send.
  const { bob, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: bob, file: FILE });
  try {
    const body = await (await api.get("/v1/gui/channels/with-alice/messages")).json() as
      { messages: Record<string, unknown>[] };
    assert.equal(body.messages.length, 1);
    const [m] = body.messages;
    assert.equal(m!.text, "the usual place");
    assert.ok(m!.attribution === "signed" || m!.attribution === "unverifiable",
      `attribution is ${JSON.stringify(m!.attribution)}, so the page cannot say whether a `
      + "signature backs this name");
    assert.equal(m!.mine, false);
  } finally { api.close(); closeVault(); }
});

test("THE CROWD FIGURE AND ITS CAVEAT TRAVEL TOGETHER OR NOT AT ALL", async () => {
  // **THE DEFECT: this surface said nothing about linkability whatsoever.** The CLI and the TUI
  // both tell a reader that the operator can name them as the sender of every message here. The
  // GUI — the front end that looks most like an ordinary messenger, and so the one a person is
  // likeliest to use having read none of this — served a chat and never mentioned it. The absence
  // read as nothing to say.
  //
  // Not a number bolted onto a route. The failure worth designing against is the one where a page
  // renders a reassuring `14` and the qualification lives in a repository its author never opens,
  // so the assertion is that the figure NEVER appears without the sentences that qualify it.
  const { bob, close: closeVault } = await conversed();
  try {
    // Measured, because the fixture's channels are not: `linkabilityOf` returns `known: false`
    // until something has asked a node, and testing only that branch would assert the caveat is
    // present in the one case where there is no figure to caveat.
    const channel = bob.channels["with-alice"] as unknown as { crowd: unknown };
    channel.crowd = [
      { account: "0x1", times: [1] }, { account: "0x2", times: [2] }, { account: "0x3", times: [3] },
    ];

    const api = await running({ t: "ready", state: bob, file: FILE });
    try {
      // BOTH ROUTES THAT RETURN A CONVERSATION. `read` is where the figure can have just changed —
      // a chain scan is the only thing that learns who else was publishing — so a payload carrying
      // it on the GET and not on the POST would go missing exactly when it was newest.
      const views = [
        await (await api.get("/v1/gui/channels/with-alice/messages")).json(),
        await (await api.get("/v1/gui/channels/with-alice/read", { method: "POST" })).json(),
      ] as { howLinkable: { known: boolean; crowd: number; lines: string[] } }[];

      for (const view of views) {
        const l = view.howLinkable;
        assert.ok(l, "a conversation payload carries no linkability at all");
        assert.equal(l.crowd, 3);
        assert.equal(l.known, true);
        for (const sentence of NOT_DISCOUNTED) {
          assert.ok(l.lines.includes(sentence),
            `the payload reports a crowd of ${l.crowd} without "${sentence.slice(0, 36)}…", so a `
            + "page can render the number and cannot render what qualifies it");
        }
        // VERBATIM `describe`, NOT A PARAPHRASE — the point of the row is that three front ends
        // say one thing. A second wording here would be a fourth thing to keep in step.
        assert.deepEqual(l.lines, describeLinkability({ known: true, crowd: 3 }),
          "the API words this differently from the CLI and the TUI");
      }
    } finally { api.close(); }
  } finally { closeVault(); }
});

test("THE CLAIM IS THREE-VALUED AND THE MARK IS TWO — every message carries its basis", async () => {
  // **THE DEFECT THIS EXISTS FOR: the API sent `attribution` and nothing else.** That has two
  // values; `attributionLabel` returns THREE bases, because a signature under a key nobody
  // published proves the author is whoever answered the handshake and not who they say they are.
  // Its own comment: "a real guarantee and a weaker one than a reader assumes when a tick is all
  // they are shown". A page drawing a tick from `attribution` alone showed the strongest reading
  // of a claim that might be the weaker one — the same failure as a caveat truncated off a line.
  //
  // Driven over all three, because a two-branch test is what let a three-branch claim collapse.
  const { alice, bob, close: closeVault } = await conversed();
  // **`try`/`finally`, NOT A CALL AT THE END.** The first version closed the vault on the last
  // line, so a FAILING assertion left the server listening and `node --test` never exited —
  // the suite hung precisely when a test was failing, which is when you most need its output.
  // Found by mutating this file and watching the harness stop instead of report.
  try {
    const chain = memoryChain();
    // A signed message, so `attribution` is "signed" and the anchor decides which signed it is.
    const sent = await sendMessage(alice, chain, "with-bob", "signed", "signed and unpublished", T0);
    await flush(alice, sent.uploadAt + MIN_JITTER_BLOCKS * BLOCK, undefined, Infinity);
    await readChannel(bob, chain, "with-alice");

    const basesOf = async (state: State) => {
      const api = await running({ t: "ready", state, file: FILE });
      try {
        const body = await (await api.get("/v1/gui/channels/with-alice/messages")).json() as
          { messages: { attribution: string; basis: string; mark: string }[] };
        return body.messages;
      } finally { api.close(); }
    };

    const unanchored = await basesOf(bob);
    const signed = unanchored.find((m) => m.attribution === "signed");
    const deniable = unanchored.find((m) => m.attribution === "unverifiable");

    assert.ok(deniable, "no deniable message to compare against");
    assert.match(deniable!.basis, /either of you could have written it/,
      "a deniable message does not say what makes it deniable");

    assert.ok(signed, "no signed message — the fixture did not produce the case under test");
    assert.match(signed!.basis, /not published/,
      `a signature under a key nobody published reads as "${signed!.basis}", which does not say the `
      + "key is unpublished — so a reader takes it for a stronger check than it is");

    // The third branch: the same message, once the peer's record is anchored.
    const anchored = { ...bob, channels: { ...bob.channels,
      "with-alice": { ...bob.channels["with-alice"]!, anchor: "0xabc123" } } } as State;
    const after = (await basesOf(anchored)).find((m) => m.attribution === "signed")!;
    assert.match(after.basis, /published at 0xabc123/,
      "an anchored signature does not name where the key is published");

    // AND THE THREE ARE DISTINGUISHABLE, which is the property rather than the wording.
    assert.equal(new Set([deniable!.basis, signed!.basis, after.basis]).size, 3,
      "two of the three cases render the same sentence, so a page cannot tell them apart");

    // AND THE MARK COMES FROM HERE, so no page types a `✓` of its own. Two-valued on purpose: it is
    // an indicator, and the basis is the claim. A copy in another repository drifts silently, and
    // `commands.ts` is explicit that a surface showing the same glyph for both is one where a
    // forgery reads like a signature.
    assert.equal(deniable!.mark, UNVERIFIABLE_MARK);
    assert.equal(signed!.mark, SIGNED_MARK);
    assert.equal(after.mark, SIGNED_MARK);
    assert.notEqual(SIGNED_MARK, UNVERIFIABLE_MARK, "the two marks are the same character");
  } finally { closeVault(); }
});

test("A CLIENT WHOSE UPLOADS ARE FAILING DOES NOT LOOK LIKE A HEALTHY ONE", async () => {
  // **THE DEFECT: with the vault down for five seconds, `status` was BYTE-IDENTICAL to healthy.**
  // Not a sampling artefact — structural. Every field was derived from the state file, and
  // `nextUploadAt` sits in the past whether uploads are going out or not. The ticker swallows the
  // failure, as it must, and `main.ts` pointed at the queue as *"the honest signal"*: a comment
  // asserting an observable the payload never carried.
  //
  // What that costs a user: a queue that looks about to drain, indefinitely, while they believe
  // their messages are going out. The failure direction is telling somebody they are in better
  // shape than they are, which is the direction this client refuses everywhere else.
  const { alice, close: closeVault } = await conversed();
  const source = { t: "ready", state: alice, file: FILE } as const;
  const at = T0 + 5_000;
  const bodyOf = async (lastFlush: FlushAttempt | null) => {
    const api = await running(source, TOKEN, { lastFlush: () => lastFlush });
    try { return await (await api.get("/v1/gui/status")).text(); } finally { api.close(); }
  };

  try {
    const healthy = await bodyOf(
      { at, ok: true, uploaded: 2, consecutiveFailures: 0, problem: null });
    const failing = await bodyOf({ at, ok: false, uploaded: 0, consecutiveFailures: 7,
      problem: problemOf(Object.assign(new Error("fetch failed"),
        { cause: { code: "ECONNREFUSED" } }), alice.vaultUrl) });

    assert.notEqual(failing, healthy,
      "the status payload for a client whose last seven upload attempts failed is identical to "
      + "one whose vault is answering. A page cannot render a difference it was not sent");

    const shown = JSON.parse(failing) as
      { queue: { lastAttempt: { ok: boolean; consecutiveFailures: number; problem: string } } };
    assert.equal(shown.queue.lastAttempt.ok, false);
    assert.equal(shown.queue.lastAttempt.consecutiveFailures, 7,
      "a run of failures is what distinguishes a vault that is down from one request that lost a "
      + "race, and it is the number a page needs to decide whether to say anything");
    // THE SHARED SENTENCE, not `fetch failed`. The CLI and the TUI both name the host and ask
    // whether it is running; this is the third front end saying it too.
    assert.match(shown.queue.lastAttempt.problem, /did not answer \(ECONNREFUSED\)/);
    assert.match(shown.queue.lastAttempt.problem, /is it running\?/);

    // AND NEVER HAVING TRIED IS NOT THE SAME AS HAVING SUCCEEDED. A client that has just started
    // has no evidence either way, and reporting that as healthy is the same over-claim in
    // miniature.
    const fresh = JSON.parse(await bodyOf(null)) as { queue: { lastAttempt: unknown } };
    assert.equal(fresh.queue.lastAttempt, null);
  } finally { closeVault(); }
});

test("EVERY LONG STRING IN THE STATE, INSIDE AN ERROR, IS KEPT OUT OF THE SENTENCE", async () => {
  // **THE GUARD THAT DOES NOT DECAY — AND THE FIRST VERSION OF IT DID.** `problemOf` bounds by
  // SHAPE, and a shape list holds only until somebody invents a new kind of error. Five sites in
  // the client interpolate text a REMOTE party chose (the vault's response body, the node's
  // error), so no regex here can be right about bytes somebody else picked. This test is what is
  // supposed to catch that.
  //
  // It could not. It named the fields it knew about — seed, prekeys, addressing keys, invites,
  // `bodyB64` — which is **the entry-point list one more time, in the backstop written for
  // exactly this failure.** A peer added a `randomBytes(32).toString("base64url")` field to the
  // fixture state: 25 tests, 25 passing, and that value went through `problemOf` into a
  // browser-bound sentence verbatim. A hand-kept list of secrets is not a walk of the state.
  //
  // So it WALKS, using the same `longStrings` recursion the by-value sweep uses, with the same
  // `publicValues` exclusions. A new secret-bearing field is covered the day it is added, in
  // whatever alphabet it arrives in, without anybody remembering this file exists.
  const { alice, close: closeVault } = await conversed();
  try {
    // Queued and not flushed: `conversed()` flushes with no limit, so `pending` is empty and the
    // base64 case would be silently untested. The precondition below caught that once already.
    await sendMessage(alice, memoryChain(), "with-bob", "ephemeral", "not yet uploaded", T0);

    const public_ = publicValues(alice);
    const secrets = [...new Set(longStrings(alice))].filter((v) => !public_.has(v));

    assert.ok(secrets.length > 20,
      `only ${secrets.length} long strings found in the fixture — the walk is broken and this `
      + "test would pass by measuring nothing");
    // The walk has to actually reach the queue, or the encoding that broke this is untested.
    assert.ok(secrets.some((v) => /^[A-Za-z0-9+/]+=*$/.test(v) && !/^[0-9a-f]+$/i.test(v)),
      "no non-hex value in the walk — the fixture queued nothing and the base64 case is untested");

    for (const secret of secrets) {
      // Interpolated the way the client really does it: inside a message, with no `cause.code`,
      // which is the branch that forwards prose verbatim.
      const said = problemOf(new Error(`the vault refused the read: ${secret} was rejected`));
      assert.ok(!said.includes(secret),
        `a ${secret.length}-character value from the state passed through problemOf into a `
        + `sentence bound for a browser: ${secret.slice(0, 28)}…`);

      // **AND THE SAME VALUE WITH ONE INVISIBLE CHARACTER IN THE MIDDLE OF IT.**
      //
      // A `U+200B` occupies no width, so nothing on screen changes and a reader cannot see it.
      // What it does is split the value into two shorter runs, and every shape in
      // `CREDENTIAL_SHAPED` is length-bounded — so the filter matches neither half and forwards
      // the credential. Measured before the fix: a clean 32-character invite code was withheld
      // and the same code carrying one zero-width character went to the page verbatim.
      //
      // **The assertion strips the character back out before looking**, because that is what a
      // browser does when the reader copies the text. A guard that leaves a credential on the
      // page in a form that rejoins itself on copy has not withheld anything.
      const half = Math.floor(secret.length / 2);
      const split = `${secret.slice(0, half)}\u200b${secret.slice(half)}`;
      const onSplit = problemOf(new Error(`the vault refused the read: ${split} was rejected`));
      assert.ok(!onSplit.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").includes(secret),
        `one zero-width character walked a ${secret.length}-character credential past the shape `
        + `check: ${secret.slice(0, 28)}…`);
    }

    // **AND base64url, WHICH IS WHAT THE SHAPE LIST MISSED.** `-` and `_` are not in the standard
    // alphabet and they break a run below the length bound, so this passed while its standard
    // twin was withheld. It is the encoding JOSE and JWK use, so it is what a future key field
    // arrives in. Driven explicitly as well as by the walk, because the fixture may not hold one.
    const b64url = randomBytes(32).toString("base64url");
    assert.ok(!problemOf(new Error(`rejected: ${b64url}`)).includes(b64url),
      `base64url passes the shape check: ${b64url}`);

    // AND THE URL BRANCH, which was the bypass: a coded error returns `describeFailure`'s sentence
    // and that sentence interpolates the vault URL, so it skipped the check entirely.
    const credentialled = problemOf(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      "https://operator:s3cret@vault.example");
    assert.ok(!credentialled.includes("s3cret"),
      "a vault URL carrying a credential reached the page through the coded branch, which is the "
      + "one path that used to skip the bound");
  } finally { closeVault(); }
});

test("A FAILURE SENTENCE NEVER CARRIES A CREDENTIAL, AND IS NOT GAGGED FOR IT", async () => {
  // Two ways to get this wrong and the first attempt took the second one.
  //
  // The message may not carry an invite code or a blob id: `status` is careful enough to send a
  // COUNT of invites and never the codes, and an error string is the obvious way around that.
  const withInvite = problemOf(new Error(
    "invite 4f3a9c1de8b7250a6f3a9c1de8b7250a was already spent"));
  assert.ok(!withInvite.includes("4f3a9c1de8b7250a6f3a9c1de8b7250a"),
    "an invite code reached the page inside an error message, which is the one credential that "
    + "undoes every other protection here");
  assert.ok(!problemOf(new Error("enc:72c9a2f0 is not in this batch")).includes("enc:72c9a2f0"));

  // **AND THE OTHER WAY: A BLANKET BAN.** Refusing every message the client cannot classify was
  // the first version, and it deleted a property this API already had — a failed write says WHAT
  // failed. Most of these strings are the client's own prose, written to be read by the person it
  // happened to. Withholding all of them to bound a few looks safer and is only quieter.
  assert.equal(problemOf(new Error("the chain refused the transaction")),
    "the chain refused the transaction",
    "an ordinary failure was suppressed, so the page can say only that something went wrong");

  // A coded network failure goes through `describeFailure`, which is `commands.ts`'s and is what
  // the other two front ends print. Third surface, same sentence.
  const dead = problemOf(Object.assign(new Error("fetch failed"),
    { cause: { code: "ECONNREFUSED" } }), "http://127.0.0.1:8080");
  assert.match(dead, /http:\/\/127\.0\.0\.1:8080 did not answer \(ECONNREFUSED\)/);
});

test("A GET DOES NO NETWORK — the read-only surface cannot become a 106-second read", async () => {
  // `readChannel` scans the chain and fetches a padded vault batch. On a client whose deployment
  // discovery failed that is 179 round trips. A GET that quietly did it would hang a page with no
  // way for the page to know why, so stored history is what this returns and `read` is a verb.
  const { bob, close: closeVault } = await conversed();
  let reached = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    if (!String(args[0]).includes("127.0.0.1:")) reached++;
    return realFetch(...args);
  }) as typeof fetch;
  const api = await running({ t: "ready", state: bob, file: FILE });
  try {
    // THE GET ROUTES ONLY, and that filter is the point of the test rather than a detail: `read`
    // and `flush` reach the network deliberately, which is why they are verbs.
    const reads = ROUTES("with-alice").filter(([method]) => method === "GET");
    // FOUR SINCE `GET /v1/gui/post`, which is the description of what posting costs. It reads
    // `describePost()` — a pure function — and `state.invites.length`, so it touches nothing, and
    // this number is the thing that made somebody check that. A count here is deliberately a
    // tripwire rather than a fact: it fires when the read-only surface grows, which is exactly
    // when the "no network" claim has to be re-established for the new route rather than assumed.
    assert.equal(reads.length, 4, "the read-only surface is not four routes any more");
    for (const [, route] of reads) assert.equal((await api.get(route)).status, 200);
    assert.equal(reached, 0, "a read-only endpoint made a network request");
  } finally { api.close(); closeVault(); globalThis.fetch = realFetch; }
});

// ---------------------------------------------------------------------------
// Degraded. Every defect this lane found today was in a degraded configuration and the happy path
// was clean, so this is where the API is most likely to be wrong.
// ---------------------------------------------------------------------------

/**
 * A request with a chosen `Host`, which `fetch` cannot make.
 *
 * **`Host` IS A FORBIDDEN HEADER NAME**, so `fetch` drops an override silently — the first version
 * of the rebinding test set it, got a 200, and was reporting that the control was broken when in
 * fact the header never left the process. A test that cannot send the thing it is testing is a
 * test whose failures and passes mean the same nothing.
 */
function raw(port: number, path: string, headers: Record<string, string>): Promise<{
  status: number; body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Every refusal in this API has to name its condition AND its remedy. */
async function refusal(res: Response): Promise<{ code: string; condition: string; remedy: string }> {
  const body = await res.json() as { error?: { code: string; condition: string; remedy: string } };
  assert.ok(body.error, `a refusal carried no error object: ${JSON.stringify(body)}`);
  assert.ok(body.error!.condition.length > 10,
    `${body.error!.code} names no condition, so the page can only say "something went wrong"`);
  assert.ok(body.error!.remedy.length > 10,
    `${body.error!.code} names no remedy, so the reader knows something is wrong and not what to do`);
  return body.error!;
}

test("NO TOKEN, AND A WRONG TOKEN, ARE DIFFERENT REFUSALS", async () => {
  // They are different mistakes: one is a page that was never given the token, the other a page
  // holding one from a previous run. Collapsing them sends a user to check the wrong thing, which
  // is the defect the operator report had this morning.
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    const none = await fetch(`${api.base}/v1/gui/status`);
    assert.equal(none.status, 401);
    assert.equal((await refusal(none)).code, "token_missing");

    const wrong = await fetch(`${api.base}/v1/gui/status`,
      { headers: { "x-hydra-token": "f".repeat(32) } });
    assert.equal(wrong.status, 401);
    assert.equal((await refusal(wrong)).code, "token_invalid");
  } finally { api.close(); closeVault(); }
});

test("A TOKEN OF THE WRONG LENGTH IS REFUSED, NOT THROWN", async () => {
  // `timingSafeEqual` throws on a length mismatch. An uncaught throw would answer 500 where a
  // correct-length wrong token answers 401 — a length oracle built out of an error handler.
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    for (const bad of ["x", "f".repeat(31), "f".repeat(200)]) {
      const res = await fetch(`${api.base}/v1/gui/status`, { headers: { "x-hydra-token": bad } });
      assert.equal(res.status, 401,
        `a ${bad.length}-character token answered ${res.status}, so the response distinguishes a `
        + "wrong length from a wrong value");
      assert.equal((await refusal(res)).code, "token_invalid");
    }
  } finally { api.close(); closeVault(); }
});

test("A REQUEST ADDRESSED TO A NAME IS REFUSED — the DNS rebinding control", async () => {
  // The attack an origin allowlist does not see: rebinding makes the request same-origin, so no
  // CORS check ever runs and no allowlist is consulted. What the browser cannot change is the
  // `Host` it sends, which is still the attacker's name. See decisions/0046.
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    const port = (api.server.address() as AddressInfo).port;
    const res = await raw(port, "/v1/gui/status",
      { "x-hydra-token": TOKEN, host: "evil.example" });
    assert.equal(res.status, 403, `a request addressed to evil.example was answered ${res.status}`);
    const err = (JSON.parse(res.body) as { error: { code: string; condition: string } }).error;
    assert.equal(err.code, "host_not_loopback");
    assert.match(err.condition, /evil\.example/,
      "the refusal does not name the host it was addressed to, which is the whole diagnosis");
  } finally { api.close(); closeVault(); }
});

test("THE HOST CHECK RUNS BEFORE THE TOKEN CHECK", async () => {
  // Order is policy: a request from a rebound name must not be able to learn whether a token is
  // right. If the token were checked first, the two refusals would be an oracle.
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    const port = (api.server.address() as AddressInfo).port;
    const res = await raw(port, "/v1/gui/status", { host: "evil.example" });
    const err = (JSON.parse(res.body) as { error: { code: string } }).error;
    assert.equal(err.code, "host_not_loopback",
      "a request with a bad host AND no token was answered about the token, so a rebound page "
      + "learns which of the two it got wrong");
  } finally { api.close(); closeVault(); }
});

test("NO STATE AND A LOCKED STATE ARE DIFFERENT, AND NEITHER IS A CRASH", async () => {
  // A user who has not made an identity and a user whose file is encrypted need different
  // sentences. `hydra tui` crashed on the second of these until this morning.
  for (const [source, code, remedy] of [
    [{ t: "none" as const, file: FILE }, "no_state", /hydra init|first-run/],
    [{ t: "locked" as const, file: FILE }, "state_locked", /passphrase/],
  ] as const) {
    const api = await running(source);
    try {
      const res = await api.get("/v1/gui/status");
      assert.equal(res.status, 409);
      const err = await refusal(res);
      assert.equal(err.code, code);
      assert.match(err.remedy, remedy);
      assert.match(err.condition, /state\.json/, "the refusal does not name the file it means");
    } finally { api.close(); }
  }
});

test("AN UNKNOWN CHANNEL AND AN UNKNOWN ROUTE BOTH SAY WHAT EXISTS", async () => {
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    const channel = await api.get("/v1/gui/channels/nobody/messages");
    assert.equal(channel.status, 404);
    assert.equal((await refusal(channel)).code, "no_such_channel");

    const route = await api.get("/v1/gui/everything");
    assert.equal(route.status, 404);
    const err = await refusal(route);
    assert.equal(err.code, "no_such_route");
    // NAMED, so nobody looks for a bridge that does not exist. There is no general command
    // endpoint and that is a decision rather than an omission.
    assert.match(err.remedy, /no general command endpoint/);
  } finally { api.close(); closeVault(); }
});

test("THE PREFLIGHT IS ANSWERED WITHOUT A TOKEN, because a browser sends none on one", async () => {
  // A preflight carries no custom headers by definition, so requiring the token on it would refuse
  // every legitimate request before it was ever made. Measured in a real browser: with the
  // permission granted, a token-bearing GET is preflighted and both halves must pass.
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    const res = await fetch(`${api.base}/v1/gui/status`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-headers"), "x-hydra-token, content-type");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  } finally { api.close(); closeVault(); }
});

test("THE TOKEN IS COMPARED IN CONSTANT TIME — asserted against the source, deliberately", () => {
  // **THIS ONE CANNOT BE A BEHAVIOURAL TEST AND SAYING SO IS THE POINT.** Replacing
  // `timingSafeEqual` with `===` was mutated in and the whole suite still passed — correctly,
  // because the two are functionally identical and the difference is a timing property no
  // assertion here can observe. A test that appeared to cover it would be worse than none.
  //
  // So it is asserted where the property lives, which is the same reason `front-end-parity.test.ts`
  // reads source: a defect with no observable behaviour has to be checked as text or not at all.
  const code = codeOf(readFileSync(new URL("../../gui/src/server.ts", import.meta.url), "utf8"));
  const compare = code.slice(code.indexOf("function tokenMatches"),
    code.indexOf("}", code.indexOf("function tokenMatches")));
  assert.match(compare, /timingSafeEqual/,
    "the token is compared with something other than `timingSafeEqual`, so the comparison returns "
    + "sooner for a token that shares a prefix and the secret can be recovered a byte at a time");
  assert.ok(!/===\s*expected|expected\s*===/.test(compare),
    `the comparison short-circuits on equality:\n  ${compare}`);
});

// ---------------------------------------------------------------------------
// Writes. The lock is the reason this surface is harder than the read-only one.
// ---------------------------------------------------------------------------

const post = (base: string, path: string, body?: unknown, token = TOKEN) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "x-hydra-token": token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("SEND PUBLISHES AND QUEUES, and says which of the two verbs it was", async () => {
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    const res = await post(api.base, "/v1/gui/channels/with-bob/send", { text: "over the api" });
    // READ ONCE. `assert.equal(res.status, 200, await res.text())` consumes the body even when the
    // assertion PASSES — the message argument is evaluated eagerly — so the next `.json()` threw
    // "Body has already been read" and the test failed for a reason that was not the product's.
    const body = await res.json() as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.match(String(body.txHash), /^0x[0-9a-f]+$/);
    assert.equal(body.signed, false, "a send defaulted to signed, which is the wrong default");
    assert.equal(typeof body.uploadAt, "number");
    assert.ok(api.saved.length > 0, "a write did not persist the state it changed");

    const signed = await post(api.base, "/v1/gui/channels/with-bob/send",
      { text: "and this one signed", signed: true });
    assert.equal(((await signed.json()) as { signed: boolean }).signed, true);
  } finally { api.close(); closeVault(); }
});

test("TWO SENDS AT ONCE: one runs, the other is refused and says nothing was lost", async () => {
  // **THE CASE THE LOCK EXISTS FOR, and the one no single-threaded test finds by accident.** Every
  // effect mutates `State` and persists it, so two in flight interleave two writes to one file and
  // the loser's sequence number or spent invite vanishes silently. The TUI gets this from a reducer
  // that refuses while busy; an HTTP server refuses nothing for you.
  const { alice, close: closeVault } = await conversed();
  // **A SLOW PUBLISH, BECAUSE OTHERWISE THERE IS NO CONCURRENCY TO CATCH.** The first version used
  // `memoryChain`, whose `publish` resolves immediately, so the first request finished before the
  // second was parsed and BOTH returned 200 — a test that asserted the lock works while never
  // putting two operations in flight. A real send publishes to a chain over a network and takes
  // long enough for a second request to arrive, which is the case the lock exists for.
  const slow = () => {
    const inner = memoryChain();
    return {
      ...inner,
      publish: async (calldata: readonly [bigint, bigint]) => {
        await new Promise((ok) => setTimeout(ok, 60));
        return inner.publish(calldata);
      },
    };
  };
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN,
    { chainFor: () => slow() as never });
  try {
    const both = await Promise.all([
      post(api.base, "/v1/gui/channels/with-bob/send", { text: "first" }),
      post(api.base, "/v1/gui/channels/with-bob/send", { text: "second" }),
    ]);
    const codes = both.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409],
      `two simultaneous sends both got ${JSON.stringify(codes)} — either both wrote, which is the `
      + "interleaving, or neither did");

    const refused = both.find((r) => r.status === 409)!;
    const err = (await refused.json() as { error: { code: string; condition: string; remedy: string } }).error;
    assert.equal(err.code, "busy");
    assert.match(err.condition, /send is already running/,
      "the refusal does not say what is running, so the page cannot tell the user what to wait for");
    assert.match(err.remedy, /nothing has been lost/,
      "the refusal does not say whether the message was kept, which is the only thing the sender "
      + "actually wants to know");
  } finally { api.close(); closeVault(); }
});

test("A SEND HELD AT ITS BODY DOES NOT CLOBBER A SEND THAT FINISHED WHILE IT WAITED", async () => {
  // **G1 — A MESSAGE PUBLISHED TO THE CHAIN, ANSWERED 200, AND ABSENT FROM HISTORY.** The lock was
  // real and it was not the problem. `stateOr` ran at dispatch, before the route; `send` then
  // `await`ed the request body — a yield — and only then took the lock. So the lock serialised
  // EXECUTION over a snapshot taken before it, which is not serialisation of anything that
  // matters. The second writer's `save` wrote a state that never contained the first writer's
  // message, along with the cover objects for it, so a recipient is left holding a pointer to a
  // blob that will never be uploaded.
  //
  // The asymmetry was in this repository already: `main.ts`'s flush ticker calls `stateNow()`
  // INSIDE `exclusive`. The ticker had it right and the handler did not.
  //
  // **A DISK, NOT A SHARED OBJECT.** Every other test here hands both requests the same `State`
  // instance, and with one object there is nothing to lose — the second writer mutates what the
  // first is holding and both messages survive by accident. `stateNow` really calls `load()`,
  // which parses JSON off disk, so the round trip is what makes the two snapshots distinct and
  // the test able to observe the defect at all.
  const { alice, close: closeVault } = await conversed();
  let disk = JSON.stringify(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, {
    stateNow: () => ({ t: "ready", state: JSON.parse(disk) as State, file: FILE }),
    save: (s) => { disk = JSON.stringify(s); },
  });
  const { port } = api.server.address() as AddressInfo;

  try {
    // **A SECOND SOCKET, NOT A SECOND `fetch`.** One client is one connection with multiplexing
    // nobody here controls; the interleaving under test needs two connections that genuinely
    // overlap, and holding a body open is the only way to park a request at the exact yield.
    const held = connect(port, "127.0.0.1");
    await new Promise<void>((ok) => held.once("connect", () => ok()));
    const body = JSON.stringify({ text: "the held one" });
    held.write(`POST /v1/gui/channels/with-bob/send HTTP/1.1\r\n`
      + `Host: 127.0.0.1\r\nx-hydra-token: ${TOKEN}\r\n`
      + `Content-Type: application/json\r\n`
      + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`);
    const heldReply = new Promise<string>((ok) => {
      let text = ""; held.on("data", (c: Buffer) => { text += c.toString(); ok(text); });
    });

    // **THE INTERLEAVING IS OBSERVED, NOT ASSUMED.** Without this the test asserts an outcome
    // that two sequential sends produce just as well, and would pass against the defect. The
    // handler has reached its snapshot when `stateNow` has been called; nothing else has called
    // it, because nothing else has been requested yet.
    const parked = async () => {
      for (let i = 0; i < 200 && api.snapshots.length === 0; i++) {
        await new Promise((ok) => setTimeout(ok, 5));
      }
      return api.snapshots.length;
    };
    assert.equal(await parked(), 1,
      "the held request never reached the handler, so nothing was parked and this test would "
      + "have proved a property of two sends in a row");

    // The whole second send, start to finish, in the gap.
    const second = await api.get("/v1/gui/channels/with-bob/send", {
      method: "POST", body: JSON.stringify({ text: "the one that finished first" }),
    });
    assert.equal(second.status, 200);

    held.write(body);
    const reply = await heldReply;
    assert.match(reply, /^HTTP\/1\.1 200/,
      `the held send was answered ${reply.split("\r\n")[0]}, so it never got far enough to `
      + "overwrite anything and the test is not exercising the defect");
    held.destroy();

    // **ASSERTED ON CONTENTS, NOT ON A COUNT.** `nextSeq` and `history.length` are identical
    // whether the writes interleaved or not — the loser's message is replaced by the winner's,
    // not added to. Only the texts say which messages actually survived.
    const final = JSON.parse(disk) as State;
    const texts = final.channels["with-bob"]!.history.map((m) => m.text);
    for (const text of ["the one that finished first", "the held one"]) {
      assert.ok(texts.includes(text),
        `"${text}" was answered 200 and published to the chain, and is not in history: `
        + `${JSON.stringify(texts)}. A user was told their message was sent and it is gone.`);
    }
    // And its cover: a queued upload lost with it leaves a recipient holding a pointer to a blob
    // that is never uploaded, which is the silent half of this defect.
    assert.ok(final.pending.length >= 2,
      `${final.pending.length} pending uploads for two sends — cover objects went with the `
      + "message that was dropped");
  } finally { api.close(); closeVault(); }
});

test("THE LOCK IS RELEASED WHEN THE OPERATION THROWS", async () => {
  // A publish that fails while holding a lock released only on success bricks the client until it
  // is restarted — a worse failure than the one that caused it, and one a user cannot diagnose.
  const { alice, close: closeVault } = await conversed();
  const exploding = { chainFor: () => { throw new Error("the chain refused the transaction"); } };
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, exploding as never);
  try {
    const first = await post(api.base, "/v1/gui/channels/with-bob/send", { text: "boom" });
    assert.equal(first.status, 500);
    assert.match(String(((await first.json()) as { error: { condition: string } }).error.condition),
      /refused the transaction/, "a failed write does not say what failed");

    // AND THE NEXT ONE IS NOT REFUSED AS BUSY.
    const second = await post(api.base, "/v1/gui/channels/with-bob/send", { text: "again" });
    assert.notEqual(second.status, 409,
      "a throw left the lock held, so the client is bricked until it is restarted");
  } finally { api.close(); closeVault(); }
});

test("A WRITE IS POST AND NOT GET", async () => {
  // A `GET` that publishes to a chain is reachable by prefetch, by link preview and by history
  // replay — three ways a message gets published that nobody chose.
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    for (const path of ["/v1/gui/lookup", "/v1/gui/invite", "/v1/gui/collect",
      "/v1/gui/channels/with-bob/send", "/v1/gui/channels/with-bob/read", "/v1/gui/flush"]) {
      const res = await api.get(path);
      assert.equal(res.status, 404, `${path} answers a GET, so a prefetch can trigger it`);
    }
  } finally { api.close(); closeVault(); }
});

test("A SEND WITH NO TEXT, AND AN UNKNOWN CHANNEL, EACH NAME A REMEDY", async () => {
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    for (const [body, code] of [[{}, "no_text"], [{ text: "  " }, "no_text"]] as const) {
      const res = await post(api.base, "/v1/gui/channels/with-bob/send", body);
      const err = (await res.json() as { error: { code: string; remedy: string } }).error;
      assert.equal(err.code, code);
      assert.ok(err.remedy.length > 10, `${code} names no remedy`);
    }
    const nowhere = await post(api.base, "/v1/gui/channels/nobody/send", { text: "x" });
    assert.equal(nowhere.status, 404);
    assert.equal((await nowhere.json() as { error: { code: string } }).error.code, "no_such_channel");
  } finally { api.close(); closeVault(); }
});

test("FLUSH REPORTS WHAT WENT AND WHAT IS STILL WAITING", async () => {
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    await post(api.base, "/v1/gui/channels/with-bob/send", { text: "queue something" });
    const res = await post(api.base, "/v1/gui/flush");
    const body = await res.json() as { uploaded: number; waiting: number };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(typeof body.uploaded, "number");
    assert.equal(typeof body.waiting, "number");
  } finally { api.close(); closeVault(); }
});

test("A FLUSH THAT THROWS STILL PERSISTS — the GUI was the surface this never reached", async () => {
  // ⛔ **THE SAME REPAIR, THE THIRD FRONT END, AND IT STOPPED AT THE SECOND.**
  //
  // `flush` mutates `State` as it runs: an invite spent per successful upload, its own progress
  // committed in a `finally`. None of that reaches disk unless the CALLER saves, so every caller
  // has to save even when the flush throws. `cli.ts` does (`try { drain } finally { save }`) and
  // `effects.ts` does. Both GUI call sites — the one-second ticker in `gui/src/main.ts` and this
  // route in `gui/src/server.ts` — had `save` on the line AFTER `flush`, reached only when nothing
  // went wrong.
  //
  // What that costs is specific: `stateNow()` re-reads the file every tick, so a throw meant the
  // next tick loaded a state where spent codes look unspent, presented them again, and was refused
  // again — a ticker that cannot progress and never stops trying.
  //
  // **INVITE EXHAUSTION IS THE THROW, because it is the one that actually happened.** A vault
  // spends a code on presentation, so a client that loses its accounting re-presents dead codes.
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    await post(api.base, "/v1/gui/channels/with-bob/send", { text: "queue something" });
    const before = api.saved.length;
    // DUE, because a fresh send is scheduled into the future on purpose and a flush with nothing
    // due returns 200 without ever calling the vault — which is the 200 the first version of this
    // test got, and it would have passed against the unfixed code for the wrong reason.
    assert.ok(alice.pending.length > 0, "nothing queued to flush");
    alice.pending = alice.pending.map((p) => ({ ...p, uploadAt: 0 }));
    // Nothing left to spend, with objects now due: `flush` refuses before it uploads anything.
    alice.invites = [];

    const res = await post(api.base, "/v1/gui/flush");
    assert.ok(res.status >= 400, `the flush was supposed to fail, got ${res.status}`);
    // THE ASSERTION THAT FAILS WITHOUT THE `finally`. Not "the state changed" — with FLUSH_LIMIT
    // at one there may be no progress to lose yet — but that the caller committed at all. A
    // discipline guarded only by a constant defined in another module is not guarded.
    assert.ok(api.saved.length > before,
      "the GUI flush route threw and never saved. `flush` mutates state as it goes, so a throw "
      + "leaves spent invites looking unspent on disk and the next attempt re-presents them.");
  } finally { api.close(); closeVault(); }
});

// ---------------------------------------------------------------------------
// `lookup` — the route that opens a conversation, and the only thing on this API a caller with no
// conversations can usefully do. Every other write names one that already exists.
// ---------------------------------------------------------------------------

test("A LOOKUP THAT FINDS NOTHING NEVER TOUCHES THE VAULT", async () => {
  // **THE ORDERING IS THE DISCLOSURE CLAIM, NOT AN OPTIMISATION**, and this is the third surface
  // to need it said: `tui-lookup.test.ts` holds the same property for the effect. `LOOKUP_NODE_SEES`
  // tells a user that asking costs them the RPC node knowing, and that this is the better of the
  // two available disclosures because fetching from the peer's vault would tell THE PEER they were
  // being considered. That sentence is true only while a failed lookup stops at the node.
  //
  // **WHAT THIS CAN AND CANNOT REGRESS, measured rather than asserted.** The two calls in the
  // handler are DATA-DEPENDENT — `openAndSend` takes the bundle `bundleFromChain` returns — so
  // they cannot literally be reordered; an attempt to start the second early was tried against
  // this test and failed at `open`, not here. What CAN arrive is a second route to a bundle: a
  // vault fallback when the chain has no record, or a mailbox probe before the lookup. Tried:
  // adding a `catch` that fetches the bundle from `state.vaultUrl` makes exactly this test fail
  // and nothing else in the file. That is the shape it guards, and naming it is more use to
  // whoever sees it fail than the sentence about swapping awaits that used to be here.
  const { alice, close: closeVault } = await conversed();
  const { fetchImpl, asked } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    const res = await post(api.base, "/v1/gui/lookup", { name: "nobody", address: NO_RECORD });
    assert.equal(res.status, 500, "a lookup against an address with no record reported success");
    assert.ok(asked.length > 0, "nothing was asked of anybody, so this test measured nothing");
    assert.deepEqual(asked.filter((u) => u.startsWith(alice.vaultUrl)), [],
      `the vault was contacted ${asked.filter((u) => u.startsWith(alice.vaultUrl)).length} time(s) `
      + "by a lookup that found no record — LOOKUP_NODE_SEES claims only the node learns");
    assert.ok(!alice.channels.nobody, "a channel was opened for a record that does not exist");
    // And the client's own record is untouched, so nothing was half-done under a name.
    assert.deepEqual(api.saved, [], "a lookup that found nothing still saved state");
  } finally { api.close(); closeVault(); }
});

test("THE THREE COSTS TRAVEL IN THE RESPONSE, WORD FOR WORD", async () => {
  // **NOT "the page shows a warning" — the page is given the SENTENCES.** These are the entries
  // `cli.ts` prints and the TUI's Connect page renders, shipped as data, so a browser front end
  // cannot summarise one into a tooltip, reorder them, or drop the one that is least flattering.
  // The wording lives in `claims/src/warnings.ts` and `claims-not-duplicated.test.ts` holds that
  // `gui` renders all three; this holds that they reach the wire intact.
  const { alice, close: closeVault } = await conversed();
  const { fetchImpl } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    const res = await post(api.base, "/v1/gui/lookup", { name: "org", address: ORG_ADDRESS });
    const text = await res.text();
    assert.equal(res.status, 200, `the lookup failed: ${text}`);
    const body = JSON.parse(text) as { op: string; channel: string; slot: number;
      fingerprint: string; warnings: { id: string; short: string; full: string[] }[] };
    assert.equal(body.op, "lookup");
    assert.equal(body.channel, "org");
    assert.ok(body.fingerprint.length > 0, "no fingerprint, so nothing can be checked out of band");
    assert.deepEqual(
      body.warnings,
      [LOOKUP_KEY_NOT_PERSON, LOOKUP_NO_ONE_TIME, LOOKUP_NODE_SEES]
        .map((w) => ({ id: w.id, short: w.short, full: w.full })),
      "the caveats on the wire are not the ones in the claims module — a surface restating a "
      + "claim in its own words is the drift this repository has already paid for three times");
    // AND THE CHANNEL IS REALLY OPEN, so this is not three sentences attached to nothing.
    assert.ok(alice.channels.org, "the response claimed a channel that was never opened");
    assert.equal(api.saved.length, 1, "a channel was opened and not persisted");
  } finally { api.close(); closeVault(); }
});

test("A NAME ALREADY IN USE IS REFUSED BEFORE ANYTHING CAN OVERWRITE IT", async () => {
  // Not politeness. `openAndSend` deletes `state.channels[name]` if the vault post fails — an undo
  // that is correct for a name it just created and DESTROYS A CONVERSATION for one it did not. A
  // lookup onto an occupied name could therefore lose an existing thread on a network error.
  const { alice, close: closeVault } = await conversed();
  const { fetchImpl, asked } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    const res = await post(api.base, "/v1/gui/lookup", { name: "with-bob", address: ORG_ADDRESS });
    assert.equal(res.status, 409);
    const err = await refusal(res);
    assert.equal(err.code, "name_taken");
    assert.ok(err.remedy.length > 10, "name_taken names no remedy");
    assert.ok(alice.channels["with-bob"], "the existing conversation was lost to a refused lookup");
    // REFUSED BEFORE THE NODE IS ASKED, so a name collision does not spend a disclosure either.
    assert.deepEqual(asked, [], `a refused lookup still asked ${asked.length} party/parties`);
  } finally { api.close(); closeVault(); }
});

test("A LOOKUP WITH NO NAME, AND WITH A BAD ADDRESS, EACH NAME A REMEDY", async () => {
  // `BigInt("")` IS ZERO, and zero reads as "no identity published" on this contract — so an
  // empty address would have travelled to the node and come back as a true sentence about a
  // question nobody asked. Each of these is refused before the lock and before the network.
  const { alice, close: closeVault } = await conversed();
  const { fetchImpl, asked } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    for (const [body, code] of [
      [{ address: ORG_ADDRESS }, "no_name"],
      [{ name: "  ", address: ORG_ADDRESS }, "no_name"],
      [{ name: "org" }, "not_an_address"],
      [{ name: "org", address: "" }, "not_an_address"],
      [{ name: "org", address: "not an address" }, "not_an_address"],
      [{ name: "org", address: "0x" }, "not_an_address"],
    ] as const) {
      const res = await post(api.base, "/v1/gui/lookup", body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} was not refused`);
      const err = await refusal(res);
      assert.equal(err.code, code, `${JSON.stringify(body)} was refused as ${err.code}`);
      assert.ok(err.remedy.length > 10, `${code} names no remedy`);
    }
    assert.deepEqual(asked, [], "a refused lookup reached the network");
  } finally { api.close(); closeVault(); }
});

test("INVITE OPENS FROM A BUNDLE, AND THE TWO COSTS TRAVEL WITH IT", async () => {
  // The peer with no published record — the case `lookup` does not cover. The bundle arrives as
  // TEXT rather than as a path; see the route's own comment for why that is not a convenience.
  const { alice, bob, close: closeVault } = await conversed();
  const { fetchImpl } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    const res = await post(api.base, "/v1/gui/invite",
      { name: "second-bob", bundle: encodeWire(publishBundle(bob)) });
    const text = await res.text();
    assert.equal(res.status, 200, `the invite failed: ${text}`);
    const body = JSON.parse(text) as { op: string; channel: string; fingerprint: string;
      slot: number; warnings: { id: string; short: string; full: string[] }[] };
    assert.equal(body.op, "invite");
    assert.equal(body.channel, "second-bob");
    assert.ok(body.fingerprint.length > 0, "no fingerprint, so nothing can be checked out of band");
    assert.deepEqual(
      body.warnings,
      [INVITE_VAULT_SEES, INVITE_UNSCHEDULED].map((w) => ({ id: w.id, short: w.short, full: w.full })),
      "the costs on the wire are not the ones in the claims module — these two spent their whole "
      + "life as hand-written copies in two front ends and had already drifted");
    assert.ok(alice.channels["second-bob"], "the response claimed a channel that was never opened");
  } finally { api.close(); closeVault(); }
});

test("A PATH IS NOT A BUNDLE — the API takes bytes, so the token is not a local file read", async () => {
  // **THE ONE PLACE THIS API SHAPE DIFFERS FROM BOTH OTHER FRONT ENDS, DELIBERATELY.** `hydra
  // invite` and the TUI's Enter take a FILENAME, correctly: they run as the user, from the user's
  // shell. A loopback route that did the same would hand whatever holds the token an arbitrary
  // local file read, and the decode failure would carry the first line of what it read back to
  // the page. Asserted rather than left to the docstring, because the convenience argument for a
  // path is obvious and the reason against it is not.
  const { alice, close: closeVault } = await conversed();
  const { fetchImpl, asked } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    const res = await post(api.base, "/v1/gui/invite",
      { name: "sneaky", bundle: "/home/somebody/.hydra-msg/state.json" });
    assert.equal(res.status, 400);
    const err = await refusal(res);
    assert.equal(err.code, "not_a_bundle");
    // AND THE SENTENCE SAYS SO, so nobody adds the path parameter back as a missing feature.
    assert.match(err.remedy, /the bytes, not a path/);
    assert.ok(!alice.channels.sneaky, "a channel was opened from something that is not a bundle");
    assert.deepEqual(asked, [], "a refused invite reached the network");
  } finally { api.close(); closeVault(); }
});

test("AN INVITE ONTO AN OCCUPIED NAME IS REFUSED — the same guard lookup needed", async () => {
  // **`openAndSend` IS REACHED BY BOTH ROUTES, SO A GUARD IN ONE OF THEM IS HALF A GUARD.** It
  // deletes `state.channels[name]` when the vault post fails — right for a name it just made, and
  // it destroys an existing conversation for one it did not. The check is written once, over both
  // opening routes; this is the half that would otherwise have gone untested.
  const { alice, bob, close: closeVault } = await conversed();
  const { fetchImpl } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    const before = alice.channels["with-bob"];
    const res = await post(api.base, "/v1/gui/invite",
      { name: "with-bob", bundle: encodeWire(publishBundle(bob)) });
    assert.equal(res.status, 409);
    assert.equal((await refusal(res)).code, "name_taken");
    assert.equal(alice.channels["with-bob"], before,
      "the existing conversation was replaced by a refused invite");
  } finally { api.close(); closeVault(); }
});

test("AN INVITE WITH NO NAME, AND NO BUNDLE, EACH NAME A REMEDY", async () => {
  const { alice, close: closeVault } = await conversed();
  const { fetchImpl } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    for (const [body, code] of [
      [{ bundle: "{}" }, "no_name"],
      [{ name: "  ", bundle: "{}" }, "no_name"],
      // The missing-file case: a page that read a file that was not there sends "".
      [{ name: "x" }, "no_bundle"],
      [{ name: "x", bundle: "   " }, "no_bundle"],
      [{ name: "x", bundle: "not json at all" }, "not_a_bundle"],
    ] as const) {
      const res = await post(api.base, "/v1/gui/invite", body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} was not refused`);
      const err = await refusal(res);
      assert.equal(err.code, code, `${JSON.stringify(body)} was refused as ${err.code}`);
      assert.ok(err.remedy.length > 10, `${code} names no remedy`);
    }
  } finally { api.close(); closeVault(); }
});

test("COLLECT ACCEPTS WHAT IS WAITING — the receiving side, which had no browser route", async () => {
  // **THE ONLY ROUTE ON THIS API THAT IS NOT THE SOURCE'S.** Without it a person can be reached
  // through a browser and cannot answer through one: an organisation publishing an address would
  // have to drop to a terminal to accept a first contact, which is the ordering this product
  // exists to invert. Driven end to end — alice really opens against bob through the real vault,
  // and bob's API really collects it.
  const { alice, bob, close: closeVault } = await conversed();
  const { fetchImpl } = nodeAndVault(bob);
  const api = await running({ t: "ready", state: bob, file: FILE }, TOKEN, { fetchImpl });
  try {
    // Nothing waiting yet: a real state, a real vault, an empty mailbox.
    const empty = await post(api.base, "/v1/gui/collect");
    const emptyText = await empty.text();
    assert.equal(empty.status, 200, emptyText);
    assert.deepEqual(JSON.parse(emptyText) as unknown,
      { op: "collect", accepted: [], rejected: 0 });

    // A stranger opens a conversation with bob, through the vault, the way `invite` does.
    const carol = init({ vaultUrl: bob.vaultUrl, contract: "0xc0ffee", fromBlock: 7,
      blockMs: BLOCK, invites: [...alice.invites] });
    await openAndSend(carol, "to-bob", publishBundle(bob));

    const got = await post(api.base, "/v1/gui/collect");
    const gotText = await got.text();
    assert.equal(got.status, 200, gotText);
    const r = JSON.parse(gotText) as { op: string; accepted: string[]; rejected: number };
    assert.equal(r.accepted.length, 1, `nothing was accepted: ${JSON.stringify(r)}`);
    assert.equal(r.rejected, 0);
    // Named after the sender's fingerprint, because at this point that is genuinely all we know.
    assert.match(r.accepted[0]!, /^from-[0-9a-f]{12}$/);
    assert.ok(bob.channels[r.accepted[0]!], "collect reported a channel it did not open");
    assert.ok(api.saved.length > 0, "an accepted contact was not persisted");
  } finally { api.close(); closeVault(); }
});

test("NOTHING WAITING AND SOMETHING THAT WOULD NOT OPEN ARE DIFFERENT ANSWERS", async () => {
  // **A SLOT IS WRITABLE BY ANYONE, so a rejection is expected rather than exceptional** — and a
  // page told only `accepted: []` would report "somebody wrote you something unreadable" as
  // "nobody has written". Both figures travel; the two cases are distinguishable on the wire.
  const { alice, bob, close: closeVault } = await conversed();
  const { fetchImpl } = nodeAndVault(bob);
  const api = await running({ t: "ready", state: bob, file: FILE }, TOKEN, { fetchImpl });
  try {
    // Junk into bob's mailbox, written through the real vault by a real client — the slot ids are
    // a public function of his identity key, which is the whole of `INVITE_VAULT_SEES`.
    const carol = init({ vaultUrl: bob.vaultUrl, contract: "0xc0ffee", fromBlock: 7,
      blockMs: BLOCK, invites: [...alice.invites] });
    await openAndSend(carol, "to-bob", publishBundle(bob));
    // Rotating destroys the prekey the message was addressed to, so it can no longer open — the
    // ordinary way this happens, rather than a corrupted fixture.
    rotatePrekey(bob);

    const r = await (await post(api.base, "/v1/gui/collect")).json() as
      { accepted: string[]; rejected: number };
    assert.deepEqual(r.accepted, [], "a message addressed to a destroyed prekey opened anyway");
    assert.equal(r.rejected, 1,
      "a slot that held something unreadable is reported as an empty mailbox, so a page cannot "
      + "tell 'nobody wrote' from 'somebody wrote and it would not open'");
  } finally { api.close(); closeVault(); }
});

test("THE BANNER PRINTS THE ADDRESS IT ACTUALLY BOUND, NOT JUST THE TOKEN", async () => {
  /*
   * **THIS LINE WAS THE HALF NOBODY HAD, AND ITS ABSENCE PRODUCED A DEFECT TWO PACKAGES AWAY.**
   *
   * `hydra gui` binds port 0 on purpose — a fixed one collides, and nothing should be discoverable
   * at a known address without the token. The banner then told a reader to open
   * `<your-page>/#t=<token>` and stopped, so the page had no way to learn the port and did the
   * only thing left: it hardcoded `http://127.0.0.1:8787`. **A default this server can produce
   * only if somebody passed `--port 8787`**, and 8787 is the vault's port in this project's own
   * demo — so the first person to drive the page connected to the vault and died in CORS.
   *
   * The recommendation that came back was "lean on the `&b=…` the server prints". It printed no
   * such thing. Removing the page's default without this would have replaced a wrong address with
   * no address.
   *
   * **SPAWNED RATHER THAN READ, because reading is what let it stay missing.** Nothing in this
   * repository executed `main.ts`, so the banner was prose that no instrument had ever seen. The
   * port is the assertion that needs a real process: a source-level check could confirm `b=` is
   * interpolated and not that the value is the port this server is listening on.
   */
  const dir = mkdtempSync(join(tmpdir(), "hydra-banner-"));
  try {
    writeFileSync(join(dir, "state.json"), JSON.stringify(init({ contract: "0x1" })), { mode: 0o600 });
    const child = spawn(process.execPath, [join(GUI, "main.ts")],
      { env: { ...process.env, HYDRA_HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const out = await new Promise<string>((resolve, reject) => {
        let seen = "";
        const timer = setTimeout(() => reject(new Error(`banner never arrived: ${seen}`)), 20_000);
        child.stdout.on("data", (c: Buffer) => {
          seen += c.toString();
          // Waits for the fragment line specifically. Resolving on the first chunk would race the
          // banner's own writes and pass on a prefix that has not reached the line under test.
          if (seen.includes("#t=")) { clearTimeout(timer); resolve(seen); }
        });
        child.on("error", reject);
        child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${seen}`)); });
      });

      const bound = /hydra gui on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      assert.ok(bound, `the banner does not name the address it bound: ${out}`);
      // Vacuity: port 0 in the banner would mean it printed the REQUEST rather than the result,
      // and every assertion below would still pass on a page that could never connect.
      assert.notEqual(bound[1], "0", "the banner prints the requested port, not the bound one");

      const fragment = /#t=([0-9a-f]+)&b=(\S+)/.exec(out);
      assert.ok(fragment, `the suggested fragment carries no address — this is the defect: ${out}`);
      assert.equal(fragment[2], `http://127.0.0.1:${bound[1]}`,
        "the address in the fragment is not the one this process is listening on, so a reader "
        + "following the banner exactly reaches the wrong port");
      // AND THE TOKEN IN THE FRAGMENT IS THE ONE IT MINTED, not a second value that happens to
      // be hex — the two halves of that URL have to come from the same run.
      const minted = /\n\s*token ([0-9a-f]+)/.exec(out);
      assert.ok(minted, "the banner stopped printing the token");
      assert.equal(fragment[1], minted[1], "the fragment carries a different token from the banner");
    } finally { child.kill(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * THE PUBLIC CLASS, WHICH THIS API COULD NOT REACH AT ALL.
 *
 * `grep -c "post(" gui/src/server.ts` was 0. `cli.ts:647` names why nobody noticed: *"NOT
 * `publish`. That word is taken by signed channel messages… and the collision is part of why
 * nobody noticed the public class had no client path at all."* The same collision hid the same gap
 * one surface later — this API has SEND SIGNED, which the CLI calls `publish`, so a reader looking
 * for the verb found one and the capability was missing.
 *
 * Driven against the REAL vault the other write tests use, because the thing being tested is an
 * upload: a stub would assert the shape of a request nobody made.
 */
test("A PUBLIC POST GOES OUT, SPENDS AN INVITE, AND SAYS THE ID IS THE ONLY WAY BACK", async () => {
  const { alice, close: closeVault } = await conversed();
  const before = alice.invites.length;
  // The real vault, reached with the real `fetch` — `nodeAndVault` forwards anything that is not
  // the node, which is what makes this an upload rather than an assertion about one.
  const { fetchImpl } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    const r = await post(api.base, "/v1/gui/post",
      { text: "the minutes of the meeting", reason: "public interest" });
    const text = await r.text();
    assert.equal(r.status, 200, text);
    const body = JSON.parse(text) as
      { op: string; id: string; invitesLeft: number; reach: string };
    assert.equal(body.op, "post");
    // A content-addressed public id, not an empty string dressed as success. The `pub:` prefix is
    // the class marker `blobs.ts` gives a public object — asserted, because an id without it is
    // an id for a different class of object and would fetch back as missing.
    assert.match(body.id, /^pub:[0-9a-f]{16,}$/, `not a public object id: ${body.id}`);
    assert.equal(body.invitesLeft, before - 1, "a post did not spend exactly one invite");
    assert.equal(alice.invites.length, before - 1, "the spend did not reach the state");
    assert.ok(api.saved.length > 0, "a spent invite was not persisted");
    // **THE SENTENCE TRAVELS AS DATA.** A page composing this itself is a page free to soften it.
    assert.match(body.reach, /only way/,
      `the response does not say the id is the only route to the post: ${body.reach}`);
    assert.match(body.reach, /no feed/);

    // AND IT IS REALLY ON THE VAULT — the id resolves to the bytes that were posted. Without this
    // the test passes on a route that spends an invite and uploads nothing.
    const back = await fetchPosts(alice, [body.id]);
    assert.equal(back.text.get(body.id), "the minutes of the meeting",
      `the object is not readable back off the vault: ${JSON.stringify([...back.text])}`);
  } finally { api.close(); closeVault(); }
});

test("A POST WITH NO REASON IS REFUSED, AND THE REFUSAL IS NOT A DEFAULT", async () => {
  // **THE REASON IS EVIDENCE, NOT A LABEL.** `commands.ts:759`: *"an intent with no reason and no
  // confirmation time is how a public post gets made by a client that never asked anybody."* A
  // default would have this API write down that somebody decided, on behalf of a caller who was
  // never asked — so the absence has to be refused rather than filled.
  const { alice, close: closeVault } = await conversed();
  const before = alice.invites.length;
  const { fetchImpl } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    for (const [body, code] of [
      [{ text: "no reason given" }, "no_reason"],
      [{ text: "no reason given", reason: "" }, "no_reason"],
      [{ text: "no reason given", reason: "   " }, "no_reason"],
      [{ reason: "public interest" }, "no_text"],
      [{ text: "   ", reason: "public interest" }, "no_text"],
    ] as [unknown, string][]) {
      const r = await post(api.base, "/v1/gui/post", body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} was not refused`);
      const err = await refusal(r);
      assert.equal(err.code, code, `${JSON.stringify(body)} was refused as ${err.code}`);
      assert.ok(err.remedy.length > 10, `${code} names no remedy`);
    }
    // **NOTHING WAS SPENT BY A REFUSAL.** A guard that refuses after taking the invite has moved
    // the defect rather than fixed it, and `invitesLeft` is what a page shows beside the button.
    assert.equal(alice.invites.length, before, "a refused post still spent an invite");
    assert.equal(api.saved.length, 0, "a refused post wrote state");
  } finally { api.close(); closeVault(); }
});

test("THE COST IS READABLE BEFORE THE ACT, AND IT IS THE SAME WORDS THE CLI PRINTS", async () => {
  // The CLI prints `describePost()` and then posts, in one command. An API cannot: a body returned
  // with the result arrives after the act. So the description is a GET on the same path as the
  // write, and it carries the lines WHOLE — a page that paraphrases them is a page choosing which
  // parts of an irreversible act to mention.
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    const r = await api.get("/v1/gui/post");
    assert.equal(r.status, 200);
    const body = await r.json() as { lines: string[]; invitesLeft: number; cost: string };
    assert.deepEqual(body.lines, describePost(),
      "the browser is shown a different description from the one the CLI prints");
    assert.equal(body.invitesLeft, alice.invites.length);
    // The two facts people get wrong, asserted by content rather than by line count — a count
    // passes on a description that has been rewritten into something else the same length.
    const whole = body.lines.join(" ");
    assert.match(whole, /THIS IS PUBLIC/);
    assert.match(whole, /NOTHING ABOUT THIS GOES ON CHAIN/,
      "the description no longer says a post reaches no chain, which is the fact a reader coming "
      + "from `send` most needs");
    assert.match(body.cost, /invite/);
  } finally { api.close(); closeVault(); }
});

test("A POST WITH NO INVITES IS A REFUSAL WITH A REMEDY, NOT A 500", async () => {
  // `post()` THROWS "no invites left". A throw on this path reaches the 500 handler, which reports
  // a foreseeable, caller-fixable condition as a failure of this process — no remedy, and a stack
  // trace in the operator's log for a thing the caller can fix by asking for a code.
  const { alice, close: closeVault } = await conversed();
  alice.invites.length = 0;
  const { fetchImpl } = nodeAndVault(alice);
  const api = await running({ t: "ready", state: alice, file: FILE }, TOKEN, { fetchImpl });
  try {
    const r = await post(api.base, "/v1/gui/post", { text: "anything", reason: "public interest" });
    assert.equal(r.status, 409, `refused as ${r.status}`);
    const err = await refusal(r);
    assert.equal(err.code, "no_invites");
    assert.match(err.remedy, /invite/);
    assert.equal(api.saved.length, 0, "a post that could not be made still wrote state");
  } finally { api.close(); closeVault(); }
});
