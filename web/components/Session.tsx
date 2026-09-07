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

/**
 * Whether uploads are actually working — **the only field in `status` that knows.**
 *
 * `null` is a third value and not a quiet success: it means no attempt has been made yet. Until
 * 2026-09-06 this did not exist, and the payload for a client whose vault had been dead for
 * minutes was byte-identical to one whose vault was fine — every other field comes from the state
 * file, and `nextUploadAt` sits in the past either way. A reader watched a queue that looked about
 * to drain, indefinitely, and believed their messages were going out.
 *
 * `consecutiveFailures` counts ATTEMPTS, not ticks. The uploader runs every second and mostly
 * finds nothing due; counting those would report a vault as failing when it was never asked.
 */
type Attempt = {
  at: number;
  ok: boolean;
  uploaded: number;
  consecutiveFailures: number;
  problem: string | null;
};

type Status = {
  fingerprint: string;
  stateFile: string;
  lockedAtRest: boolean;
  vault?: { url: string };
  chain?: { rpcUrl: string; contract: string; network: string; fromBlock: number };
  route: string;
  invitesLeft: number;
  queue?: { pending: number; nextUploadAt: number | null; lastAttempt?: Attempt | null };
  prekeys?: { epoch: number; oneTimeLeft: number };
};

/**
 * How linkable this conversation is — **the figure and the sentences that qualify it, together.**
 *
 * `lines` is `describe(...)` from `channel/src/crowd.ts`, the same array the CLI prints and the
 * TUI renders. It is not a paraphrase and this page does not write one: at the window this client
 * reads, the rule that discounts automated accounts almost never fires, so batchers and bots
 * publishing alongside you are counted as people — and `lines` is where that is said.
 *
 * **`known: false` is a third value and not a crowd of zero.** It means nothing has asked a node
 * yet, which is not the same as a good answer.
 */
type HowLinkable = { known: boolean; crowd: number; identified: number; lines: string[] };

/** What `POST …/send` answers with. `uploadAt` and `decoys` are the timing defence, made visible. */
type Sent = { op: "send"; channel: string; signed: boolean; txHash: string; uploadAt: number; decoys: number };

/** A refusal the API produced. `code` is branched on; the two sentences are shown verbatim. */
type Refusal = { code: string; condition: string; remedy: string };

/**
 * What `POST /lookup` answers with — and `warnings` is the reason the shape is worth naming.
 *
 * ⛔ **THE THREE COSTS ARE DATA FROM THE API, NOT COPY IN THIS FILE.** They are generated from
 * `claims/src/warnings.ts`, the same array the CLI prints and the TUI's Connect page renders, and
 * `claims-not-duplicated.test.ts` fails if any of the three surfaces drops one or says it in its
 * own words. A page that wrote its own version of "the record names the address, not the person"
 * would be the fourth copy of a sentence this product has already had drift three times.
 */
type Opened = {
  op: "lookup" | "invite"; channel: string; address?: string; fingerprint: string; slot: number;
  warnings: { id: string; short: string; full: string[] }[];
};

/**
 * What `POST /collect` answers with — **and `rejected` is why it is two numbers, not a list.**
 *
 * A mailbox slot is writable by anyone, so something that will not open is expected rather than
 * exceptional. A page shown only `accepted` renders "somebody wrote you something unreadable" and
 * "nobody has written" as the same empty state, which is a false statement about a mailbox made by
 * a layout. Both figures arrive; `CollectedNote` says which case it is.
 */
type Collected = { op: "collect"; accepted: string[]; rejected: number };

/**
 * **NO DEFAULT, AND THE EMPTY STRING IS THE DECISION RATHER THAN AN OVERSIGHT.**
 *
 * This was `http://127.0.0.1:8787`. `hydra gui` binds port **0** — any free port — deliberately,
 * because a fixed one collides and because nothing should be discoverable at a known address
 * without the token. **So that default could only ever be right by coincidence**, and 8787 is the
 * vault's port in this project's own demo: the first person to drive this page connected to the
 * vault and died in CORS.
 *
 * A default that is wrong by construction is worse than none. It costs a reader a failed
 * connection before they learn to read the fragment, and it teaches them the address is something
 * this page knows. The server prints the real one in `#t=…&b=…` — the fragment is the fact, and a
 * guess competing with a fact loses. **That `b=` was added to the server's banner in the same
 * change**: it printed only `t=`, so "lean on what the server prints" was advice about something
 * that did not exist yet, and removing the default without it would have left this page with
 * nothing to dial.
 */
const DEFAULT_BASE = "";

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

/**
 * @param disclosure Copy the PAGE owns — the legend and what this page is — folded into the `?`.
 *   Passed in rather than imported here so the prose stays with the route that publishes it, and
 *   so it is server-rendered into the shipped HTML rather than assembled on a click.
 */
