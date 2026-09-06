/**
 * The local API a GUI drives, and the third front end over `commands.ts`.
 *
 * **A HOSTED PAGE TALKING TO A CLIENT ON THE USER'S OWN MACHINE.** Nothing about the product moves
 * to a server: the page sends commands and renders results, and the seed, the pool viewing key and
 * the vault content key stay in this process. `claude-docs/GUI-API-CONTRACT.md` is the written
 * shape both sides were built against, and `decisions/0046` measures what a browser will actually
 * permit — which is not what the Private Network Access specification suggests.
 *
 * **NAMED ENDPOINTS, NOT A BRIDGE.** No route forwards an arbitrary command. A general bridge is
 * the shape that grows an operator endpoint by accident and the shape where key material leaks,
 * because nobody has to decide anything to add one. Every route here is a decision, and the I6
 * test drives all of them looking for the actual secret values.
 *
 * **THIS IS A USER SURFACE (I8).** It does not grow an operator endpoint because it would be
 * convenient. Operator surfaces and user surfaces do not share a binary or a dependency path.
 *
 * THREE CONTROLS THAT FAIL DIFFERENTLY, which is why there are three rather than one:
 *
 *   - **Bound to loopback**, so nothing off this machine can open a socket at all.
 *   - **A token per run**, compared in constant time, which defeats a page that was not given it.
 *   - **A `Host` check**, which is what defeats DNS REBINDING — and rebinding is the attack an
 *     origin allowlist does not see, because it makes the request same-origin and no CORS check is
 *     ever run. See `0046`.
 *
 * `Access-Control-Allow-Origin: *` rather than a reflected origin. That is safe precisely because
 * the token is the authenticator and nothing here uses cookies: an unauthenticated request is
 * refused whatever origin it claims, and reflecting an origin would state a trust this does not
 * have. Preview deployments each being a different origin is a second reason not to pin one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { anchorOf, attributionLabel, describeFailure, fingerprint, publishBundle, sendMessage,
  readChannel, flush, linkabilityOf, gapsOf, RECONFIGURE, FLUSH_LIMIT, bundleFromChain, openAndSend }
  from "../../cli/src/commands.ts";
import { describe as describeLinkability } from "../../channel/src/crowd.ts";
import { LOOKUP_KEY_NOT_PERSON, LOOKUP_NO_ONE_TIME, LOOKUP_NODE_SEES }
  from "../../claims/src/warnings.ts";
import { BUSY, type Exclusive } from "./serialise.ts";
import type { Chain } from "../../cli/src/chain.ts";
import { oneTimeRemaining } from "../../handshake/src/prekeys.ts";
import type { State } from "../../cli/src/state.ts";

/** Hosts this will answer to. Anything else is a rebinding attempt or a misconfiguration. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type StateSource =
  | { readonly t: "ready"; readonly state: State; readonly file: string }
  | { readonly t: "none"; readonly file: string }
  | { readonly t: "locked"; readonly file: string };

export type GuiDeps = {
  /** 128 bits from the OS, minted per run. */
  readonly token: string;
  /** Re-read per request, so a client that changes state on another surface is not served stale. */
  readonly stateNow: () => StateSource;
  /** Persist after a write. The same `save` the other two front ends use. */
  readonly save: (state: State) => void;
  /** Injected so a test can drive a write without a chain. */
  readonly chainFor: (state: State) => Chain;
  /**
   * The `fetch` a lookup asks the node and the vault with, for the same reason `chainFor` is
   * injected: `POST /v1/gui/lookup` is the one route whose ORDER OF REQUESTS is the security
   * property, and a test cannot observe an order it cannot intercept.
   */
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  /** Shared with the flush ticker — see `serialise.ts`. One lock, not one per entry point. */
  readonly exclusive: Exclusive;
  /**
   * The last background upload attempt, or `null` if none has been made yet.
   *
   * Owned by whoever runs the ticker — `main.ts` — because the ticker is the only thing that can
   * fail where nobody is looking. Every other write reports its own failure to the caller that
   * asked for it.
   */
  readonly lastFlush: () => FlushAttempt | null;
};

/**
 * What happened the last time the client tried to upload.
 *
 * **A COUNT OF ATTEMPTS, NOT OF TICKS.** The ticker runs every second and mostly finds nothing due;
 * counting those would report a vault as failing when it was never asked. An attempt is a `flush`
 * that was actually called.
 */
