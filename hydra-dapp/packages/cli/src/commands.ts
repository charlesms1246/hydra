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
import { initiate, respond, bundleFor } from "../../handshake/src/x3dh.ts";
import type { Bundle, PrekeyMessage } from "../../handshake/src/x3dh.ts";
import { coverPlan, coverBody, coverId } from "../../channel/src/cover.ts";
import { feltToPointer } from "../../channel/src/note.ts";
import { openForChannel, plaintextOf, ENCRYPTED_ENDPOINT } from "../../vault-client/src/blobs.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import {
  derive, rootSeed, entropyFrom, fromOsRandom, fromStoredSeed, fromChannelWrap, VAULT_DOMAIN,
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
    invites: [],
    channels: {},
    pending: [],
    ...overrides,
  };
}

/** Everything a stranger needs to open a conversation with you while you are offline. */
export function publishBundle(state: State, epoch = 0, oneTimeIndex?: number): Bundle {
  return bundleFor(vaultRootOf(state), epoch, oneTimeIndex);
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

const remember = (state: State, name: string, material: Uint8Array, peer: string): void => {
  const entry: ChannelState = { materialHex: hex(material), peer, nextSeq: 0 };
  state.channels[name] = entry;
};

/** Alice's side. Produces the prekey message, which has to reach the other person somehow. */
export function open(state: State, name: string, bundle: Bundle): PrekeyMessage {
  if (state.channels[name]) throw new Error(`${name} already exists — pick another name`);
  const result = initiate(vaultRootOf(state), bundle);
  remember(state, name, result.material, fingerprint(bundle));
  return result.message;
}

/** Bob's side. */
export function accept(state: State, name: string, message: PrekeyMessage): { usedOneTimePrekey: boolean } {
  if (state.channels[name]) throw new Error(`${name} already exists — pick another name`);
  const result = respond(vaultRootOf(state), message);
  remember(state, name, result.material, hex(message.identityKey).slice(0, 32));
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
  text: string,
  now: number = Date.now(),
  random?: () => number,
): Promise<{ txHash: string; uploadAt: number; decoys: number }> {
  const channel = channelOf(state, name);
  const entry = state.channels[name];
  const seq = entry.nextSeq;
  const config = { channel, nullifier: BigInt(`0x${entry.materialHex.slice(0, 16)}`), blockMs: state.blockMs };
  const outgoing = prepare(config, new TextEncoder().encode(text), seq, now, random);

  const txHash = await chain.publish(outgoing.calldata);
  entry.nextSeq = seq + 1;

  state.pending.push({
    channel: name, id: outgoing.blobId,
    bodyB64: Buffer.from(outgoing.body).toString("base64"),
    uploadAt: outgoing.uploadAt, real: true,
  });

  const decoys = coverPlan([{ at: now, bucket: outgoing.body.length }], config, random);
  for (const d of decoys) {
    const body = coverBody(channel, d.bucket);
    state.pending.push({
      channel: name, id: coverId(body),
      bodyB64: Buffer.from(body).toString("base64"),
      uploadAt: d.at, real: false,
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
 * Read a channel: every event on chain, every plausible sequence number, one batched fetch.
 *
 * THE COST OF UNLINKABILITY IS QUADRATIC, and it is worth naming rather than hiding. A pointer
 * carries no channel and no sequence — that is the whole point, and `i3-timeline-join.test.ts`
 * is about it — so a reader cannot tell which events are theirs. `recoverBlobId` is an
 * unmasking, not a test: it returns a plausible id for any pointer and any seq. So the reader
 * computes a candidate id for every (event, seq) pair and asks the vault for all of them; the
 * ones that exist and then open under the channel key are the messages.
 *
 * That is `events × seq` ids for one conversation. A channel hint in the event would collapse
 * it to linear and would be exactly the linkage the design refuses, so the cost is the feature.
 * What makes it affordable in practice is that the candidate set is ALSO the padded read batch
 * `read.target` requires — the work and the defence are the same work.
 */
export async function readChannel(
  state: State,
  chain: Chain,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ seq: number; text: string }[]> {
  const channel = channelOf(state, name);
  const events = await chain.events();
  const seqs = Array.from({ length: Math.max(events.length, MIN_READ_BATCH) }, (_, i) => i);

  const candidates = events.flatMap((e) =>
    seqs.map((seq) => ({ seq, pointer: feltToPointer(e.data[0]) })));
  const ids = readSet(channel, candidates);
  const bySeq = new Map(candidates.map((c) => [receive(channel, c.pointer, c.seq), c.seq]));

  const res = await fetchImpl(`${state.vaultUrl}${ENCRYPTED_ENDPOINT}`, {
    method: "POST", body: JSON.stringify(ids),
  });
  if (!res.ok) throw new Error(`the vault refused the read: ${await res.text()}`);
  const { found } = await res.json() as { found: Record<string, string> };

  const out: { seq: number; text: string }[] = [];
  for (const [id, b64] of Object.entries(found)) {
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    try {
      // A decoy or another channel's blob fails here, which is what GCM's tag is for. Silence
      // is correct: a reader that reported them would be reporting on traffic it cannot read.
      out.push({ seq: bySeq.get(id) ?? -1, text: new TextDecoder().decode(plaintextOf(openForChannel(channel, bytes))) });
    } catch { /* not ours */ }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Pad a batch that is somehow short. Exported so the test can assert the floor is respected. */
export const readBatchFloor = MIN_READ_BATCH;
export { randomBytes as _randomBytes, select, BUCKETS };
