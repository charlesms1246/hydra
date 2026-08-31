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
import { newChain, keyFor, packChain, forgetOldSkipped } from "../../handshake/src/ratchet.ts";
import { signedBy, ephemeral, unframe, verifyAuthorship } from "../../handshake/src/authorship.ts";
import { commit, contentHashFor } from "../../channel/src/commitment.ts";
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
import { STATE_FILE as WHERE } from "./state.ts";
import type { Secret } from "../../identity/src/domains.ts";
import type { Chain } from "./chain.ts";
import { STATE_FILE } from "./state.ts";
import type { State, ChannelState, ReceivedMessage } from "./state.ts";

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
 * These are the ADDRESSING keys only — pointer pads, blob ids, cover bodies, read sets. What
 * seals a message is a ratchet key that is used once and destroyed (`handshake/src/ratchet.ts`).
 */
const DIRECTION = {
  initiator: "direction initiator-to-responder",
  responder: "direction responder-to-initiator",
} as const;

const opposite = (role: ChannelState["role"]) =>
  (role === "initiator" ? "responder" : "initiator") as ChannelState["role"];

const channelKey = (hexKey: string): Secret<typeof VAULT_DOMAIN> =>
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromStoredSeed(unhex(hexKey), STATE_FILE))));

const channelAt = (state: State, name: string): ChannelState => {
  const c = state.channels[name];
  if (!c) throw new Error(`no channel called ${JSON.stringify(name)} — \`hydra open\` or \`hydra accept\` first`);
  // Refused rather than migrated. A state file written before the ratchet holds the agreed
  // material and no chains, and inventing chains from it would silently produce a channel whose
  // keys the other end does not have. Nothing here can repair that; only a new handshake can.
  if (!c.addressSendHex || !c.send) {
    throw new Error(
      `the channel ${JSON.stringify(name)} predates the message ratchet and cannot be migrated: `
      + "its keys were derivable from material this client no longer keeps. Open it again.");
  }
  return c;
};

/** The addressing key this client SENDS under. */
const sending = (state: State, name: string): Secret<typeof VAULT_DOMAIN> =>
  channelKey(channelAt(state, name).addressSendHex);

/** The addressing key the other end sends under, which is the one this client READS. */
const receiving = (state: State, name: string): Secret<typeof VAULT_DOMAIN> =>
  channelKey(channelAt(state, name).addressRecvHex);

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

/**
 * Turn the agreed material into what a channel is actually made of, and then let it go.
 *
 * Four keys and no material. Both ends run the identical derivation from the identical bytes, so
 * a change here breaks both at once rather than quietly giving two people two different channels.
 * The local name is nowhere in it — an earlier version folded it in, which meant alice calling
 * the channel "bob" and bob calling it "alice" produced two different secrets and a conversation
 * that could not happen. A name a user picks must never reach a key.
 *
 * The material is not stored, and that is the whole of the forward secrecy. Keeping it would
 * regenerate every chain key and therefore every message key this client ever used.
 */
const remember = (
  state: State, name: string, material: Uint8Array, peer: string, role: ChannelState["role"],
  peerSigningKey: Uint8Array,
): void => {
  const agreed = derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromChannelWrap(material, peer))));
  const mine = subKey(agreed, DIRECTION[role]);
  const theirs = subKey(agreed, DIRECTION[opposite(role)]);
  state.channels[name] = {
    peer, role,
    peerSigningKeyHex: hex(peerSigningKey),
    addressSendHex: hex(expose(subKey(mine, "addressing"), VAULT_DOMAIN)),
    addressRecvHex: hex(expose(subKey(theirs, "addressing"), VAULT_DOMAIN)),
    send: newChain(subKey(mine, "content chain")),
    recv: newChain(subKey(theirs, "content chain")),
    nextSeq: 0, readTo: 0, history: [], foreignSeen: 0, refusedSeen: 0,
  };
};