export type FlushAttempt = {
  readonly at: number;
  readonly ok: boolean;
  readonly uploaded: number;
  readonly consecutiveFailures: number;
  /** A bounded sentence, or `null` when the attempt succeeded. Never a raw error message. */
  readonly problem: string | null;
};

/**
 * A failure as a sentence a page may be shown — the shared one where there is a shared one.
 *
 * `describeFailure` is `commands.ts`'s, and the CLI's `die()` and the TUI's effects already print
 * it: same dead vault, same words, third front end. Before this, the 500 handler here passed
 * `e.message` through raw, so a page said `fetch failed` where a terminal said which host did not
 * answer and asked whether it was running.
 *
 * **AND BOUNDED, WHICH IS THE PART THAT IS NOT SHARED.** `describeFailure` falls back to the raw
 * message when the error carries no `cause.code` — right for a terminal the user owns, and a risk
 * for a browser, because an error raised deeper in the client can interpolate a blob id or an
 * invite code, and an invite is the one credential that undoes every other protection.
 *
 * **NOT A BLANKET BAN, AND THE FIRST ATTEMPT WAS ONE.** Refusing every uncoded message deleted a
 * property this API already had and a test already asserted: a failed write says WHAT failed, so
 * `the chain refused the transaction` reaches the page instead of a shrug. Most of these messages
 * are the client's own prose, written to be read. Withholding all of them to bound a few is the
 * safe-looking choice that makes the surface less useful without making it safer.
 *
 * **THE SHAPES WERE WALKED, AND "WALKED" HAS NOW BEEN WRONG TWICE, SO READ THE LIMIT BELOW.** The
 * first version of this comment said "the two shapes actually enumerated as reachable", which was
 * not true — they were the two that came to mind. The walk that replaced it: every `${…}` inside a
 * `throw new Error` across `cli`, `channel`, `vault-client`, `handshake`, `identity` and `claims`
 * — 99 throw sites, 53 interpolating. **That walk covers what is in the state today and nothing
 * more.** A shorter secret, or one in an alphabet nobody has used yet, passes. Re-run it before
 * trusting this list, and do not upgrade "walked" into "complete".
 *
 * It found two shapes the first version missed. A **URL with a userinfo component**, because
 * `state.vaultUrl` is interpolated into failures and a vault URL is a place a credential can live.
 * And **base64**: `pending[].bodyB64` is base64 and the by-value sweep already treats it as
 * must-not-leak, so a hex-only test would have passed while that string went straight through.
 *
 * **AND THE BASE64 SHAPE WAS STILL WRONG, WHICH IS THE POINT ABOUT DENYLISTS MADE TWICE.** It
 * matched standard base64 and not base64url: `-` and `_` are outside the class, so they break the
 * run below the length bound and a value like `3914EZad3_00_HhmVq_mwn6_58XrvA-Uyk__pCuSjV8` went
 * to a browser verbatim while its standard-alphabet twin was withheld. base64url is the encoding
 * JOSE and JWK use — `handshake/src/keys.ts` already writes key coordinates in it — so it is the
 * alphabet a future field arrives in, not an exotic case. Found by a peer driving it, one message
 * after this comment claimed the list had been walked.
 *
 * **AND ONE SHAPE THAT DEFEATS ANY DENYLIST, WHICH IS THE REASON THE TEST BELOW IS THE REAL
 * GUARD.** Five sites interpolate text chosen by a remote party — `commands.ts:1052` and `:907`
 * echo the vault's response body, `chain.ts:89` and `:324` and `commands.ts:806` echo the node's
 * or the pool's. Whatever a vault puts in an error, a regex here is guessing about. That is not
 * fixable by adding shapes, and pretending otherwise is how a denylist becomes an entry-point list
 * that stopped covering seven pages.
 *
 * **AND THE LENGTH BOUND IS A GAP NO ALPHABET FIX CLOSES, MEASURED.** 20,000 samples a row: a
 * 32-byte secret in base64url went from 51% forwarded to 0%, a 64-byte one from 14% to 0% — and a
 * **16-byte secret is 22 characters, can never reach 32, and passes 100% before and after.**
 * Nothing in the state today is that short (all 73 secret-bearing values are hex-64 or base64
 * over a kilobyte), so it is a hole in the guard rather than a live leak. Nobody should have to
 * rediscover it.
 *
 * Read that row twice, because it runs backwards from the intuition: **a LONGER key is caught more
 * often, not less.** A guard that improves as the secret grows is one a reader will reason about
 * wrongly unless it says so out loud.
 *
 * So: this is a cheap guard with a decaying scope, and the test in `gui-api.test.ts` is the thing
 * that does not decay — **it WALKS the state for long strings rather than naming the fields it
 * knows about.** The first version named them, which is the entry-point list one more time, in the
 * test written to be the backstop for exactly this: a peer added a base64url field to the fixture
 * and all 25 tests passed while that value went through here into a browser-bound sentence.
 */
