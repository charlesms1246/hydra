/**
 * The client's operations, as functions rather than as a script.
 *
 * Separated from argument parsing so they can be driven by a test end to end without a node, a
 * terminal or a vault process. `cli-conversation.test.ts` runs a whole two-party conversation
 * through these against an in-memory chain — which is the only way the timing rules get checked
 * on the code people will actually run, rather than on a model of it.
 *
 * The operations that are NOT here are as deliberate as the ones that are. There is no
 * `upload` that takes an id, and no `publish` that skips the schedule: `session.send` does the
 * whole sequence for a reason, and a CLI that let a user do half of it would be the same hole
 * with a friendlier interface.
 */

import { randomBytes } from "node:crypto";

import { send as prepare, receive } from "../../client/src/session.ts";
import { readSet, select, MIN_READ_BATCH } from "../../client/src/read.ts";
import { initiate, respondWith } from "../../handshake/src/x3dh.ts";
import { createStore, mintOneTime, rotate, bundleFrom, oneTimeRemaining }
  from "../../handshake/src/prekeys.ts";
import { postPrekey, collectPrekeys, httpTransport } from "../../handshake/src/inbox.ts";
import type { Bundle, PrekeyMessage } from "../../handshake/src/x3dh.ts";
import { coverPlan, coverBody, coverId, coverIndex } from "../../channel/src/cover.ts";
import { jitterWindowMs } from "../../channel/src/schedule.ts";
import { feltToPointer } from "../../channel/src/note.ts";
import { openForChannel, plaintextOf, ENCRYPTED_ENDPOINT } from "../../vault-client/src/blobs.ts";
import { MAX_BODY } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import {
  derive, rootSeed, entropyFrom, fromOsRandom, fromStoredSeed, fromChannelWrap, subKey, expose,
  VAULT_DOMAIN,
} from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";
import type { Chain } from "./chain.ts";
import { STATE_FILE } from "./state.ts";
import type { State, ChannelState } from "./state.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

/** The vault root, rebuilt from the seed this client wrote down at `init`. */
export const vaultRootOf = (state: State): Secret<typeof VAULT_DOMAIN> =>
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromStoredSeed(unhex(state.seedHex), STATE_FILE))));

/**
 * The channel, rebuilt from the AGREED MATERIAL rather than from the derived key.
 *
 * Both sides run the identical `fromChannelWrap` derivation, so a change to it breaks both at
 * once instead of quietly giving two people two different channels. And the local name is
 * nowhere in it — an earlier version folded it in, which meant alice calling the channel "bob"
 * and bob calling it "alice" produced two different secrets and a conversation that could not
 * happen. A name a user picks must never reach a key.
 */
const channelOf = (state: State, name: string): Secret<typeof VAULT_DOMAIN> => {
  const c = state.channels[name];
  if (!c) throw new Error(`no channel called ${JSON.stringify(name)} — \`hydra open\` or \`hydra accept\` first`);
  return derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromChannelWrap(unhex(c.materialHex), c.peer))));
};

/**
 * A CHANNEL IS TWO KEYS, ONE PER DIRECTION, and it was one until a reply was tried.
 *
 * With a single key both ends derive cover from the same `coverBody(channel, bucket, index)` at
 * the same sequence numbers, so their decoys are byte-identical. Measured on a two-message
 * exchange: ten uploads, **six** objects in the vault, eight invites spent to buy four. Worse
 * than the waste — an id that arrives twice can only be cover, because that is the one object
 * two people independently mint, so a vault keeping its request log identifies every decoy with
 * certainty. That is the same 1.000 the unfetched-decoy defect scored, from the opposite end.
 *
 * And the sequence spaces collided: both parties counted from zero, so a transcript held two
 * messages at seq 0 with no way to order them and no way to say who wrote which.
 *
 * So the handshake's material yields two sub-keys, and your ROLE decides which you send under.
 * Everything downstream — the pointer pad, the blob id, the cover bodies, the read set — is
 * per-direction, and a decoy of yours can no longer equal a decoy of theirs.
 */
