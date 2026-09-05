"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drives the client running on the reader's own machine, over loopback.
 *
 * **Everything on this page comes from `hydra gui` on `127.0.0.1`.** Nothing is fetched from the
 * origin serving the page, nothing is stored, and no request leaves the machine. The contract is
 * `claude-docs/GUI-API-CONTRACT.md`; this file renders it and adds no claims of its own.
 *
 * ## ⛔ THE TOKEN COMES FROM THE URL FRAGMENT AND IS STRIPPED IMMEDIATELY
 *
 * A fragment is never sent to a server. A query parameter lands in `Referer`, in browser history
 * and in every log between the two — for a credential that authorises reading somebody's messages
 * off their own disk. It is read once into memory, removed from the address bar, and sent only as
 * `x-hydra-token`.
 *
 * ## ⛔ THE THREE-BRANCH ATTRIBUTION RULE, WHICH IS AN INVARIANT AND NOT A STYLE CHOICE
 *
 * `mark` is two-valued and the claim is **three**-valued: unverifiable, signed under an
 * unpublished handshake key, and signed under a published one. The two signed cases share `✓`,
 * and `commands.ts` says why the middle one matters — the signature proves the author is whoever
 * answered the handshake, *"a real guarantee and a weaker one than a reader assumes when a tick
 * is all they are shown."*
 *
 * **So `basis` is rendered as text beside every message, always.** Never as a tooltip, a colour or
 * a class: a tooltip is not there for a touch reader, a colour is not there for a colour-blind
 * one, and a class is not there for anybody. A page that shows the mark without the basis has the
 * defect the field exists to close, which is showing the strongest reading of a claim that may be
 * the weaker one.
 *
 * **`basis` and `mark` are both generated upstream and neither is written here.** A page rendering
 * attribution is a front end, and `no-invented-claims.test.ts` holds that no front end makes a
 * privacy claim in its own words — four hand-written claims have already been false. Typing a `✓`
 * into this file would be a copy that drifts from `commands.ts` silently.
 */

type Attribution = "signed" | "unverifiable";

type Message = {
  id: string;
  seq: number;
  at: number;
  mine: boolean;
  attribution: Attribution;
  mark: string;
  basis: string;
  text: string;
};

type Channel = {
  name: string;
  peer: string;
  role: string;
  messages: number;
  readTo: number;
  removedUnderProcess: number;
};

type Status = {
  fingerprint: string;
  stateFile: string;
  lockedAtRest: boolean;
  vault?: { url: string };
  chain?: { rpcUrl: string; contract: string; network: string; fromBlock: number };
  route: string;
  invitesLeft: number;
  queue?: { pending: number; nextUploadAt: number | null };
  prekeys?: { epoch: number; oneTimeLeft: number };
};

/** A refusal the API produced. `code` is branched on; the two sentences are shown verbatim. */
type Refusal = { code: string; condition: string; remedy: string };

const DEFAULT_BASE = "http://127.0.0.1:8787";

/**
 * The failure the API can never report, because the request does not arrive.
 *
 * A page on a public https origin reaching loopback is blocked by default in Chrome, gated on a
 * `local-network-access` permission that defaults to prompt and is sticky once denied. **Nothing
 * reaches the server — not even a preflight — so this sentence cannot come from the API and the
 * remedy is not in this product.** A `fetch` that rejects without a response is also what an
 * unreachable server looks like, and the page must not guess between them: both are named.
 */
const UNREACHABLE: Refusal = {
  code: "unreachable",
  condition:
    "the browser did not get a reply from that address — either nothing is listening on it, or "
    + "the browser blocked the request before it was sent",
  remedy:
    "check `hydra gui` is running and that the base URL matches the one it printed. If it is "
    + "running, the browser is refusing to let a page reach your local network: allow it for this "
    + "site in the browser's own site settings, which is the only place that can be changed",
};