/**
 * Characters that make a rendering disagree with its bytes, removed before anything judges the
 * string — **including the credential filter below, which is the reason this is here and not at
 * the page.**
 *
 * Rendering was the obvious harm and the smaller one: `U+202E` makes `gnp.exe` read as `exe.png`
 * in a terminal and a browser alike. The harm that matters is that one zero-width character
 * inside a 32-character invite code splits it into two 16-character runs, and
 * {@link CREDENTIAL_SHAPED} then matches neither — so the credential the filter exists to stop
 * goes to the page, and a browser drops the character again the moment a reader copies it.
 * Measured: clean code withheld, same code plus one `U+200B` forwarded verbatim.
 *
 * **Deleted rather than spaced, and stripped BEFORE the test rather than after.** A space leaves
 * the halves apart and the filter still blind; stripping after the test is a filter that already
 * said yes. `vault-client/src/errors.ts` does the same thing for the same reason one function
 * upstream — both placements are needed, because `gist` never sees the uncoded branch here.
 *
 * C0 and C1 are spaced rather than deleted, matching `gist`: those occupy width and joining the
 * words either side of a newline invents text nobody wrote.
 */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const CREDENTIAL_SHAPED =
  /[0-9a-f]{32,}|[A-Za-z0-9+/_-]{32,}={0,2}|\benc:|\/\/[^/@\s]+:[^/@\s]+@/i;

export function problemOf(e: unknown, vaultUrl?: string): string {
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  // **CHECKED WHATEVER BRANCH PRODUCED IT.** The first version returned `describeFailure`'s
  // sentence unchecked, and that sentence interpolates the vault URL — so a URL carrying a
  // credential went to the page through the one path that skipped the check. A bound with a
  // bypass in its shortest branch is not a bound.
  const said = (code
    ? describeFailure(e, vaultUrl)
    : e instanceof Error ? e.message : String(e))
    .replace(INVISIBLE, "")
    .replace(CONTROL, " ");
  if (!CREDENTIAL_SHAPED.test(said)) return said;
  return "the client could not complete that, and the reason it gave carries something that must "
    + "not go to a browser — `hydra gui` has printed the detail in its own terminal";
}

type Fail = { status: number; code: string; condition: string; remedy: string };

/**
 * Constant time, and length-safe.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a length oracle if it
 * escaped as a different response. The length check happens first and both paths refuse the same.
 */