const DIRECTION = {
  initiator: "direction initiator-to-responder",
  responder: "direction responder-to-initiator",
} as const;

const opposite = (role: ChannelState["role"]) =>
  (role === "initiator" ? "responder" : "initiator") as ChannelState["role"];

const roleOf = (state: State, name: string): ChannelState["role"] => {
  const role = state.channels[name]?.role;
  // Refused rather than defaulted. A state file written before this change has no role, and
  // guessing one gives both ends the same direction — which is the exact bug, restored silently.
  if (!role) {
    throw new Error(
      `the channel ${JSON.stringify(name)} predates two-way messaging and has no role. Open it `
      + "again: a channel with no role cannot say which of its two keys is yours.");
  }
  return role;
};

/** The key this client SENDS under. */
const sending = (state: State, name: string): Secret<typeof VAULT_DOMAIN> =>
  subKey(channelOf(state, name), DIRECTION[roleOf(state, name)]);

/** The key the other end sends under, which is the one this client READS. */
const receiving = (state: State, name: string): Secret<typeof VAULT_DOMAIN> =>
  subKey(channelOf(state, name), DIRECTION[opposite(roleOf(state, name))]);

/**
 * Bundles and prekey messages on their way to a file, and back.
 *
 * They are transported as JSON with hex fields because they change hands out of band — a file
 * on a USB stick, a paste in another chat, a QR code — and every one of those routes wants
 * text. Here rather than in a front end: two front ends with two encoders is two formats, and a
 * bundle written by one that the other cannot read is a conversation that never starts.
 */
export const encodeWire = (v: unknown): string => JSON.stringify(v, (_, x) =>
  x instanceof Uint8Array ? Buffer.from(x).toString("hex") : x, 2);

/** The keys whose values are bytes. Anything not listed stays a string, including the epoch. */
const WIRE_BYTES = new Set([
  "identityKey", "signingKey", "signedPrekey", "signedPrekeySignature", "oneTimePrekey",
  "ephemeralKey", "wrapped",
]);

export const decodeWire = (text: string): any => JSON.parse(text, (k, v) =>
  WIRE_BYTES.has(k) && typeof v === "string" ? new Uint8Array(Buffer.from(v, "hex")) : v);

// ---------------------------------------------------------------------------
// Setup and identity
// ---------------------------------------------------------------------------

export function init(overrides: Partial<State> = {}): State {
  return {
    vaultUrl: "http://127.0.0.1:8080",
    rpcUrl: "http://127.0.0.1:5050",
    contract: "",
    fromBlock: 0,
    accountsFile: "",
    account: "",
    blockMs: 30_000,
    seedHex: hex(entropyFrom(fromOsRandom(32))),
    // Twenty one-time keys, so twenty strangers can open a conversation before replay
    // resistance degrades. Minting more is `hydra rotate`.
    prekeys: (() => { const s = createStore(); mintOneTime(s, 20); return s; })(),
    invites: [],
    channels: {},
    pending: [],
    ...overrides,
  };
}

/**
 * Everything a stranger needs to open a conversation with you while you are offline.
 *
 * The epoch comes from the store rather than the caller: publishing an epoch whose private you
 * have deleted would advertise a prekey you cannot answer.
 */
export function publishBundle(state: State, oneTimeIndex?: number): Bundle {
  return bundleFrom(vaultRootOf(state), state.prekeys, oneTimeIndex);
}

/** The next unused one-time prekey, or undefined once they run out. */
export const nextOneTime = (state: State): number | undefined => {
  const keys = Object.keys(state.prekeys.oneTime).map(Number).sort((a, b) => a - b);
  return keys[0];
};