export function Session({ disclosure }: { disclosure?: React.ReactNode }) {
  const [base, setBase] = useState(DEFAULT_BASE);
  const [status, setStatus] = useState<Status | null>(null);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [tried, setTried] = useState(false);
  const [howLinkable, setHowLinkable] = useState<HowLinkable | null>(null);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<Sent | null>(null);
  /*
   * ⛔ **THE ONE THING A READER WITH NO CONVERSATIONS CAN DO.** Every other write on this API names
   * a conversation that already exists, so a source arriving here with nothing but an address
   * could previously do nothing at all and had to reach a terminal first — which is the opposite
   * of the ordering this product wants, on the surface a person is likeliest to arrive at.
   */
  const [peerName, setPeerName] = useState("");
  const [peerAddress, setPeerAddress] = useState("");
  /*
   * The bundle FILE'S CONTENTS, read here in the page. The API takes the bytes and refuses a path,
   * deliberately — a `{ "path": … }` on a loopback route is an arbitrary local file read granted
   * to whatever holds the token. So the browser's own file picker, which can only give the page a
   * file a person chose, does the reading.
   */
  const [peerBundle, setPeerBundle] = useState("");
  const [opened, setOpened] = useState<Opened | null>(null);
  /*
   * ⛔ **THE RECEIVER'S SIDE, AND IT IS THE ONLY CONTROL HERE THAT IS NOT THE SOURCE'S.** Without
   * it somebody can be REACHED through this page and cannot answer through it — an organisation
   * publishing an address would have to drop to a terminal to accept a first contact.
   */
  const [collected, setCollected] = useState<Collected | null>(null);
  /*
   * ⛔ **`null` MEANS "FOLLOW THE LIST"; A BOOLEAN MEANS SOMEBODY DECIDED.**
   *
   * This was `open={!channels || channels.length === 0}` — a prop derived from the list — and that
   * is a defect rather than a shortcut. A successful lookup takes the list from 0 to 1, so the
   * prop flipped and React closed the panel **with the three costs inside it**, at the instant
   * they were produced, for a reader with no conversations: every source, exactly once, on the
   * one lookup that is their first contact. Every later lookup looked fine because the prop was
   * already false.
   *
   * The disclosure is out of the fold now, so this can no longer hide one whatever it does. This
   * exists so the FORM does not snap shut mid-use either: the derived value is only a starting
   * point, and a toggle — or a result worth staying open for — settles it.
   */
  const [foldOpen, setFoldOpen] = useState<boolean | null>(null);
  /*
   * ⛔ `busy` IS NOT A FAILURE AND IS HELD SEPARATELY FROM `refusal`.
   *
   * The client runs one write at a time by design and refuses a second rather than queueing it,
   * because a queue turns a slow publish into the burst the timing defence exists to prevent. And
   * the resident flush ticker takes that same lock every second — so a reader meets `busy` without
   * ever double-clicking anything. Rendering it as an error would show failures during entirely
   * normal operation, which teaches people to ignore this page's failures.
   */
  const [busy, setBusy] = useState<Refusal | null>(null);
  /** Which write is in flight, so the buttons disable and the reader knows what is happening. */
  const [working, setWorking] = useState<string | null>(null);

  /*
   * The token is held in a ref rather than in state: it is a credential, and state is the thing
   * that gets serialised, logged in a devtools timeline, and passed to a child by accident.
   */
  const token = useRef<string | null>(null);

  /*
   * ⛔ **THE BASE IS HELD IN A REF AS WELL AS IN STATE, AND THAT IS A FIX RATHER THAN A STYLE.**
   *
   * The mount effect reads `#b=` and called `setBase`; the auto-connect effect ran in the same
   * commit and captured the base from the render BEFORE that state update — so a page opened at
   * `#t=…&b=http://127.0.0.1:19100` dialled the then-default `:8787`, failed, and told the reader
   * nothing was listening at an address they had not asked for. (There is no default now — that
   * turned out to be a second defect behind this one — but the ordering bug this ref fixes is
   * unchanged: `b=` still has to reach `call` in the commit that sets it.) Found by opening the page against
   * a real `hydra gui` on a non-default port; a component test with a mocked fetch would have
   * asserted the request was made and never noticed where it went.
   *
   * `call` reads the ref, so the address a request uses is the address that was last set rather
   * than the one that was current when the callback was built.
   */
  const baseRef = useRef(DEFAULT_BASE);
  const useBase = useCallback((v: string) => { baseRef.current = v; setBase(v); }, []);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const t = hash.get("t");
    const b = hash.get("b");
    if (t) token.current = t;
    if (b) useBase(b);
    // Out of the address bar before anything else can read it — including a screenshot.
    if (t || b) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  /**
   * ⛔ **WRITES ARE `POST`, NEVER `GET`, AND THAT IS THE API'S RULE RATHER THAN A STYLE.**
   *
   * A `GET` that publishes to a chain is reachable by prefetch, link preview and history replay —
   * three ways a message gets published that nobody chose. The server refuses `GET` on these
   * routes; this passes the method through so the page cannot drift from that.
   */
  const call = useCallback(
    async <T,>(
      path: string,
      init?: { method: "POST"; body?: unknown },
    ): Promise<{ ok: true; data: T } | { ok: false; err: Refusal }> => {
      try {
        const res = await fetch(`${baseRef.current.replace(/\/$/, "")}/v1/gui${path}`, {
          method: init?.method ?? "GET",
          headers: {
            ...(token.current ? { "x-hydra-token": token.current } : {}),
            ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: init?.body === undefined ? undefined : JSON.stringify(init.body),
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
    [],
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
      setSent(null);
      const m = await call<{ channel: string; messages: Message[]; howLinkable: HowLinkable }>(
        `/channels/${encodeURIComponent(name)}/messages`,
      );
      if (m.ok) {
        setMessages(m.data.messages);
        // Carried, not dropped. The figure and its caveat arrive together and are rendered together.
        setHowLinkable(m.data.howLinkable ?? null);
      } else setRefusal(m.err);
    },
    [call],
  );

  /**
   * One path for all three writes, because they fail in the same ways and a reader must be told
   * about them in the same words.
   *
   * ⛔ **`status` IS RE-READ AFTER EVERY WRITE.** A write moves `pending`, `invitesLeft` and
   * `queue.lastAttempt`, and a panel still showing the numbers from before the send is a panel
   * that says the upload is fine because it has not looked.
   */
  const write = useCallback(
    async <T,>(what: string, path: string, body?: unknown): Promise<T | null> => {
      setWorking(what);
      setBusy(null);
      setRefusal(null);
      const r = await call<T>(path, { method: "POST", body });
      setWorking(null);
      const s = await call<Status>("/status");
      if (s.ok) setStatus(s.data);
      if (r.ok) return r.data;
      // Not a failure: one write at a time is the design, and nothing was lost.
      if (r.err.code === "busy") setBusy(r.err);
      else setRefusal(r.err);
      return null;
    },
    [call],
  );

  /**
   * ⛔ **`signed` IS PASSED EXPLICITLY AND THERE IS NO DEFAULT IN THIS FUNCTION.**
   *
   * The caller is a button that names the act. `send` and `publish` are two verbs in the CLI and a
   * visible mode in the TUI for the same reason: a user who cannot tell which of the two they just
   * did has neither deniability nor attribution — they have whatever the default was.
   */
  const sendNow = useCallback(
    async (signed: boolean) => {
      if (!open || draft.trim() === "") return;
      const r = await write<Sent>("send", `/channels/${encodeURIComponent(open)}/send`, {
        text: draft,
        signed,
      });
      if (!r) return;
      setDraft("");
      setSent(r);
      // The message is in history now, and its `basis` — the claim about what the signature
      // settles — is generated upstream. Re-reading stored history is how the page shows it
      // without writing a claim of its own.
      const m = await call<{ messages: Message[]; howLinkable: HowLinkable }>(
        `/channels/${encodeURIComponent(open)}/messages`,
      );
      if (m.ok) {
        setMessages(m.data.messages);
        setHowLinkable(m.data.howLinkable ?? null);
      }
    },
    [open, draft, write, call],
  );

  /**
   * Fetch new messages. **This is the one that costs a chain scan and a vault batch**, which is why
   * it is a verb the reader presses rather than something the page does on a timer.
   */
  const readNow = useCallback(async () => {
    if (!open) return;
    const r = await write<{ messages: Message[]; howLinkable: HowLinkable }>(
      "read",
      `/channels/${encodeURIComponent(open)}/read`,
    );
    if (!r) return;
    setMessages(r.messages);
    // Recomputed AFTER the scan, not carried from before it: a read is the only thing that learns
    // who else was publishing, so this is the one response where the crowd can have just changed.
    setHowLinkable(r.howLinkable ?? null);
  }, [open, write]);

  /** Upload what is due. One object per flush — a set of one is not a set an operator can group. */
  const flushNow = useCallback(async () => {
    await write<{ uploaded: number; waiting: number }>("flush", "/flush");
  }, [write]);

  /**
   * Open a conversation from an address, with no file changing hands in either direction.
   *
   * ⛔ **THE COSTS ARE SHOWN AFTER, NOT BEFORE, AND THAT IS THE PRODUCT'S ORDER RATHER THAN A
   * CHOICE MADE HERE.** The CLI prints them after the bundle, the TUI's Connect page carries them
   * beside the result: they describe what the lookup just did — which node saw it, what the
   * signature settled, what a chain record cannot carry — so they are reporting rather than a
   * consent gate. `setOpened(null)` first, so a second attempt never shows the previous one's.
   */
  const lookupNow = useCallback(async () => {
    if (peerName.trim() === "" || peerAddress.trim() === "") return;
    setOpened(null);
    const r = await write<Opened>("lookup", "/lookup",
      { name: peerName.trim(), address: peerAddress.trim() });
    if (!r) return;
    setOpened(r);
    setFoldOpen(true);
    setPeerName("");
    setPeerAddress("");
    // The list is stale the moment this returns, and the new conversation is the one the reader
    // just asked for — so it is refetched and opened rather than left for them to find.
    const c = await call<{ channels: Channel[] }>("/channels");
    if (c.ok) setChannels(c.data.channels);
    await openChannel(r.channel);
  }, [peerName, peerAddress, write, call, openChannel]);

  /**
   * The other way in: a bundle from somebody with no published record.
   *
   * ⛔ **THE CONTENTS GO OVER THE WIRE, NEVER THE FILENAME.** Both terminal front ends take a path
   * because they run as the user from the user's own shell. A loopback HTTP route that did the
   * same would be an arbitrary local file read for whatever holds the token, so the API refuses a
   * path and this reads the file with the browser's own picker — which can only hand over a file
   * a person chose.
   */
  const inviteNow = useCallback(async () => {
    if (peerName.trim() === "" || peerBundle.trim() === "") return;
    setOpened(null);
    const r = await write<Opened>("invite", "/invite",
      { name: peerName.trim(), bundle: peerBundle });
    if (!r) return;
    setOpened(r);
    setFoldOpen(true);
    setPeerName("");
    setPeerBundle("");
    const c = await call<{ channels: Channel[] }>("/channels");
    if (c.ok) setChannels(c.data.channels);
    await openChannel(r.channel);
  }, [peerName, peerBundle, write, call, openChannel]);

  /**
   * Accept whatever is waiting in this client's vault mailbox.
   *
   * ⛔ **THIS COSTS A VAULT ROUND TRIP, so it is a verb the reader presses** — the same reason
   * `fetch new` is not on a timer. It takes no input at all: the slots are derived from this
   * client's own identity key, so there is nothing a caller could get wrong.
   */
  const collectNow = useCallback(async () => {
    setCollected(null);
    const r = await write<Collected>("collect", "/collect");
    if (!r) return;
    setCollected(r);
    const c = await call<{ channels: Channel[] }>("/channels");
    if (c.ok) setChannels(c.data.channels);
    // Opened only when exactly one arrived: with several, choosing one for the reader would hide
    // the others behind a thread they did not ask to be in.
    if (r.accepted.length === 1) await openChannel(r.accepted[0]!);
  }, [write, call, openChannel]);

  // Every route is stored-state-only — no network, no chain scan — so connecting on arrival costs
  // the reader nothing and saves them a click they would always make.
  useEffect(() => {
    // BOTH, not just the token. With no default there is nothing to dial without `b=`, and
    // connecting to the empty string produces a failure about an address nobody chose.
    if (token.current && baseRef.current) void connect();
    // Only on mount: re-running on `connect` identity would refetch on every base edit keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = !!status;

  return (
    <div className="tg">
      {/*
        ⛔ **THE CONNECTION LIVES IN THE HEADER AND IS THE SAME HEIGHT ALWAYS.**

        It used to be a second full-width bar under the chrome, which cost a row of vertical space
        on every screen to hold a field a reader touches once. The vitals sit beside it because
        they answer the same question — which machine is this, and can the page reach it.
      */}
      <header className="tg-top">
        <span className="tg-brand">HYDRA</span>

        {/*
          ⛔ **A `<details>`, NOT A CLICK-TO-RENDER PANEL.** `test/site.test.ts:854` reads the
          BUILT HTML and matches the legend's text, so markup that only exists after a click is
          markup that is not in the document — the build fails, correctly. A `<details>` keeps
          every word in the shipped page and merely folds it, which is the difference between
          hiding a disclosure and not shipping one.
        */}
        <details className="tg-help">
          <summary aria-label="What this page is and what the marks mean">?</summary>
          <div className="tg-help-body">
            {/*
              The detail behind the header's one-word states. The strip says `failing (7)`; this
              says which host did not answer, in the API's own sentence.
            */}
            <section>
              <h3>THIS MACHINE</h3>
              <StatusPanel status={status} />
            </section>
            <section>
              <h3>UPLOADS</h3>
              <UploadHealth queue={status?.queue} />
            </section>
            {disclosure}
          </div>
        </details>

        <form className="tg-connect" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
          <label htmlFor="base" className="prose-label">LOCAL API</label>
          {/*
            ⛔ **THE PLACEHOLDER SHOWS THE SHAPE AND NOT AN ADDRESS.** `127.0.0.1:PORT` rather
            than a number, because any number here is the wrong number: the port is chosen at bind
            time and differs every run. A placeholder that looked like a real address would be the
            default coming back wearing grey text, and a reader would type it in.
          */}
          <input id="base" name="base" type="text" value={base} spellCheck={false}
                 autoComplete="off" placeholder="http://127.0.0.1:PORT"
                 onChange={(e) => useBase(e.target.value)} />
          <button className="button" type="submit"
                  disabled={base.trim() === ""}>{live ? "Reconnect" : "Connect"}</button>
        </form>


        <dl className="tg-vitals">
          <Vital k="IDENTITY" v={status?.fingerprint} />
          <Vital k="ROUTE" v={status?.route} />
          <Vital k="INVITES" v={status ? String(status.invitesLeft) : undefined} />
          {/*
            ⛔ THE QUEUE KEEPS ITS THREE STATES IN THE COMPACT HEADER. Compressing a signal into a
            strip is where "no attempt yet" quietly becomes a blank that reads as "fine" — the
            defect this field was added to close, arriving back by a different route.
          */}
          <Vital k="UPLOADS" v={uploadsWord(status?.queue)} />
        </dl>
      </header>

      {/*
        ⛔ **AN EMPTY BOX WITH NO INSTRUCTION IS WORSE OFF THAN A WRONG DEFAULT**, which is the
        one real cost of removing it — so the empty state says what to do rather than waiting to
        be understood. Shown only before anything has been dialled: once a reader has connected,
        or has a failure to read, this is the row that would be in the way.

        It names the fragment because that is the path that needs no typing at all: `hydra gui`
        prints `#t=…&b=…`, and a reader who opens that link never meets this box.
      */}
      {!base && !live && !tried && (
        <p className="tg-connect-hint">
          paste the address <code>hydra gui</code> printed — it takes a free port, so it is a
          different one each run. Opening the <code>#t=…&amp;b=…</code> link it prints fills this
          in and connects for you.
        </p>
      )}

      <div className="tg-body">
        <aside className="tg-list">
          {/*
            ⛔ **OPEN BY DEFAULT WHEN THERE IS NOTHING IN THE LIST.** A reader with no
            conversations is exactly the person who needs this and the person with no row to click,
            so the way in is already unfolded for them; once there are conversations it folds, and
            the list is what the space is for. A `<details>` rather than a click-to-render panel
            for the reason the `?` gives: every word stays in the shipped document.
          */}
          <details
            className="tg-open"
            open={foldOpen ?? (!channels || channels.length === 0)}
            onToggle={(e) => setFoldOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>Open a conversation</summary>
            <form
              className="tg-open-form"
              onSubmit={(e) => { e.preventDefault(); void lookupNow(); }}
            >
              <label htmlFor="peer-name" className="prose-label">CALL IT</label>
              <input id="peer-name" name="peer-name" type="text" value={peerName}
                     spellCheck={false} autoComplete="off" placeholder="a name you choose"
                     onChange={(e) => setPeerName(e.target.value)} />
              <label htmlFor="peer-address" className="prose-label">THEIR ADDRESS</label>
              <input id="peer-address" name="peer-address" type="text" value={peerAddress}
                     spellCheck={false} autoComplete="off" placeholder="0x…"
                     onChange={(e) => setPeerAddress(e.target.value)} />
              <button className="button" type="submit"
                      disabled={working !== null || !live
                        || peerName.trim() === "" || peerAddress.trim() === ""}>
                {working === "lookup" ? "looking up…" : "Open from address"}
              </button>

              {/*
                ⛔ **THE SECOND WAY IN, FOR A PEER WHO HAS PUBLISHED NOTHING.** An address needs a
                record on chain; a bundle file needs no chain at all and no lookup, which is also
                why it discloses nothing to a node. The two share the name field because they are
                two routes to one act, and a second name box would read as two features.

                `accept` on the picker is a hint and not a check — the file is validated by the
                client that has to decode it, which is the only thing that can actually say.
              */}
              <label htmlFor="peer-bundle" className="prose-label">OR THEIR BUNDLE FILE</label>
              <input id="peer-bundle" name="peer-bundle" type="file" accept=".json,application/json"
                     onChange={(e) => {
                       const f = e.target.files?.[0];
                       if (!f) { setPeerBundle(""); return; }
                       // The page reads it; the API is sent the bytes. See `inviteNow`.
                       void f.text().then(setPeerBundle);
                     }} />
              <button className="button" type="button"
                      onClick={() => void inviteNow()}
                      disabled={working !== null || !live
                        || peerName.trim() === "" || peerBundle.trim() === ""}>
                {working === "invite" ? "opening…" : "Open from bundle"}
              </button>
            </form>
          </details>

          {/*
            ⛔ **OUTSIDE THE FOLD, AND THAT PLACEMENT IS THE FIX RATHER THAN A TIDY-UP.**

            It was inside, and the `<details>` closed itself the moment a lookup succeeded — so the
            three costs were rendered correctly, in order, word for word, and folded away in the
            same commit that produced them. A disclosure a reader never sees is not a disclosure,
            and "it was in the DOM" is the defence this product does not accept anywhere else.

            Nothing that can be collapsed may hold one. Out here it cannot be, whatever the fold
            above decides to do.
          */}
          {opened && <OpenedNote opened={opened} />}

          {/*
            ⛔ **THE RECEIVING SIDE, AND IT IS NOT INSIDE "OPEN A CONVERSATION".** Everything in
            that fold is an act of contacting somebody. This is the opposite one — answering
            somebody who contacted you — and folding it in with the others would have made the
            organisation's half of this product look like a variant of the source's. It is always
            visible for the same reason: a receiver arriving here has no row to click either.
          */}
          <div className="tg-mailbox">
            <button type="button" onClick={() => void collectNow()}
                    disabled={working !== null || !live}>
              {working === "collect" ? "checking…" : "Check mailbox"}
            </button>
            {collected && <CollectedNote collected={collected} />}
          </div>

          {channels && channels.length > 0 ? (
            <ul className="tg-rows">
              {channels.map((c) => (
                <li key={c.name}>
                  <button type="button" onClick={() => void openChannel(c.name)}
                          className={c.name === open ? "is-open" : undefined}>
                    <span className="tg-row-name">{c.name}</span>
                    {/*
                      A FINGERPRINT, NOT A KEY, and a count — which is what `/channels` actually
                      carries.

                      ⛔ **NO LAST-MESSAGE PREVIEW, AND THAT IS A DECISION RATHER THAN A MISSING
                      FIELD.** A messenger's list shows the last line of every conversation. The
                      payload has no such field and the API was deliberately not extended for one:
                      a preview puts the content of EVERY conversation on screen at once, so one
                      glance, one screenshot or one person behind the reader gets all of them
                      rather than the conversation that was opened on purpose. That is the case a
                      source using this is actually in.

                      Deriving one for the single open channel and leaving the other rows blank
                      was also declined — blank rows read as empty conversations, which is a false
                      statement about state made by a layout.

                      If it is ever added it belongs behind an opt-in that says what it costs.
                    */}
                    <span className="tg-row-peer">{c.peer.slice(0, 12)}</span>
                    <span className="tg-row-count">{c.messages}</span>
                    {c.removedUnderProcess > 0 && (
                      <span className="ch-removed">
                        {c.removedUnderProcess} removed under legal process
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="tg-rows">
              {[0, 1, 2].map((i) => (
                <li key={i}><span className="wire wire-row" /></li>
              ))}
            </ul>
          )}
        </aside>

        <section className="tg-thread">
          <header className="tg-thread-head">
            <h2>{open ?? "No conversation open"}</h2>
            <ThreadLinkability how={open ? howLinkable : null} />
            {open && (
              <span className="dash-acts">
                <button type="button" onClick={() => void readNow()} disabled={working !== null}>
                  {working === "read" ? "reading…" : "fetch new"}
                </button>
                <button type="button" onClick={() => void flushNow()} disabled={working !== null}>
                  {working === "flush" ? "uploading…" : "upload due"}
                </button>
              </span>
            )}
          </header>

          {/*
            ⛔ `data-basis-host` STAYS ON THE ELEMENT REAL MESSAGES RENDER IN. `figure-geometry.ts`
            injects the longest `basis` the product can produce and measures whether it clips; it
            has to inject where a message actually lives or it measures a width no message has.
            The previous redesign took this anchor away as a class and the gate certified nothing
            until somebody read the output — which is why it is an attribute now.
          */}
          <div className="tg-messages is-scroll" data-basis-host>
            {messages && messages.length > 0 ? (
              <ol className="session-messages">
                {messages.map((m) => (
                  <li key={m.id} className={m.mine ? "msg mine" : "msg"}>
                    <p className="msg-text">{m.text}</p>
                    {/*
                      ⛔ `basis` is TEXT, beside every message, always. Not a tooltip, not a
                      colour, not a class. The mark is an indicator and the basis is the claim,
                      and the two signed cases are told apart only by the basis.
                    */}
                    <p className="msg-basis">
                      <span className="msg-mark" aria-hidden>{m.mark}</span>
                      <span className="msg-basis-text">{m.basis}</span>
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <ol className="session-messages">
                {[0, 1].map((i) => (
                  <li key={i} className="msg">
                    <span className="wire wire-text" />
                    <span className="wire wire-basis" />
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* Pinned to the bottom of the thread, where every messenger puts it. */}
          <div className="tg-compose">
            {sent && <SentNote sent={sent} />}
            {busy && <BusyNote busy={busy} />}
            {refusal && <RefusalNote refusal={refusal} />}
            <Compose
              draft={draft}
              setDraft={setDraft}
              working={working}
              disabled={!open}
              onSend={(signed) => void sendNow(signed)}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The queue's three states as one word, for the header strip.
 *
 * ⛔ **`null` IS NOT SUCCESS AND ABSENT IS NOT SUCCESS.** Compressing this into a strip is exactly
 * where a three-valued signal turns back into a blank that reads as "fine" — and a blank reading
 * as fine is the defect `lastAttempt` was added to close. Every state gets a word; none gets
 * silence. The sentence behind each is in the `?` panel.
 */
function uploadsWord(queue: Status["queue"]): string | undefined {
  if (!queue) return undefined;                       // not connected: the strip shows a rule
  const a = queue.lastAttempt;
  if (a === undefined || a === null) return "none yet";
  return a.ok ? "ok" : `failing (${a.consecutiveFailures})`;
}

/**
 * Linkability in the thread header — the slot a messenger uses for "242 members, 112 online".
 *
 * ⛔ **THE WHOLE GENERATED TEXT, UNFOLDED, AND THE FOLD WAS TRIED FIRST.**
 *
 * `crowd` may never appear without `lines`, so the obvious port — figure in the header, caveat
 * behind a click — is exactly the shape that rule forbids: the reader who never clicks has been
 * shown the flattering half. The next attempt put the caveat in the summary and the figure behind
 * the fold, which fails safe but produced this in the header:
 *
 *     you are counted as people.
 *
 * **`lines` is WRAPPED OUTPUT, not a list of sentences.** `describe(...)` returns display lines,
 * so the last entry is the tail of a wrapped clause and any first-or-last choice yields a
 * fragment. Selecting one of them at all was the mistake; the array is prose that was broken for
 * a terminal, and a browser rewraps it.
 *
 * So it is all of it, joined back into prose, standing in the header. It costs two or three lines
 * of vertical space and that is the correct price: **this is the one thing this surface says that
 * an ordinary messenger would never say**, and matching a messenger's chrome must not be how it
 * gets lost. `known: false` is a third value and not a crowd of zero, and its text is short.
 *
 * Every word is generated. This component joins and renders; it writes nothing —
 * `no-invented-claims.test.ts` holds that no front end makes a privacy claim in its own words.
 */
function ThreadLinkability({ how }: { how: HowLinkable | null }) {
  if (!how) return null;
  return <p className="tg-link-flat">{how.lines.join(" ")}</p>;
}

/** One figure in the connection strip. Absent reads as a rule, never as a blank. */
function Vital({ k, v }: { k: string; v?: string }) {
  return (
    <div className="dash-vital">
      <dt className="prose-label">{k}</dt>
      <dd>{v ?? <span className="wire wire-value" />}</dd>
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

/**
 * ⛔ **`busy` IS A NOTICE, NOT A FAILURE, AND THE DISTINCTION IS NOT COSMETIC.**
 *
 * The client runs one write at a time and REFUSES a second rather than queueing it — a queue would
 * turn a slow publish into the burst the timing defence exists to prevent. And the resident flush
 * ticker takes that same lock every second, so a reader meets this without ever double-clicking:
 * it arrives during ordinary use, from an operation they did not start.
 *
 * Nothing was lost, so this does not clear the view and does not read as an error. The API's own
 * two sentences are still shown, because they are the ones that say so.
 */
function BusyNote({ busy }: { busy: Refusal }) {
  return (
    <div className="session-busy" role="status">
      <p className="msg-text">{busy.condition}</p>
      <p className="prose-body">{busy.remedy}</p>
    </div>
  );
}

/**
 * ⛔ **THE FIGURE AND ITS QUALIFICATION, OR NEITHER.**
 *
 * `lines` is `describe(...)` — the same array the CLI prints and the TUI renders, generated from
 * the same measurement. This component renders it and writes nothing of its own, because a page
 * that renders attribution or linkability is a front end, and `no-invented-claims.test.ts` holds
 * that no front end makes a privacy claim in its own words. Four hand-written claims have already
 * been false.
 *
 * **The count on its own is the reassuring half.** At the window this client reads, the rule that
 * discounts automated accounts almost never fires, so batchers and bots publishing alongside you
 * are counted as people — and `lines` is where that is said. Rendering `crowd` without `lines`
 * would show the flattering number and drop the sentence that qualifies it.
 *
 * `known: false` is a THIRD state. It means nothing has asked a node who else was publishing,
 * which is not a crowd of zero and is not a good answer either — so the number is not shown at
 * all in that case, and the lines say why.
 */
function LinkabilityNote({ how }: { how: HowLinkable | null }) {
  if (!how) return null;
  return (
    <div className="session-linkability">
      {how.known && (
        <p className="prose-label">
          crowd {how.crowd} · identified {Math.round(how.identified * 100)}%
        </p>
      )}
      {how.lines.map((line, i) => (
        <p className="prose-body" key={i}>{line}</p>
      ))}
    </div>
  );
}

/**
 * What a successful send actually promised, which is less than "sent".
 *
 * **A 200 here means the chain event is published and the upload is SCHEDULED**, not that it has
 * happened. `uploadAt` is when the object is due and `decoys` is how many cover objects go with
 * it — the message and its cover are uploaded on a schedule precisely so an operator cannot pick
 * the real one out by when it arrived. Showing the two is the honest answer to "why has it not
 * gone out yet", and it is why the queue panel above it matters.
 */
function SentNote({ sent }: { sent: Sent }) {
  return (
    <div className="session-sent" role="status">
      <p className="prose-body">
        Published to the chain{sent.signed ? ", signed" : ", deniable"}. The upload is due at{" "}
        {new Date(sent.uploadAt).toLocaleTimeString()} with {sent.decoys} decoys — it is scheduled
        rather than immediate, because a message that goes up the moment you send it is one an
        operator can match to the chain event beside it.
      </p>
    </div>
  );
}

/**
 * ⛔ **TWO BUTTONS, NO DEFAULT, AND NO STATE BETWEEN CHOOSING AND SENDING.**
 *
 * `signed` and deniable are two acts, not one act with a setting. The CLI makes them two verbs;
 * the TUI puts the mode on its model so it is visible before Enter. A checkbox here would have a
 * default, and a default is exactly what a user does not notice they accepted — *"a user who
 * cannot tell which of the two they just did has neither."*
 *
 * **The labels name the act and make no claim about it.** "Deniable" as a guarantee is a privacy
 * claim, and this file may not write one — the claim arrives on the message itself, as the
 * generated `basis` beside it, once the send returns. That is the same split the legend uses.
 */
/**
 * What a lookup just did, and the three things it cost.
 *
 * ⛔ **EVERY SENTENCE HERE COMES OFF THE WIRE.** The only words this component contributes are the
 * two labels; `w.full` is the generated claim text, rendered whole rather than summarised, because
 * the summary is where the hedge gets dropped. All three are shown — not the first, not the two
 * that flatter the product — and they are shown in the order the API sent them, which is the order
 * the other two front ends print.
 *
 * The fingerprint sits above them for the reason both other surfaces put it there: it is the only
 * thing that makes the channel mean anything, and it has to be checked by a route that is not this
 * one. Nothing on this page can do that, and it does not pretend otherwise.
 */
function OpenedNote({ opened }: { opened: Opened }) {
  return (
    <div className="tg-opened" role="status">
      <p className="tg-opened-head">
        <span className="tg-opened-name">{opened.channel}</span>
        <span className="tg-opened-fp">{opened.fingerprint}</span>
      </p>
      <ul className="tg-opened-costs">
        {opened.warnings.map((w) => (
          <li key={w.id}>
            {w.full.map((line, i) => (
              // Keyed by index because these are the lines of one paragraph, in order — there is
              // no identity to key on and reordering them would be the defect, not a re-render.
              <span key={i}>{line} </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What was waiting, in the three states the API distinguishes.
 *
 * ⛔ **"NOTHING WAS WAITING" AND "SOMETHING WAS WAITING AND WOULD NOT OPEN" ARE DIFFERENT
 * SENTENCES.** A slot is writable by anyone, so a rejection is ordinary rather than alarming — but
 * collapsing the two into one empty state tells a receiver nobody has tried to reach them when
 * somebody has. The count is reported plainly and is not dressed as an error.
 */
function CollectedNote({ collected }: { collected: Collected }) {
  const { accepted, rejected } = collected;
  return (
    <p className="tg-mailbox-note" role="status">
      {accepted.length > 0 && `accepted ${accepted.join(", ")}`}
      {accepted.length > 0 && rejected > 0 && " · "}
      {rejected > 0
        && `${rejected} slot(s) held something that did not open, and were discarded`}
      {accepted.length === 0 && rejected === 0 && "nothing waiting"}
    </p>
  );
}

function Compose({
  draft, setDraft, working, disabled, onSend,
}: {
  draft: string;
  setDraft: (v: string) => void;
  working: string | null;
  /** No channel open: the box is present so the layout does not jump, and it cannot be sent. */
  disabled: boolean;
  onSend: (signed: boolean) => void;
}) {
  const empty = draft.trim() === "" || disabled;
  return (
    <form className="session-compose" onSubmit={(e) => e.preventDefault()}>
      <label htmlFor="draft">
        <span className="label">MESSAGE</span>
        <textarea
          id="draft"
          name="draft"
          rows={2}
          value={draft}
          disabled={disabled}
          placeholder={disabled ? "Open a conversation first" : ""}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <div className="session-compose-acts">
        <button type="button" className="button" disabled={empty || working !== null}
                onClick={() => onSend(false)}>
          {working === "send" ? "Sending…" : "Send deniable"}
        </button>
        <button type="button" className="button" disabled={empty || working !== null}
                onClick={() => onSend(true)}>
          {working === "send" ? "Sending…" : "Send signed"}
        </button>
      </div>
    </form>
  );
}

function StatusPanel({ status }: { status: Status | null }) {
  const scanningWholeChain = !!status?.chain?.contract && status?.chain?.fromBlock === 0;
  /* The wireframe's rows: the same keys, with a bar where the value will be. */
  if (!status) {
    return (
      <>
        <dl className="session-status">
          {["IDENTITY", "STATE FILE", "AT REST", "VAULT", "NETWORK", "ROUTE", "INVITES LEFT",
            "PENDING UPLOAD"].map((k) => (
            <div className="session-row" key={k}>
              <dt className="label">{k}</dt>
              <dd><span className="wire wire-value" /></dd>
            </div>
          ))}
        </dl>
      </>
    );
  }
  return (
    <>
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
    </>
  );
}

/**
 * ⛔ **WHETHER UPLOADS ARE WORKING, WHICH `pending` ALONE CANNOT SAY.**
 *
 * A queue of 3 looks identical whether the vault is answering or has been dead for ten minutes —
 * every other field in `status` comes from the state file, and `nextUploadAt` sits in the past
 * either way. That is exactly what a reader watched before `lastAttempt` existed, while believing
 * their messages were going out.
 *
 * **Three states, because `null` is not success.** "No attempt yet" and "the last attempt worked"
 * are different facts, and a blank renders as the reassuring one. A queue that is not draining has
 * to LOOK different from one that is, not merely carry a field that says so.
 *
 * `problem` is the API's sentence, shown verbatim — the same words the CLI's `die()` and the TUI
 * print for the same dead vault. This page does not paraphrase it and does not write its own.
 */
function UploadHealth({ queue }: { queue: Status["queue"] }) {
  // No session yet. An empty pane reads as "nothing to report", which is the reassuring reading
  // of a state that has reported nothing — the same mistake `null` makes further down.
  if (!queue) {
    return <p className="dash-empty">Not connected, so nothing is known about uploads.</p>;
  }
  const a = queue.lastAttempt;
  if (a === undefined || a === null) {
    return (
      <p className="session-degraded">
        No upload has been attempted yet. That is not the same as one that succeeded — nothing here
        has been sent to the vault, so nothing has confirmed it is reachable.
      </p>
    );
  }
  if (a.ok) {
    return (
      <p className="prose-body">
        Last upload attempt succeeded at {new Date(a.at).toLocaleTimeString()}
        {a.uploaded > 0 ? `, ${a.uploaded} object${a.uploaded === 1 ? "" : "s"} uploaded` : ""}.
      </p>
    );
  }
  return (
    <div className="session-degraded" role="status">
      <p className="msg-text">
        {queue.pending > 0
          ? `${queue.pending} object${queue.pending === 1 ? " is" : "s are"} queued and the queue is not draining.`
          : "The last upload attempt failed."}{" "}
        {a.consecutiveFailures} attempt{a.consecutiveFailures === 1 ? "" : "s"} in a row have failed.
      </p>
      {/* The API's own sentence. Not paraphrased — three surfaces disagreeing about what went
          wrong is a defect this project has found repeatedly. */}
      {a.problem && <p className="prose-body">{a.problem}</p>}
    </div>
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