function tokenMatches(offered: string, expected: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Every refusal names its condition and its remedy — a browser reading it is not an exemption. */
function refuse(res: ServerResponse, fail: Fail): void {
  send(res, fail.status,
    { error: { code: fail.code, condition: fail.condition, remedy: fail.remedy } });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "x-hydra-token, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    // **SENT THOUGH CHROME 151 NEVER ASKS FOR IT.** Measured: `Access-Control-Request-Private-Network`
    // was absent from every request including the preflights that succeeded, so this cannot be what
    // makes the API reachable there. It is one line and it is correct for a browser still on the
    // preflight model, which is the only reason it is here. `decisions/0046`.
    "access-control-allow-private-network": "true",
    // A local API must never be cached by anything: the state changes underneath it.
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

/** A message is text, and a bound stops an unauthenticated body filling memory before the token. */
const MAX_BODY = 64 * 1024;

/** The request body, or `null` if it went over {@link MAX_BODY}. Never buffers past the bound. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let text = "";
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      text += chunk.toString("utf8");
      // Checked as it arrives rather than at the end: a `content-length` a caller supplies is a
      // number a caller supplies, and the point of the bound is to not hold the bytes.
      if (text.length > MAX_BODY) { over = true; text = ""; }
    });
    req.on("end", () => resolve(over ? null : text));
    req.on("error", () => resolve(null));
  });
}

/** The state, or the reason there is not one, in the vocabulary the page branches on. */
function stateOr(deps: GuiDeps): { state: State; file: string } | Fail {
  const now = deps.stateNow();
  if (now.t === "ready") return { state: now.state, file: now.file };
  if (now.t === "locked") {
    return { status: 409, code: "state_locked",
      condition: `the state file at ${now.file} is encrypted`,
      remedy: "restart `hydra gui` and give it the passphrase when it asks" };
  }
  return { status: 409, code: "no_state",
    condition: `there is no state file at ${now.file}`,
    remedy: "create an identity first — `hydra init`, or the first-run page in `hydra tui`" };
}

const isFail = (v: unknown): v is Fail =>
  typeof v === "object" && v !== null && "code" in v && "remedy" in v;

// ---------------------------------------------------------------------------
// The routes. Read-only in this pass: no network, no writes, nothing destructible.
// ---------------------------------------------------------------------------

function status(state: State, file: string, lastFlush: FlushAttempt | null): unknown {
  return {
    fingerprint: fingerprint(publishBundle(state)),
    stateFile: file,
    lockedAtRest: state.lockedAtRest ?? false,
    vault: { url: state.vaultUrl },
    chain: {
      rpcUrl: state.rpcUrl,
      contract: state.contract,
      network: state.network ?? null,
      fromBlock: state.fromBlock,
    },
    route: state.controlUrl ? "pool" : "direct",
    // **A COUNT, NEVER THE CODES.** An invite is the credential a source asks an organisation for
    // before their first message — `vault-server/src/observations.ts` calls it the row that can
    // undo every other row. A page holding codes is a page that can spend them.
    invitesLeft: state.invites.length,
    /**
     * What this install still cannot do, and what nobody chose.
     *
     * **THE SAME OMISSION THIS SURFACE ALREADY MADE ONCE.** The linkability row in
     * `FRONT-END-PARITY-INVENTORY.md` records that the GUI served a chat and never mentioned the
     * crowd at all — *"a parity document with no row for a thing cannot report that thing
     * missing"* — and this is that shape again: `contract: ""` and `invitesLeft: 0` shipped as a
     * string and a number, with nothing saying they are the reason nothing can be sent.
     *
     * `gapsOf` is `claims/src/setup.ts` through the one `State` projection, so the CLI's printed
     * block, the TUI's status page and this array are the same sentences. **`RECONFIGURE` rides
     * with it** because the remedy is useless split from the condition, and a page that had to
     * fetch the two separately would be a page that could render one without the other.
     *
     * **WHAT THIS CANNOT DO, stated where the I7 and linkability rows already concede it:** it
     * guarantees a page cannot get `invitesLeft` without the sentence explaining where invites
     * come from. It cannot make the page draw the difference between a blocker and a value, which
     * is exactly the mistake the other two surfaces were making. That half is `web/`'s.
     */
    setup: { gaps: gapsOf(state), reconfigure: RECONFIGURE },
    queue: {
      pending: state.pending.length,
      nextUploadAt: state.pending.length
        ? Math.min(...state.pending.map((p) => p.uploadAt))
        : null,
      // **A DEAD VAULT USED TO BE INVISIBLE HERE, AND THE COMMENT THAT SAID OTHERWISE WAS THE
      // DEFECT.** The ticker swallows an upload failure — it must, or one dead vault takes the
      // process down — and `main.ts` said the page "sees the queue standing still on `status`,
      // which is the honest signal". It did not. Every field above is derived from the state
      // file, `nextUploadAt` sits in the past whether uploads are working or not, and the payload
      // for a client with a dead vault was BYTE-IDENTICAL to the payload for a healthy one.
      //
      // So a user watched a queue that looked about to drain, indefinitely, and believed their
      // messages were going out. That is the failure direction that matters: telling somebody
      // they are in better shape than they are. A comment asserting an observable the payload
      // never carried is worse than no comment, because it stops the next reader looking.
      lastAttempt: lastFlush,
    },
    prekeys: { epoch: state.prekeys.epoch, oneTimeLeft: oneTimeRemaining(state.prekeys) },
  };
}

function channels(state: State): unknown {
  return {
    channels: Object.entries(state.channels).map(([name, c]) => ({
      name,
      // A FINGERPRINT, NOT A KEY. The page needs to tell two peers apart, not to hold material.
      peer: c.peer,
      role: c.role,
      messages: c.history.length,
      readTo: c.readTo,
      // Non-zero is not an error and must be shown: a removal indistinguishable from expiry is
      // invisible to the people it happened to. See D6.
      removedUnderProcess: c.removedUnderProcess?.length ?? 0,
    })),
  };
}

/**
 * A channel's stored messages as the page sees them.
 *
 * **ONE RENDERER FOR `GET …/messages` AND `POST …/read`**, because two would be two descriptions
 * of the same message and this repository has spent a week on what that costs. `read` fetches and
 * then returns what is stored, so the shapes are not merely similar — they are the same thing.
 */
function rendered(state: State, name: string): unknown[] {
  const channel = state.channels[name];
  if (!channel) return [];
  return channel.history.map((m) => ({
    id: m.id,
    seq: m.seq,
    at: m.at,
    mine: m.mine,
    attribution: m.attribution,
    mark: attributionLabel(m, name, anchorOf(state, name)).mark,
    basis: attributionLabel(m, name, anchorOf(state, name)).basis,
    text: m.text,
  }));
}

/**
 * How linkable this conversation is — **the figure and the sentences that qualify it, in one
 * object, from one source.**
 *
 * The other two front ends render `describe(...)` and nothing else, so a crowd of 14 arrives at a
 * reader already carrying the fact that batchers publishing alongside them were counted as people.
 * This surface used to say nothing at all about linkability, and the absence read as nothing to
 * say — on **the front end that most resembles an ordinary messenger, and so the one a person is
 * likeliest to use having read none of this.** The other two tell them the operator can name them
 * as the sender of every message here.
 *
 * `lines` IS `describe`, THE CALL THE CLI AND TUI MAKE, not a paraphrase of it. That is the part
 * worth having: the qualification cannot drift between surfaces, because there is one array. The
 * two assertions are split to match — `crowd.test.ts` holds that `describe` says it at all, and
 * `gui-api.test.ts` holds that this payload carries what `describe` said.
 *
 * **AND THE LIMIT, SAID PLAINLY, BECAUSE HALF OF THIS IS NOT MINE TO GUARANTEE.** What an API can
 * do is refuse to serve the reassuring number on its own: `crowd` never appears in a payload that
 * `lines` is missing from. What it cannot do is make a page print a paragraph next to a meter —
 * the same gap the I7 attribution row concedes, and it is a gap, not a technicality.
 */
/**
 * **NOT NAMED `linkability`, AND THE REASON IS A GUARD.** `crowd.ts` exports a `linkability` that
 * nothing outside its own tests calls, exempted by name in `reachability-sweep.test.ts` because
 * the client's path is stateful and reaches the property another way. That sweep decides "used" by
 * matching the bare token across `src`, so a field called `linkability` here would have made a
 * genuinely unwired export look wired and **quietly retired the guard watching it** — which the
 * sweep caught, in the one test written to notice a stale exemption.
 *
 * `howLinkable` is also the phrase the product already uses: `describe`'s first line is "How
 * linkable this conversation is".
 */
function howLinkable(state: State, name: string): unknown {
  const l = linkabilityOf(state, name);
  return {
    // Three-valued in effect: not measured, measured at zero, measured above zero. `known: false`
    // is "nothing has asked a node who else was publishing", which is NOT a crowd of zero and not
    // a good answer either — the sentences are what tell those two apart.
    known: l.known,
    crowd: l.crowd,
    identified: l.identified,
    lines: describeLinkability(l),
  };
}

/**
 * The conversation as the page sees it. **One shape for `GET …/messages` and `POST …/read`**, for
 * the reason `rendered` gives: two constructions of one view are two descriptions that agree until
 * somebody edits one. Attaching the linkability object at two call sites would have been exactly
 * that, and this file has already paid for it once.
 */
function conversation(state: State, name: string): { howLinkable: unknown; messages: unknown[] } {
  return { howLinkable: howLinkable(state, name), messages: rendered(state, name) };
}

function messages(state: State, name: string): unknown | Fail {
  const channel = state.channels[name];
  if (!channel) {
    return { status: 404, code: "no_such_channel",
      condition: `there is no channel called ${JSON.stringify(name)}`,
      remedy: "list them at /v1/gui/channels — the name is the one you gave when you opened it" };
  }
  return {
    channel: name,
    // STORED HISTORY, NO NETWORK. Fetching new messages is `POST …/read`, and it is a different
    // verb because it costs a chain scan and a vault batch. A GET that quietly did that would be a
    // GET that takes a hundred seconds on a client whose discovery failed.
    ...conversation(state, name),
  };
}

// ---------------------------------------------------------------------------

/** Build the server. Not listening — the caller binds, so a test can choose the port. */
export function guiServer(deps: GuiDeps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // ORDER IS THE POLICY. Host before token, token before routing: a wrong host must not be able
    // to learn whether a token is right, and neither must reach a handler.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOOPBACK.has(host)) {
      return refuse(res, { status: 403, code: "host_not_loopback",
        condition: `this request arrived addressed to ${host || "(no Host header)"}`,
        remedy: "reach it at 127.0.0.1. A name that resolves here is how DNS rebinding reaches a "
          + "local server, so the address has to be the address" });
    }

    // The preflight is answered before the token is checked, deliberately: a browser sends no
    // custom headers on a preflight, so requiring one here would refuse every legitimate request
    // before it was ever made. The preflight discloses nothing but the shape of the API.
    if (req.method === "OPTIONS") { send(res, 204, {}); return; }

    const offered = req.headers["x-hydra-token"];
    if (typeof offered !== "string" || offered === "") {
      return refuse(res, { status: 401, code: "token_missing",
        condition: "this request carried no x-hydra-token header",
        remedy: "`hydra gui` prints the token when it starts. The page takes it from the URL "
          + "fragment and sends it as a header" });
    }
    if (!tokenMatches(offered, deps.token)) {
      return refuse(res, { status: 401, code: "token_invalid",
        condition: "the x-hydra-token on this request is not the one this process minted",
        remedy: "a token is minted per run, so an old one stops working — use the one `hydra gui` "
          + "printed this time" });
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // **NOT DESTRUCTURED INTO A `state` BINDING, AND THAT IS DELIBERATE.** This snapshot is taken
    // before the route runs, which is fine for a GET and was WRONG for a write — see the lock
    // below. Leaving it as `got` means no variable called `state` is in scope further down, so
    // the defect cannot be reintroduced by an edit that simply reads the nearest thing to hand.
    const got = stateOr(deps);
    if (isFail(got)) return refuse(res, got);

    if (req.method === "GET" && path === "/v1/gui/status") {
      return send(res, 200, status(got.state, got.file, deps.lastFlush()));
    }
    if (req.method === "GET" && path === "/v1/gui/channels") {
      return send(res, 200, channels(got.state));
    }

    const inChannel = /^\/v1\/gui\/channels\/([^/]+)\/messages$/.exec(path);
    if (req.method === "GET" && inChannel) {
      const body = messages(got.state, decodeURIComponent(inChannel[1]!));
      return isFail(body) ? refuse(res, body) : send(res, 200, body);
    }

    // -----------------------------------------------------------------------------------------
    // Writes. `POST`, never `GET` — a `GET` that publishes to a chain is reachable by prefetch,
    // link preview and history replay, which are three ways a message gets published that nobody
    // chose. Every one of them goes through `deps.exclusive`.
    // -----------------------------------------------------------------------------------------

    const sendTo = /^\/v1\/gui\/channels\/([^/]+)\/send$/.exec(path);
    const readFrom = /^\/v1\/gui\/channels\/([^/]+)\/read$/.exec(path);
    // **NOT UNDER `/channels/:name/`, BECAUSE THERE IS NO CHANNEL YET.** This is the route that
    // MAKES one, and it is the only thing on this API a caller with nothing can usefully do: every
    // other write names a conversation that already exists, so a page opened by a source who has
    // never spoken to anyone could previously do nothing at all and had to reach a terminal first.
    // `invite` and `collect` are the other two ways in and would be siblings here, not verbs on a
    // channel that has not been opened.
    const lookUp = path === "/v1/gui/lookup";

    if (req.method === "POST" && (sendTo || readFrom || lookUp || path === "/v1/gui/flush")) {
      // Named out here because the `catch` below needs it too, and an operator-side log that does
      // not say which operation failed is a log that costs a reader the one thing it had.
      const what = sendTo ? "send" : readFrom ? "read" : lookUp ? "lookup" : "flush";
      void (async () => {
        const channel = decodeURIComponent((sendTo ?? readFrom)?.[1] ?? "");

        // The body is read BEFORE the lock on purpose: it is a network wait on a client that may
        // be slow or hostile, and holding the write lock across it would let any caller stall
        // every other write by dribbling bytes. Nothing here touches state.
        let body: { text?: unknown; signed?: unknown; name?: unknown; address?: unknown } = {};
        // The address, parsed OUT HERE. `BigInt("nonsense")` throws, and inside the lock that
        // throw would reach the 500 path — reporting a caller's typo as a failure of this process
        // and spending the write lock to do it. Parsing is synchronous, so it adds no `await`
        // between the snapshot and the acquisition; see `serialise.ts`.
        let address = 0n;
        if (sendTo || lookUp) {
          const raw = await readBody(req);
          if (raw === null) {
            return refuse(res, { status: 413, code: "body_too_large",
              condition: `a request body over ${MAX_BODY} bytes arrived`,
              remedy: "a message is text; send a shorter one" });
          }
          try { body = raw === "" ? {} : JSON.parse(raw) as typeof body; } catch {
            return refuse(res, { status: 400, code: "not_json",
              condition: "the request body is not JSON",
              remedy: `send { "text": "…", "signed": false }` });
          }
          if (sendTo && (typeof body.text !== "string" || body.text.trim() === "")) {
            return refuse(res, { status: 400, code: "no_text",
              condition: "the request carried no message text",
              remedy: `send { "text": "…" } — an empty message is not a message` });
          }
          if (lookUp) {
            if (typeof body.name !== "string" || body.name.trim() === "") {
              return refuse(res, { status: 400, code: "no_name",
                condition: "the request named no channel to open",
                remedy: `send { "name": "…", "address": "0x…" } — the name is yours to choose and `
                  + "is what you will see this conversation under" });
            }
            // **A BARE `BigInt()` WOULD ACCEPT `""` AS ZERO**, and zero reads as "no identity" on
            // this contract, so an empty address would travel all the way to the node and come
            // back as "they have published nothing" — a true sentence about a question nobody
            // asked. Refused here, where it is still a typo.
            if (typeof body.address !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(body.address)) {
              return refuse(res, { status: 400, code: "not_an_address",
                condition: `${JSON.stringify(body.address ?? null)} is not a Starknet address`,
                remedy: "a Starknet address is `0x` and up to 64 hex digits. This is the address "
                  + "they published their record under, which they tell you or publish somewhere" });
            }
            address = BigInt(body.address);
          }
        }

        const done = await deps.exclusive(what, async () => {
          // **THE SNAPSHOT IS TAKEN HERE, INSIDE THE LOCK. THIS LINE IS THE FIX (G1).** It used to
          // use the one taken at dispatch, above — before `readBody` awaited the request body.
          // That yield is long enough for another request to run a whole send and save it, and
          // this handler would then mutate and save a state that never contained it: a message
          // published to the chain, answered 200, and absent from history, with the cover objects
          // queued for it gone too, leaving a recipient pointing at a blob nobody will upload.
          //
          // A lock over stale state serialises execution and not the thing execution is for.
          // `main.ts`'s flush ticker already called `stateNow()` inside `exclusive`; the ticker
          // was right and the handler was not, and that asymmetry is what the shape should have
          // been read against.
          const fresh = stateOr(deps);
          if (isFail(fresh)) return fresh;
          const state = fresh.state;

          // CHECKED AGAINST THE FRESH STATE, not the dispatch snapshot: a channel removed while
          // this request waited is a channel this request must not write to. It costs the lock to
          // answer a 404, which is the correct price for an answer that is true.
          if ((sendTo || readFrom) && !state.channels[channel]) {
            return { status: 404, code: "no_such_channel",
              condition: `there is no channel called ${JSON.stringify(channel)}`,
              remedy: "list them at /v1/gui/channels — the name is the one you gave when you "
                + "opened it" } satisfies Fail;
          }

          if (lookUp) {
            const name = (body.name as string).trim();
            // CHECKED IN HERE FOR A REASON THAT IS NOT TIDINESS. `openAndSend` deletes
            // `state.channels[name]` when the vault post fails, to avoid leaving a channel the
            // other side will never know about. Against a name that was ALREADY TAKEN, that undo
            // deletes somebody else's conversation — so a lookup onto an existing name is refused
            // before `open` can overwrite it, against the fresh state, for the same reason the
            // 404 above is.
            if (state.channels[name]) {
              return { status: 409, code: "name_taken",
                condition: `there is already a conversation called ${JSON.stringify(name)}`,
                remedy: "pick another name — this one is in use, and opening over it would lose "
                  + "the conversation that has it" } satisfies Fail;
            }
            // **TWO STEPS, ONE HANDLER, AND THE ORDER IS THE CLAIM.** `bundleFromChain` asks the
            // node and verifies the record's anchor signature against the address; only if that
            // succeeds does anything reach the vault. A lookup that finds nothing therefore
            // discloses nothing to the vault operator — which is the whole of `LOOKUP_NODE_SEES`,
            // and it is false the instant these two awaits are swapped, because a mistyped
            // address would then write a prekey message into a stranger's mailbox.
            // `gui-api.test.ts` fails if the vault is contacted by a lookup that found no record.
            const bundle = await bundleFromChain(state, address, deps.fetchImpl);
            const { slot } = await openAndSend(state, name, bundle, deps.fetchImpl);
            deps.save(state);
            return {
              op: "lookup", channel: name, address: body.address as string,
              // The fingerprint is what makes the channel mean anything, and it has to be checked
              // by some route that is not this one — the same sentence both other front ends
              // print beside it.
              fingerprint: fingerprint(bundle), slot,
              // **THE CAVEATS TRAVEL IN THE RESPONSE, NOT IN THE PAGE'S OWN WORDS.** These are the
              // `claims/src/warnings.ts` entries the CLI and the TUI render, shipped as data so a
              // page cannot summarise, reorder or drop one — the failure `claims-not-duplicated`
              // exists for, arriving on a surface where it would have been invisible because the
              // wording would have lived in a different repository directory.
              warnings: [LOOKUP_KEY_NOT_PERSON, LOOKUP_NO_ONE_TIME, LOOKUP_NODE_SEES]
                .map((w) => ({ id: w.id, short: w.short, full: w.full })),
            };
          }
          if (sendTo) {
            // SIGNED IS EXPLICIT AND DEFAULTS TO DENIABLE, the way both other front ends have it:
            // `send` and `publish` are two verbs rather than a flag, because a user who cannot
            // tell which they just did has neither.
            const signed = body.signed === true;
            const r = await sendMessage(state, deps.chainFor(state), channel,
              signed ? "signed" : "ephemeral", body.text as string, deps.now());
            deps.save(state);
            return { op: "send", channel, signed, ...r };
          }
          if (readFrom) {
            await readChannel(state, deps.chainFor(state), channel);
            deps.save(state);
            // AND THE FIGURE IS RECOMPUTED HERE, AFTER THE SCAN, not carried from before it. A
            // read is the only thing that learns who else was publishing, so this is the one
            // response where the crowd can have just changed.
            return { op: "read", channel, ...conversation(state, channel) };
          }
          const r = await flush(state, deps.now(), undefined, FLUSH_LIMIT);
          deps.save(state);
          return { op: "flush", ...r };
        });

        if (isFail(done)) return refuse(res, done);
        if (done === BUSY) {
          // **REFUSES RATHER THAN QUEUES** — see `serialise.ts`. The page can say "still sending"
          // and ask again; a queue would turn a slow publish into the burst the timing defence
          // exists to prevent.
          return refuse(res, { status: 409, code: "busy",
            condition: `${deps.exclusive.running() ?? "another operation"} is already running, and `
              + "two at once would interleave two writes to one state file",
            remedy: "wait for it to finish and send this again — nothing has been lost" });
        }
        send(res, 200, done);
      })().catch((e: unknown) => {
        // A THROWN WRITE IS STILL A SENTENCE. The lock is released by `serialise`'s `finally`
        // whatever happens here.
        //
        // **THE DETAIL GOES TO THE TERMINAL AND THE SENTENCE GOES TO THE PAGE**, which is what
        // lets `problemOf` refuse to forward a message it does not recognise without losing it.
        console.error(`hydra gui: ${what} failed:`, e);
        refuse(res, { status: 500, code: "failed",
          condition: problemOf(e, got.state.vaultUrl),
          // **NOT "NOTHING WAS SAVED".** That was written when a 200 did not guarantee a save
          // either, and it was covering for G1. What is actually true: this operation did not
          // reach its `save`, so the client's record is whatever the last successful save holds —
          // and anything it had already put on the chain or in the vault before it threw stays
          // there. A retry is safe; the queue on /v1/gui/status is what to read afterwards.
          remedy: "this did not finish, and the client's record of it is whatever "
            + "/v1/gui/status shows. Sending it again is safe" });
      });
      return;
    }

    refuse(res, { status: 404, code: "no_such_route",
      condition: `${req.method} ${path} is not a route this API serves`,
      remedy: "the routes are /v1/gui/status, /v1/gui/channels and "
        + "/v1/gui/channels/<name>/messages, and POST to /v1/gui/lookup, "
        + "/v1/gui/channels/<name>/send, /v1/gui/channels/<name>/read and /v1/gui/flush. There is "
        + "no general command endpoint, deliberately" });
  });
}