/**
 * Rotate the signed prekey, destroying the old private.
 *
 * Returns what it made unanswerable: anyone who fetched the old bundle and has not yet had
 * their prekey message collected is now permanently unable to reach you on it. That is the
 * cost of forward secrecy and the client says it out loud rather than letting it look like a
 * delivery failure.
 */
export function rotatePrekey(state: State): { retired: number; oneTimeLeft: number } {
  const retired = rotate(state.prekeys);
  if (oneTimeRemaining(state.prekeys) < 5) mintOneTime(state.prekeys, 20);
  return { retired, oneTimeLeft: oneTimeRemaining(state.prekeys) };
}

/**
 * The fingerprint a user reads out loud.
 *
 * Over BOTH long-term keys. Fingerprinting the DH key alone would leave the signing key
 * unverified, and the signing key is what makes a swapped prekey detectable — so an attacker
 * who could substitute it would keep a matching fingerprint while controlling which prekeys the
 * victim's contacts accept.
 */
export const fingerprint = (bundle: Bundle): string =>
  hex(bundle.identityKey).slice(0, 16) + hex(bundle.signingKey).slice(0, 16);

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

const remember = (
  state: State, name: string, material: Uint8Array, peer: string, role: ChannelState["role"],
): void => {
  const entry: ChannelState = { materialHex: hex(material), peer, role, nextSeq: 0 };
  state.channels[name] = entry;
};

/** Alice's side. Produces the prekey message, which has to reach the other person somehow. */
export function open(state: State, name: string, bundle: Bundle): PrekeyMessage {
  if (state.channels[name]) throw new Error(`${name} already exists — pick another name`);
  const result = initiate(vaultRootOf(state), bundle);
  remember(state, name, result.material, fingerprint(bundle), "initiator");
  return result.message;
}

/**
 * Open a channel AND deliver the prekey message, so a conversation starts without a file
 * changing hands.
 *
 * The delivery costs a disclosure and it is not a small one: the mailbox slots are a public
 * function of the recipient's identity key, so the vault operator can see that this person is
 * reachable and count what is waiting for them. `observations.ts` `DERIVABLE` carries the rows
 * and `inbox-derivations.test.ts` performs the derivation. There is no version of this without
 * accounts, and accounts would disclose more.
 */
export async function openAndSend(
  state: State,
  name: string,
  bundle: Bundle,
  fetchImpl: typeof fetch = fetch,
): Promise<{ slot: number }> {
  const message = open(state, name, bundle);
  const transport = httpTransport(state.vaultUrl, state.invites, fetchImpl);
  try {
    return { slot: await postPrekey(transport, bundle.identityKey, message) };
  } catch (e) {
    // The channel was remembered before the post; undo it, or the caller holds a channel the
    // other side will never know about and every message into it vanishes.
    delete state.channels[name];
    throw e;
  }
}

/**
 * Collect every pending handshake and accept the ones that open.
 *
 * A slot is writable by anyone, so a message that fails to open is expected rather than
 * exceptional — it is reported and skipped. Naming is the caller's problem: channels are named
 * after the sender's fingerprint, because at this point that is genuinely all we know about
 * them, and inventing a friendlier name would be inventing a claim about who they are.
 */
export async function collect(
  state: State,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accepted: string[]; rejected: number }> {
  const transport = httpTransport(state.vaultUrl, state.invites, fetchImpl);
  const waiting = await collectPrekeys(transport, publishBundle(state).identityKey);
  const accepted: string[] = [];
  let rejected = 0;
  for (const { message } of waiting) {
    const name = `from-${hex(message.identityKey).slice(0, 12)}`;
    if (state.channels[name]) continue;
    try {
      accept(state, name, message);
      accepted.push(name);
    } catch {
      rejected++;
    }
  }
  return { accepted, rejected };
}