export function Session() {
  const [base, setBase] = useState(DEFAULT_BASE);
  const [status, setStatus] = useState<Status | null>(null);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [tried, setTried] = useState(false);

  /*
   * The token is held in a ref rather than in state: it is a credential, and state is the thing
   * that gets serialised, logged in a devtools timeline, and passed to a child by accident.
   */
  const token = useRef<string | null>(null);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const t = hash.get("t");
    const b = hash.get("b");
    if (t) token.current = t;
    if (b) setBase(b);
    // Out of the address bar before anything else can read it — including a screenshot.
    if (t || b) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  const call = useCallback(
    async <T,>(path: string): Promise<{ ok: true; data: T } | { ok: false; err: Refusal }> => {
      try {
        const res = await fetch(`${base.replace(/\/$/, "")}/v1/gui${path}`, {
          headers: token.current ? { "x-hydra-token": token.current } : {},
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const e = body?.error;
          return {
            ok: false,
            err: e?.code
              ? e
              : {
                  code: `http_${res.status}`,
                  condition: `the API answered ${res.status} without naming a condition`,
                  remedy: "this is a defect in `hydra gui`; the response should carry an error object",
                },
          };
        }
        return { ok: true, data: body as T };
      } catch {
        // No response at all. See `UNREACHABLE` — this is the one failure the API cannot report.
        return { ok: false, err: UNREACHABLE };
      }
    },
    [base],
  );

  const connect = useCallback(async () => {
    setTried(true);
    setRefusal(null);
    const s = await call<Status>("/status");
    if (!s.ok) {
      setRefusal(s.err);
      setStatus(null);
      setChannels(null);
      return;
    }
    setStatus(s.data);
    const c = await call<{ channels: Channel[] }>("/channels");
    if (c.ok) setChannels(c.data.channels);
    else setRefusal(c.err);
  }, [call]);

  const openChannel = useCallback(
    async (name: string) => {
      setOpen(name);
      setMessages(null);
      const m = await call<{ channel: string; messages: Message[] }>(
        `/channels/${encodeURIComponent(name)}/messages`,
      );
      if (m.ok) setMessages(m.data.messages);
      else setRefusal(m.err);
    },
    [call],
  );

  // Every route is stored-state-only — no network, no chain scan — so connecting on arrival costs
  // the reader nothing and saves them a click they would always make.
  useEffect(() => {
    if (token.current) void connect();
    // Only on mount: re-running on `connect` identity would refetch on every base edit keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="session">
      <form
        className="session-connect"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <label htmlFor="base">
          <span className="prose-label">LOCAL API</span>
          <input
            id="base"
            name="base"
            type="text"
            value={base}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setBase(e.target.value)}
          />
        </label>
        <button className="button" type="submit">Connect</button>
      </form>

      {refusal && <RefusalNote refusal={refusal} />}

      {status && <StatusPanel status={status} />}

      {channels && (
        <section className="session-block">
          <h2>Conversations</h2>
          {channels.length === 0 ? (
            <p className="prose-body">No channels in this state yet.</p>
          ) : (
            <ul className="session-channels">
              {channels.map((c) => (
                <li key={c.name}>
                  <button type="button" onClick={() => void openChannel(c.name)}>
                    <span className="ch-name">{c.name}</span>
                    <span className="ch-peer">{c.peer}</span>
                    <span className="ch-count">{c.messages}</span>
                  </button>
                  {/*
                    Shown whenever it is non-zero, never folded into the message count.
                    `vault-server/src/observations.ts`: a removal indistinguishable from an expiry
                    is invisible to the people it happened to.
                  */}
                  {c.removedUnderProcess > 0 && (
                    <span className="ch-removed">
                      {c.removedUnderProcess} removed under legal process
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {open && (
        <section className="session-block">
          <h2>{open}</h2>
          {messages === null ? (
            <p className="prose-body">Reading stored history…</p>
          ) : (
            <ol className="session-messages">
              {messages.map((m) => (
                <li key={m.id} className={m.mine ? "msg mine" : "msg"}>
                  <p className="msg-text">{m.text}</p>
                  {/*
                    ⛔ `basis` is TEXT, beside every message, always. Not a tooltip, not a colour,
                    not a class. See the header — the mark is an indicator and the basis is the
                    claim, and the two signed cases are told apart only by the basis.
                  */}
                  <p className="msg-basis">
                    <span className="msg-mark" aria-hidden>{m.mark}</span>
                    <span className="msg-basis-text">{m.basis}</span>
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {!tried && !status && (
        <p className="prose-body">
          Open this page from the link <code>hydra gui</code> prints, or enter the address it
          printed above. Nothing on this page is fetched from the site serving it.
        </p>
      )}
    </div>
  );
}

/**
 * The refusal, in the API's own words.
 *
 * ⛔ `condition` and `remedy` are shown verbatim and never paraphrased. They are the same
 * sentences the CLI and the TUI print, and three surfaces disagreeing about what went wrong is a
 * defect this project has found repeatedly. The `code` is for branching, which is why it is shown
 * as a tag rather than as the message.
 *
 * `token_missing` and `token_invalid` stay distinct: one is a page that was never given a token,
 * the other a page holding one from a previous run. Collapsing them to "unauthorised" sends half
 * of those readers to the wrong place.
 */
function RefusalNote({ refusal }: { refusal: Refusal }) {
  return (
    <div className="session-refusal" role="status">
      <span className="prose-label">{refusal.code}</span>
      <p className="msg-text">{refusal.condition}</p>
      <p className="prose-body">{refusal.remedy}</p>
    </div>
  );
}

function StatusPanel({ status }: { status: Status }) {
  const scanningWholeChain = !!status.chain?.contract && status.chain?.fromBlock === 0;
  return (
    <section className="session-block">
      <h2>This machine</h2>
      <dl className="session-status">
        <Row k="IDENTITY" v={status.fingerprint} />
        <Row k="STATE FILE" v={status.stateFile} />
        <Row k="AT REST" v={status.lockedAtRest ? "encrypted" : "readable on disk"} />
        {status.vault && <Row k="VAULT" v={status.vault.url} />}
        {status.chain && <Row k="NETWORK" v={status.chain.network} />}
        {status.chain && <Row k="CONTRACT" v={status.chain.contract} />}
        <Row k="ROUTE" v={status.route} />
        {/* A count, never the codes. An invite is a credential; a page holding one can spend it. */}
        <Row k="INVITES LEFT" v={String(status.invitesLeft)} />
        {status.queue && <Row k="PENDING UPLOAD" v={String(status.queue.pending)} />}
      </dl>

      {/*
        Degraded, not broken — and it has a remedy, so it is stated rather than left to be felt as
        slowness. The TUI surfaces the same condition on its status line.
      */}
      {scanningWholeChain && (
        <p className="session-degraded">
          A contract is set but no deployment block is recorded, so every read scans the chain from
          the beginning. Reads will be slow until the client records one.
        </p>
      )}
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="session-row">
      <dt className="prose-label">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

/**
 * ⛔ THE LEGEND, AND IT IS ON THE PAGE WHENEVER ANY MESSAGE IS.
 *
 * A mark with no key is a mark a reader invents a meaning for, and the meaning they invent for a
 * tick is the strongest one available. This names what each glyph does and does not settle —
 * **including that the two signed cases share a glyph**, which is the fact the whole three-branch
 * rule exists to keep visible.
 *
 * It describes the interface rather than the guarantee: the guarantee is in each message's
 * `basis`, generated upstream. That split is deliberate — this text is hand-written and so it may
 * not make a privacy claim, and it does not need to, because it points at the sentence that can.
 *
 * ⛔ **Rendered from the page shell, not from inside the fetch branch.** It used to sit next to
 * the message list, so it existed only once a reader had opened a channel — which meant it was
 * absent from the shipped markup entirely, and a reader with no script, a reader whose API was
 * unreachable, and any check that reads the built page all saw a site with no key to its own
 * marks. `test/site.test.ts` caught that, which is the whole reason the assertion is against the
 * built HTML rather than against this file.
 */
export function AttributionLegend() {
  return (
    <dl className="session-legend">
      <div>
        <dt aria-hidden>&#10003;</dt>
        <dd>carries a signature</dd>
      </div>
      <div>
        <dt aria-hidden>?</dt>
        <dd>carries none</dd>
      </div>
      <div>
        <dt aria-hidden>&mdash;</dt>
        <dd>
          the same glyph covers more than one case, so the line beside each message is the one that
          says what was actually checked. Read that, not the glyph.
        </dd>
      </div>
    </dl>
  );
}