/** Alice's side. Produces the prekey message, which has to reach the other person somehow. */
export function open(state: State, name: string, bundle: Bundle): PrekeyMessage {
  if (state.channels[name]) throw new Error(`${name} already exists — pick another name`);
  const result = initiate(vaultRootOf(state), bundle);
  remember(state, name, result.material, fingerprint(bundle), "initiator", bundle.signingKey);
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
  remember(state, name, result.material, hex(message.identityKey).slice(0, 32), "responder",
    result.peerSigningKey);
  return { usedOneTimePrekey: result.agreed.usedOneTimePrekey };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

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
  /**
   * Signed or deniable, and there is no default.
   *
   * `signed` carries an Ed25519 signature over the on-chain commitment under this author's own
   * key — verifiable by anyone holding their bundle, forgeable by nobody, including the person
   * they are talking to. `ephemeral` carries none, so either participant could have produced the
   * message and a transcript proves nothing about which. Both are legitimate; neither is a
   * default, because a default is how a product ends up with deniability nobody chose or
   * attribution nobody can check.
   *
   * Before the text, so the kind qualifies the act at every call site rather than trailing it.
   */
  attribution: "signed" | "ephemeral",
  text: string,
  now: number = Date.now(),
  random?: () => number,
): Promise<{ txHash: string; uploadAt: number; decoys: number }> {
  const channel = sending(state, name);
  const entry = channelAt(state, name);
  const seq = entry.nextSeq;
  // The key for this sequence, taken out of the sending chain, which advances and destroys the
  // one before it. A message this client has sent cannot be sealed again.
  const content = keyFor(entry.send, seq, WHERE);
  if (!content) throw new Error(`the sending chain is past sequence ${seq} — this is a bug`);
  const config = {
    channel,
    content,
    author: attribution === "signed" ? signedBy(vaultRootOf(state)) : ephemeral(),
    blockMs: state.blockMs,
  };
  const outgoing = prepare(config, new TextEncoder().encode(text), seq, now, random);

  const txHash = await chain.publish(outgoing.calldata);
  entry.nextSeq = seq + 1;
  // Recorded here rather than read back later: a client already knows what it sent, and asking
  // the vault for its own words costs a whole direction's worth of candidate ids for something
  // it has in hand. The event index is read back from the chain so it matches what the reader
  // will compute — `readChannel` orders by it, and each direction counts sequences from zero.
  entry.history.push({
    id: outgoing.blobId, seq, text, mine: true, at: (await chain.events()).length - 1,
    attribution: attribution === "signed" ? "signed" : "unverifiable",
  });

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
 * Read a channel: what is new since last time, merged into what is already known.
 *
 * THE COST OF UNLINKABILITY IS QUADRATIC, and that is the feature. A pointer carries no channel
 * and no sequence number — `i3-timeline-join.test.ts` is about exactly that — so a reader cannot
 * tell which chain events are theirs. `recoverBlobId` is an unmasking, not a test: it returns a
 * plausible id for any pointer and any sequence. So the reader computes a candidate id per
 * (event, sequence, direction) triple and asks for all of them at once, and the ones that exist
 * and then open are the messages. That batch is ALSO the padded read the `read.target` guarantee
 * requires, so the work and the defence are the same work.
 *
 * REPLAYING THE WHOLE CHAIN EVERY TIME IS NOT THE FEATURE, and it killed conversations. Measured
 * before this changed: at 35 messages the client asked for 4800 ids in a 323 KiB request against
 * a vault that accepts 257 KiB, and every read after that failed. The product had a message
 * limit and nobody had counted it.
 *
 * So three things bound the work, and none of them is the length of the conversation:
 *
 *   - **events**: only those after `readTo`, plus a fixed tail. The tail is not optional — an
 *     upload is scheduled up to eight block intervals AFTER its own chain event, so an event
 *     seen on one read may have nothing behind it until the next.
 *   - **sequences**: only the ones not already in `history`. A sequence already opened is a
 *     sequence there is no reason to ask about again.
 *   - **directions**: still both, so that a second client running on this identity is visible
 *     (`foreignSends`). Our own messages are recorded at send time, so this is a cross-check
 *     rather than the source of the transcript.
 */
export type Received = ReceivedMessage;

/**
 * How many events back to look again on every read.
 *
 * Because an upload lands after its event by design. Too small and a message is missed until
 * something else provokes a read; too large and every read pays for the whole tail. Sixteen is
 * two jitter windows' worth of this channel's own events and it is a guess — the honest fix
 * would re-scan by BLOCK NUMBER, which needs the chain interface to return one.
 */
export const RESCAN_EVENTS = 16;

/** How many message keys to hold for blobs that have not arrived. See `ratchet.ts`. */
export const SKIPPED_KEEP = 64;

/**
 * Ask the vault for a set of ids, in as many requests as it takes.
 *
 * One request was the design and it has a hard limit: the vault accepts 257 KiB and an incremental
 * read still exceeds it when a client is CATCHING UP. A client that has been offline for a
 * hundred events asks about all hundred at once, and the request is refused — so "do not read for
 * a while" was a way to lose a conversation permanently, which is worse than the ceiling this
 * replaced.
 *
 * WHAT SPLITTING COSTS. The operator sees several read batches where it saw one. Each is still at
 * least `MIN_READ_BATCH` wide and each still holds a channel's candidate set, so the disclosure
 * is the one already published as `read.channelSet` — a batch is a channel — arriving in pieces
 * rather than a new one. What it does add is a count: several batches back to back say "this
 * client has been away", which a single batch did not.
 */
async function fetchIds(
  state: State,
  ids: readonly string[],
  fetchImpl: typeof fetch,
): Promise<Record<string, string>> {
  // Sized by the encoded length rather than by a count, because that is what the vault limits.
  // A margin, since JSON adds punctuation this does not model exactly.
  const perId = ids.length ? JSON.stringify(ids).length / ids.length : 1;
  const chunk = Math.max(MIN_READ_BATCH, Math.floor((MAX_BODY * 0.9) / perId));
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += chunk) {
    const res = await fetchImpl(`${state.vaultUrl}${ENCRYPTED_ENDPOINT}`, {
      method: "POST", body: JSON.stringify(ids.slice(i, i + chunk)),
    });
    if (!res.ok) throw new Error(`the vault refused the read: ${await res.text()}`);
    Object.assign(out, (await res.json() as { found: Record<string, string> }).found);
  }
  return out;
}