/** Bob's side. */
export function accept(state: State, name: string, message: PrekeyMessage): { usedOneTimePrekey: boolean } {
  if (state.channels[name]) throw new Error(`${name} already exists — pick another name`);
  const result = respondWith(vaultRootOf(state), state.prekeys, message);
  remember(state, name, result.material, hex(message.identityKey).slice(0, 32), "responder");
  return { usedOneTimePrekey: result.agreed.usedOneTimePrekey };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * The nullifier a message commits under.
 *
 * Per DIRECTION rather than per channel, so the two ends of a conversation no longer commit
 * under one value. `commitment.ts` describes it as binding the commitment to an identity without
 * naming it, and one nullifier for two people binds it to neither.
 *
 * THE RESIDUAL, and it is not small: this is derived from material BOTH ends hold, so it binds
 * authorship against everyone except the person you are talking to. Your counterparty can
 * compute your direction key and therefore your nullifier, and forge a message as you. Closing
 * that needs a per-party secret the other end never learns — the sender's own vault root, with
 * the recipient holding only a public commitment to it — which changes what Phase 5's proof is
 * about. Written down rather than fixed here. See `decisions/0023-two-way-channels.md`.
 */
const nullifierFor = (state: State, name: string): bigint =>
  BigInt(`0x${hex(expose(sending(state, name), VAULT_DOMAIN)).slice(0, 16)}`);

/**
 * Publish a message's pointer now and QUEUE its upload for later.
 *
 * The gap is the defence. `channel/src/schedule.ts` puts the upload uniformly inside a window
 * of at least eight block intervals after the chain event, and an upload that happened here
 * would sit moments after its own event in the vault operator's log — which is the correlation
 * the pointer masking exists to prevent. So this returns having done half the job on purpose,
 * and `flush` does the rest.
 *
 * Cover is queued at the same time and from the same message, so the decoys land in the same
 * size bucket. A decoy in the wrong bucket does not cover anything: measured, a message alone
 * in its bucket is identified 1.000 of the time.
 */
export async function sendMessage(
  state: State,
  chain: Chain,
  name: string,
  text: string,
  now: number = Date.now(),
  random?: () => number,
): Promise<{ txHash: string; uploadAt: number; decoys: number }> {
  const channel = sending(state, name);
  const entry = state.channels[name];
  const seq = entry.nextSeq;
  const config = { channel, nullifier: nullifierFor(state, name), blockMs: state.blockMs };
  const outgoing = prepare(config, new TextEncoder().encode(text), seq, now, random);

  const txHash = await chain.publish(outgoing.calldata);
  entry.nextSeq = seq + 1;

  state.pending.push({
    channel: name, id: outgoing.blobId,
    bodyB64: Buffer.from(outgoing.body).toString("base64"),
    uploadAt: outgoing.uploadAt, real: true,
  });

  const decoys = coverPlan([{ at: now, bucket: outgoing.body.length }], config, random);
  const draw = random ?? Math.random;
  for (const d of decoys) {
    // Global index, from the message's sequence — `coverPlan` numbers within its own call and
    // this client calls it once per message. The recipient derives the same number from the
    // sequence it read off the chain.
    const body = coverBody(channel, d.bucket, coverIndex(seq, d.index));
    state.pending.push({
      channel: name, id: coverId(body),
      bodyB64: Buffer.from(body).toString("base64"),
      // A DECOY WHOSE SLOT HAS ALREADY PASSED GETS A NEW ONE, and this is not tidiness.
      //
      // `coverPlan` schedules half of a message's cover BEFORE that message's own chain event,
      // which is what makes a decoy indistinguishable from the real upload by distance from the
      // event. No client can execute that: it learns the message exists when the user sends it,
      // and the slot is already in the past. Leaving `d.at` there means every past-due decoy is
      // due at once, so they all go up at the same instant — and `adversary/src/matchers.ts`
      // `after-the-burst` reads that straight off: discard the crowd, and what went up alone is
      // the message. Measured at **0.347** against a resident client, versus 0.240 for the
      // schedule as written — honouring the schedule promptly was half again as bad as the
      // schedule itself.
      //
      // So it is redrawn from the window the MESSAGE's own upload is drawn from. The lead is
      // gone — it was never executable — and what replaces it is cover drawn from the same
      // distribution as the thing it covers. What that buys is the anonymity set the rate was
      // always supposed to give: every decoy now lands in its own message's window, so the set
      // is exactly `coverRate + 1` and the operator is right **one time in five** — the floor
      // `claims/src/statement.ts` publishes, achieved by a client rather than by a plan.
      // `adversary/test/resident-flush.test.ts` measures it.
      uploadAt: d.at < now ? now + draw() * jitterWindowMs(config) : d.at,
      real: false,
    });
  }
  return { txHash, uploadAt: outgoing.uploadAt, decoys: decoys.length };
}

/**
 * Upload everything that is due, and nothing that is not.
 *
 * Real messages and decoys go through the identical path, because a decoy that took a different
 * route would be separable by that route rather than by its contents.
 */
export async function flush(
  state: State,
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ uploaded: number; waiting: number }> {
  // Sorted by scheduled time, not queue order. Cover for a message is scheduled to START
  // BEFORE that message's own chain event — `coverLeadMs` equals the jitter window, and that
  // equality is what makes a decoy indistinguishable from the real upload by distance from the
  // event. Uploading in the order they were queued would put the real one first every time and
  // hand the operator the answer.
  //
  // AND THE HONEST LIMIT: a client only learns a message exists when the user sends it, so a
  // decoy whose scheduled time is already past goes up at the next flush, not in the past. The
  // ordering survives; the wall-clock lead does not. That makes the defence depend on flush
  // cadence — a client that flushes once an hour uploads a message and all its cover in one
  // burst, and a burst is a message. `claude-docs/decisions/0011-cli-client.md` says so, and
  // it is why a real client wants a resident process rather than a command.
  const due = state.pending.filter((p) => p.uploadAt <= now).sort((a, b) => a.uploadAt - b.uploadAt);
  // Checked before anything is sent. Uploading half a batch and then running out would leave
  // real messages in the vault with their cover still queued, which is worse than not starting.
  if (state.invites.length < due.length) {
    throw new Error(
      `${due.length} objects are due and there are ${state.invites.length} invites — cover spends `
      + "them too, at the cover rate per message. Get more before flushing.");
  }
  const uploaded: string[] = [];
  for (const p of due) {
    const res = await fetchImpl(`${state.vaultUrl}${ENCRYPTED_ENDPOINT}/${p.id}`, {
      method: "PUT",
      headers: { "x-hydra-invite": state.invites[0] },
      body: new Uint8Array(Buffer.from(p.bodyB64, "base64")),
    });
    if (res.status === 429) {
      throw new Error(
        "the vault is rate limiting this client. cover multiplies a client's request rate by "
        + "the cover rate plus one, so a vault tuned for bare messages refuses the clients "
        + "doing the timing defence correctly. nothing was lost — run `hydra flush` again.");
    }
    if (!res.ok) throw new Error(`the vault refused ${p.id.slice(0, 12)}…: ${await res.text()}`);
    state.invites.shift();
    uploaded.push(p.id);
  }
  const done = new Set(uploaded);
  state.pending = state.pending.filter((p) => !done.has(p.id));
  return { uploaded: due.length, waiting: state.pending.length };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read a channel: every event on chain, every plausible sequence number, one batched fetch, in
 * BOTH directions.
 *
 * THE COST OF UNLINKABILITY IS QUADRATIC, and it is worth naming rather than hiding. A pointer
 * carries no channel and no sequence — that is the whole point, and `i3-timeline-join.test.ts`
 * is about it — so a reader cannot tell which events are theirs. `recoverBlobId` is an
 * unmasking, not a test: it returns a plausible id for any pointer and any seq. So the reader
 * computes a candidate id for every (event, seq, direction) triple and asks the vault for all of
 * them; the ones that exist and then open under one of the two channel keys are the messages.
 *
 * That is `events × seq × 2` ids for one conversation. A channel hint in the event would collapse
 * it to linear and would be exactly the linkage the design refuses, so the cost is the feature.
 * What makes it affordable in practice is that the candidate set is ALSO the padded read batch
 * `read.target` requires — the work and the defence are the same work.
 */
export type Received = {
  readonly seq: number;
  readonly text: string;
  /** True for messages this client sent. A transcript that cannot say who spoke is not one. */
  readonly mine: boolean;
  /** The index of the chain event that carried it — the one ordering both ends agree on. */
  readonly at: number;
};

export async function readChannel(
  state: State,
  chain: Chain,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Received[]> {
  const mine = sending(state, name);
  const theirs = receiving(state, name);
  const events = await chain.events();
  const seqs = Array.from({ length: Math.max(events.length, MIN_READ_BATCH) }, (_, i) => i);

  const candidates = events.flatMap((e, at) =>
    seqs.map((seq) => ({ seq, at, pointer: feltToPointer(e.data[0]) })));

  // Both directions, because a conversation is two of them and the ids do not overlap. It
  // doubles the batch, which is the read defence paying for itself: the padding a lone reader
  // would have had to invent is now other people's real traffic.
  const ids = [...new Set([...readSet(mine, candidates), ...readSet(theirs, candidates)])];

  const found = new Map<string, { seq: number; at: number; mine: boolean }>();
  for (const c of candidates) {
    found.set(receive(mine, c.pointer, c.seq), { seq: c.seq, at: c.at, mine: true });
    found.set(receive(theirs, c.pointer, c.seq), { seq: c.seq, at: c.at, mine: false });
  }

  const body = JSON.stringify(ids);
  // Checked here so the failure names its own cause. The vault answers "body too large", which
  // is true and unhelpful: what actually happened is that a channel grew until its candidate
  // set times its decoy set times its two directions stopped fitting in one request.
  if (body.length > MAX_BODY) {
    throw new Error(
      `this channel now needs ${ids.length} ids in one read (${Math.round(body.length / 1024)} KiB), `
      + `and the vault accepts ${Math.round(MAX_BODY / 1024)} KiB. Reading is quadratic in the `
      + "number of chain events because a pointer names no channel; a client that keeps up with "
      + "a conversation rather than replaying it from block zero does not hit this.");
  }
  const res = await fetchImpl(`${state.vaultUrl}${ENCRYPTED_ENDPOINT}`, {
    method: "POST", body,
  });
  if (!res.ok) throw new Error(`the vault refused the read: ${await res.text()}`);
  const { found: blobs } = await res.json() as { found: Record<string, string> };

  const out: Received[] = [];
  for (const [id, b64] of Object.entries(blobs)) {
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    const where = found.get(id);
    if (!where) continue;
    try {
      // A decoy or another channel's blob fails here, which is what GCM's tag is for. Silence
      // is correct: a reader that reported them would be reporting on traffic it cannot read.
      const channel = where.mine ? mine : theirs;
      out.push({
        seq: where.seq,
        at: where.at,
        mine: where.mine,
        text: new TextDecoder().decode(plaintextOf(openForChannel(channel, bytes))),
      });
    } catch { /* not ours */ }
  }
  // Ordered by the chain, not by sequence number: each direction counts from zero, so sequence
  // alone interleaves two conversations wrongly. The event order is the one both ends see.
  return out.sort((a, b) => a.at - b.at || Number(a.mine) - Number(b.mine) || a.seq - b.seq);
}

/** Pad a batch that is somehow short. Exported so the test can assert the floor is respected. */
export const readBatchFloor = MIN_READ_BATCH;
export { randomBytes as _randomBytes, select, BUCKETS };
