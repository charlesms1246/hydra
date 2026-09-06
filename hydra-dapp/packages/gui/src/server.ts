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

import { anchorOf, attributionLabel, fingerprint, publishBundle, sendMessage, readChannel, flush,
  linkabilityOf, FLUSH_LIMIT } from "../../cli/src/commands.ts";
import { describe as describeLinkability } from "../../channel/src/crowd.ts";
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
  readonly now: () => number;
  /** Shared with the flush ticker — see `serialise.ts`. One lock, not one per entry point. */
  readonly exclusive: Exclusive;
};

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

function status(state: State, file: string): unknown {
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
    queue: {
      pending: state.pending.length,
      nextUploadAt: state.pending.length
        ? Math.min(...state.pending.map((p) => p.uploadAt))
        : null,
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
      return send(res, 200, status(got.state, got.file));
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

    if (req.method === "POST" && (sendTo || readFrom || path === "/v1/gui/flush")) {
      void (async () => {
        const channel = decodeURIComponent((sendTo ?? readFrom)?.[1] ?? "");

        // The body is read BEFORE the lock on purpose: it is a network wait on a client that may
        // be slow or hostile, and holding the write lock across it would let any caller stall
        // every other write by dribbling bytes. Nothing here touches state.
        let body: { text?: unknown; signed?: unknown } = {};
        if (sendTo) {
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
          if (typeof body.text !== "string" || body.text.trim() === "") {
            return refuse(res, { status: 400, code: "no_text",
              condition: "the request carried no message text",
              remedy: `send { "text": "…" } — an empty message is not a message` });
          }
        }

        const what = sendTo ? "send" : readFrom ? "read" : "flush";
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
        refuse(res, { status: 500, code: "failed",
          condition: e instanceof Error ? e.message : String(e),
          remedy: "nothing was saved unless the message above says otherwise — check the vault "
            + "and the node named on /v1/gui/status" });
      });
      return;
    }

    refuse(res, { status: 404, code: "no_such_route",
      condition: `${req.method} ${path} is not a route this API serves`,
      remedy: "the routes are /v1/gui/status, /v1/gui/channels and "
        + "/v1/gui/channels/<name>/messages, and POST to "
        + "/v1/gui/channels/<name>/send, /v1/gui/channels/<name>/read and /v1/gui/flush. There is "
        + "no general command endpoint, deliberately" });
  });
}