export async function readChannel(
  state: State,
  chain: Chain,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Received[]> {
  const entry = state.channels[name];
  const mine = sending(state, name);
  const theirs = receiving(state, name);
  const events = await chain.events();

  const from = Math.max(0, entry.readTo - RESCAN_EVENTS);
  const fresh = events.slice(from);

  /**
   * The sequence numbers still worth asking about, per direction.
   *
   * Bounded by the BACKLOG, not by a constant, and that distinction cost a silent data loss. The
   * first version added a fixed sixteen to the highest sequence already known, which is right for
   * a client that keeps up and wrong for one catching up: across a hundred unread events the
   * other end may have sent a hundred messages, and the sequences past the bound were never asked
   * for and never asked for again, because `readTo` had moved past their events. Measured: a
   * hundred messages sent, **seventy-four** read, no error anywhere.
   *
   * One event can carry at most one message, so the number of fresh events IS the bound on how
   * many either end can have sent since the last read. Catching up is therefore expensive and
   * keeping up is cheap, which is the right way round.
   */
  const wanted = (isMine: boolean): number[] => {
    const known = new Set(entry.history.filter((h) => h.mine === isMine).map((h) => h.seq));
    const top = Math.max(MIN_READ_BATCH, ...[...known].map((n) => n + 1)) + fresh.length;
    // THEIR direction: only what is missing. A sequence already opened is one there is no reason
    // to ask about again, and this is what keeps a steady-state read flat.
    if (!isMine) return Array.from({ length: top }, (_, i) => i).filter((n) => !known.has(n));

    // OUR direction: a window around where this client is, INCLUDING sequences it already holds.
    // That is the whole of the second-client check (`foreignSends`) — another client on the same
    // identity sends at sequences you have used, so "already known" and "already asked" are
    // different questions. It is a window rather than the whole history because asking about
    // every past sequence on every read makes the batch grow with the conversation again.
    //
    // WHAT THE WINDOW MISSES, said plainly: a second client that forked long ago and has sent
    // many more messages than this one has drifted outside it and will not be noticed. Both
    // clients start from one state file and count up, so in practice they stay close; a client
    // that has been used heavily on one device and lightly on another is the case that escapes.
    const low = Math.max(0, entry.nextSeq - RESCAN_EVENTS);
    return Array.from({ length: top - low }, (_, i) => low + i);
  };

  // `data[1]` is the commitment the author put on chain. It is carried through so a signature
  // can be checked against the value that was PUBLISHED rather than against one recomputed from
  // the body alone — a signature over bytes proves less than a signature over a chain event.
  const build = (isMine: boolean) =>
    fresh.flatMap((e, i) =>
      wanted(isMine).map((seq) => ({
        seq, at: from + i, pointer: feltToPointer(e.data[0]), commitment: e.data[1],
      })));

  const forMine = build(true);
  const forTheirs = build(false);
  const ids = [...new Set([...readSet(mine, forMine), ...readSet(theirs, forTheirs)])];

  const where = new Map<string, {
    seq: number; at: number; mine: boolean; commitment: bigint;
  }>();
  for (const c of forMine) where.set(receive(mine, c.pointer, c.seq), { ...c, mine: true });
  for (const c of forTheirs) where.set(receive(theirs, c.pointer, c.seq), { ...c, mine: false });

  const found = await fetchIds(state, ids, fetchImpl);

  const seen = new Set(entry.history.map((h) => h.id));
  for (const [id, b64] of Object.entries(found)) {
    const at = where.get(id);
    if (!at || seen.has(id)) continue;
    try {
      // A decoy or another channel's blob fails here, which is what GCM's tag is for. Silence is
      // correct: a reader that reported them would be reporting on traffic it cannot read.
      // Their chain for their messages. Our own are already in `history` from send time, so a
      // hit on our own direction with an id we do not hold is a second client on this identity.
      // It is COUNTED, not opened: its key came out of a sending chain on another device and
      // this one destroyed its own copy the moment it stepped past that sequence.
      if (at.mine) {
        entry.foreignSeen++;
        continue;
      }
      const content = keyFor(entry.recv, at.seq, WHERE);
      if (!content) continue;
      const opened = unframe(
        plaintextOf(openForChannel(content, new Uint8Array(Buffer.from(b64, "base64")))));

      // THREE LINKS, and a message that breaks any of them is refused rather than shown.
      //
      //   1. the body commits to what the chain says was published — recompute and compare;
      //   2. the signature, if there is one, is over that same published value;
      //   3. it verifies under the key this channel's handshake bound to the other end.
      //
      // Without link one a signature proves the author signed SOMETHING; without link three it
      // proves somebody signed it. Together they say: this author, this content, this event.
      if (commit(opened.blind, contentHashFor(opened.plaintext)) !== at.commitment) {
        entry.refusedSeen++;
        continue;
      }
      const attribution = opened.signature
        && verifyAuthorship(unhex(entry.peerSigningKeyHex), at.commitment, opened.signature)
        ? "signed" as const
        : "unverifiable" as const;
      // A signature that is PRESENT and does not verify is not the same as no signature. It
      // means somebody tried, so it is refused outright rather than quietly downgraded to
      // deniable content — a forgery displayed as an ordinary message is the failure I7 exists
      // to prevent, and silently relabelling it would be this client committing that failure.
      if (opened.signature && attribution !== "signed") {
        entry.refusedSeen++;
        continue;
      }

      entry.history.push({
        id, seq: at.seq, text: new TextDecoder().decode(opened.plaintext),
        mine: false, at: at.at, attribution,
      });
      seen.add(id);
    } catch { /* not ours */ }
  }
  entry.readTo = events.length;
  // A kept message key is a key not deleted, so the set of them is bounded. The recent ones are
  // the ones worth keeping: a blob more than this many sequences late is a blob that is not
  // coming, and holding its key forever would leak forward secrecy back one message at a time.
  forgetOldSkipped(entry.recv, SKIPPED_KEEP);

  // Ordered by the chain, not by sequence: each direction counts from zero, so sequence alone
  // interleaves the two conversations wrongly. The event order is the one both ends see.
  return [...entry.history].sort((a, b) => a.at - b.at || Number(a.mine) - Number(b.mine) || a.seq - b.seq);
}

/**
 * How a message may be labelled on any surface — invariant I7.
 *
 * ONE FUNCTION, because the rule is that the product never shows a name without showing what
 * backs it, and a rule enforced in two renderers is a rule that holds in one of them. The TUI
 * and the CLI both call this; `adversary/test/i7-attribution.test.ts` renders real transcripts
 * and fails if a name reaches a frame any other way.
 *
 * A reader's own belief about who they are talking to is theirs to hold, so deniable content is
 * still shown under the name they gave the channel. What the product may not do is present it as
 * something a screenshot or a forward would read as proof.
 */
export function attributionLabel(
  message: Pick<ReceivedMessage, "mine" | "attribution">,
  channelName: string,
): { readonly name: string; readonly mark: string; readonly basis: string } {
  const name = message.mine ? "you" : channelName;
  return message.attribution === "signed"
    ? { name, mark: SIGNED_MARK, basis: "signed — provable to anyone holding their bundle" }
    : { name, mark: UNVERIFIABLE_MARK, basis: "unverifiable — either of you could have written it" };
}

/**
 * The two marks, defined once.
 *
 * Not decorative and not interchangeable: a surface that showed the same glyph for both, or none
 * at all, would be a surface where a forgery reads exactly like a signature.
 */
export const SIGNED_MARK = "✓";
export const UNVERIFIABLE_MARK = "?";

/**
 * Delete messages from the transcript, which now actually deletes them.
 *
 * It did not use to. Every channel key descended from material in this file, so a "deleted"
 * message could be re-derived and re-fetched from the vault by the same client that deleted it —
 * deletion was a display preference. With the ratchet the key for a message this client has read
 * is destroyed when it is used, so this transcript is the only copy that exists on this device.
 *
 * WHAT IT DOES NOT REACH, and none of it is small: the ciphertext is still in the vault until it
 * expires, the other end still has its own copy, and this file has already been written to a disk
 * that may keep the old blocks — the same `fs.deletedResidue` problem the vault's own table
 * carries, applied to the client. What it does mean is that no key on this device opens it again.
 *
 * Returns how many entries went.
 */
export function forget(state: State, name: string, before?: number): number {
  const entry = channelAt(state, name);
  const keep = before === undefined ? [] : entry.history.filter((m) => m.at >= before);
  const gone = entry.history.length - keep.length;
  entry.history = keep;
  return gone;
}

/**
 * How many messages in YOUR direction this client did not send.
 *
 * Zero unless a second client is running on the same identity — the same seed copied to a phone
 * and a laptop, which is the obvious thing to do with a state file and the thing this design
 * cannot support. Two devices are not two directions: they share a role, so they derive the same
 * cover from the same sequence numbers, and their decoys are byte-identical. Measured on a
 * two-message exchange from two copies of one state file: ten uploads, **six** objects.
 *
 * A blob id is a hash of its content, so an id that arrives twice is an id two clients minted
 * independently — and cover is the only object that happens to. A vault keeping its request log
 * reads every decoy off it with certainty.
 *
 * IT CANNOT BE FIXED BY GIVING THE DEVICE ITS OWN KEY. The recipient derives a message's decoys
 * from the sender's channel and sequence number in order to fetch them (`decisions/0014` — a
 * decoy nobody fetches is worthless), and it cannot derive them from a device identifier it has
 * never seen. Carrying one would mean putting it on chain, and the note is two felts.
 *
 * So the condition is DETECTED rather than prevented, and both front ends say so. This client
 * sent `nextSeq` messages; if the channel holds more than that in its own direction, something
 * else is sending as you.
 */
export const foreignSends = (state: State, name: string): number =>
  state.channels[name]?.foreignSeen ?? 0;

/** Pad a batch that is somehow short. Exported so the test can assert the floor is respected. */
export const readBatchFloor = MIN_READ_BATCH;
export { randomBytes as _randomBytes, select, BUCKETS };
