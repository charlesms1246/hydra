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
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { codeOf } from "../src/prose.ts";
import { randomBytes } from "node:crypto";

import { guiServer, type StateSource } from "../../gui/src/server.ts";
import { serialise, type Exclusive } from "../../gui/src/serialise.ts";
import { init, publishBundle, open, accept, sendMessage, readChannel, flush,
  SIGNED_MARK, UNVERIFIABLE_MARK } from "../../cli/src/commands.ts";
import { memoryChain } from "../../cli/src/chain.ts";
import { MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";
import type { State } from "../../cli/src/state.ts";
import { Vault } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
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
  accept(bob, "with-alice", open(alice, "with-bob", publishBundle(bob, 0)));
  const chain = memoryChain();
  const sent = await sendMessage(alice, chain, "with-bob", "ephemeral", "the usual place", T0);
  await flush(alice, sent.uploadAt + MIN_JITTER_BLOCKS * BLOCK, undefined, Infinity);
  await readChannel(bob, chain, "with-alice");
  return { alice, bob, close: () => server.close() };
}

async function running(source: StateSource, token = TOKEN, over: Partial<{
  chainFor: (s: State) => never; now: () => number; exclusive: Exclusive;
}> = {}) {
  const saved: State[] = [];
  const server = guiServer({
    token,
    stateNow: () => source,
    save: (s) => { saved.push(s); },
    chainFor: (s) => memoryChain() as never,
    now: () => T0,
    exclusive: serialise(),
    ...over,
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const get = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { headers: { "x-hydra-token": token }, ...init });
  return { server, base, saved, get, close: () => server.close() };
}

const ROUTES = (channel: string) =>
  ["/v1/gui/status", "/v1/gui/channels", `/v1/gui/channels/${channel}/messages`];

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
  const { alice, close: closeVault } = await conversed();
  const api = await running({ t: "ready", state: alice, file: FILE });
  try {
    const bodies: string[] = [];
    for (const route of ROUTES("with-bob")) bodies.push(await (await api.get(route)).text());
    const all = bodies.join("\n");

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
    const public_ = new Set<string>([
      alice.contract, alice.rpcUrl, alice.vaultUrl, FILE,
      // A PEER FINGERPRINT IS A HASH OF TWO PUBLIC KEYS and it is the thing users read to each
      // other out of band to check they are talking to who they think. Verified while writing
      // this: its second half is the first 16 hex of the peer's SIGNING key, which is public by
      // construction. Withholding it would break the only verification a human can perform.
      ...Object.values(alice.channels).map((c) => c.peer),
      // A BLOB ID IS THE PUBLIC HANDLE the vault is asked for by anyone fetching the object, and
      // `vault-server/src/observations.ts` already publishes that the operator sees it.
      ...Object.values(alice.channels).flatMap((c) => c.history.map((h) => h.id)),
    ]);
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
    for (const route of ROUTES("with-alice")) assert.equal((await api.get(route)).status, 200);
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
    for (const path of ["/v1/gui/channels/with-bob/send", "/v1/gui/channels/with-bob/read",
      "/v1/gui/flush"]) {
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
