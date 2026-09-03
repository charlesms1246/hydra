/**
 * The Diffie-Hellman half of the Double Ratchet — post-compromise security.
 *
 * `ratchet.ts` gives forward secrecy: a chain key produces one message key and its successor, the
 * predecessor is overwritten, and an attacker who takes the device at message 50 cannot open 1
 * to 49. It says in its own header what it does not give, and this is that:
 *
 *   FORWARD SECRECY  an attacker who takes the state cannot read the PAST.
 *   POST-COMPROMISE  an attacker who takes the state stops being able to read the FUTURE,
 *                    as soon as both ends have each performed one DH step.
 *
 * The second needs fresh key material neither end can derive from what was stolen, which is a new
 * DH keypair per ratchet and a header on every message naming the public half.
 *
 * WHERE THE HEADER LIVES, and it was the reason this waited: `decisions/0032`. It must be readable
 * BEFORE the message key exists, so it is sealed under the addressing key rather than the message
 * key; and because padding happens before sealing and the vault demands an exact bucket, it takes
 * a fixed reserved prefix INSIDE the existing bucket rather than growing the blob. So blob sizes
 * do not move, `blob.bucket` discloses exactly what it did before, and cover's bucket matching is
 * untouched. Sixty-eight bytes of payload, and no new row on the disclosure table.
 *
 * THE STORED HEX IS THE KEY, the same rule `ratchet.ts` learned the hard way: `packChain` and
 * `unpackChain` are not inverses, so a key that took one extra round trip is a different key.
 * Everything here goes through hex, exactly once.
 *
 * NOT WIRED UP YET, and this is stated rather than implied: nothing calls this module. The wire
 * change is a blob-format change and this repo has a shipped format with real records on a real
 * chain, so it gets its own commit and its own live check. **Post-compromise security is not a
 * property this client has today.**
 */

import { subKey, expose, VAULT_DOMAIN } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";
import { dh, ephemeral, rawPublic, KEY_BYTES } from "./keys.ts";
import { newChain, keyFor, packChain, unpackChain, parkThrough } from "./ratchet.ts";
import type { ChainState } from "./ratchet.ts";
import { randomBytes } from "node:crypto";

/** `ratchetPublicKey || previousChainLength || messageNumber`, before its own seal. */
export const HEADER_BYTES = KEY_BYTES + 4 + 4;
/** What the header costs inside a bucket, seal included. See `decisions/0032`. */
export const HEADER_RESERVED = HEADER_BYTES + 12 + 16;

/** What every message carries so the receiver knows which chain it belongs to. */
export type Header = {
  /** The sender's current ratchet public key. A value the receiver has not seen starts a step. */
  readonly ratchetKey: Uint8Array;
  /** How long the sender's PREVIOUS sending chain was, so the receiver can finish it. */
  readonly previousChainLength: number;
  /** Position in the current chain. */
  readonly messageNumber: number;
};

export function encodeHeader(h: Header): Uint8Array {
  if (h.ratchetKey.length !== KEY_BYTES) throw new Error(`a ratchet key is ${KEY_BYTES} bytes`);
  const out = Buffer.alloc(HEADER_BYTES);
  Buffer.from(h.ratchetKey).copy(out, 0);
  out.writeUInt32BE(h.previousChainLength, KEY_BYTES);
  out.writeUInt32BE(h.messageNumber, KEY_BYTES + 4);
  return new Uint8Array(out);
}

export function decodeHeader(bytes: Uint8Array): Header {
  if (bytes.length !== HEADER_BYTES) {
    throw new Error(`a header is ${HEADER_BYTES} bytes, got ${bytes.length}`);
  }
  const b = Buffer.from(bytes);
  return {
    ratchetKey: new Uint8Array(b.subarray(0, KEY_BYTES)),
    previousChainLength: b.readUInt32BE(KEY_BYTES),
    messageNumber: b.readUInt32BE(KEY_BYTES + 4),
  };
}

/** A conversation's DH state, as a client stores it. Hex throughout — see the header. */
export type DhState = {
  /** The root key. Every DH step consumes it and replaces it; the old one is overwritten. */
  rootHex: string;
  /** The seed of OUR current ratchet private key. Replaced on every step we initiate. */
  ourSeedHex: string;
  /** Their current ratchet public key, hex, or null before the first message from them. */
  theirKeyHex: string | null;
  sending: ChainState;
  receiving: ChainState;
  /** How long our previous sending chain was, for the header. */
  previousSendingLength: number;
  /**
   * Message keys stepped over in chains we have already ratcheted PAST, keyed by
   * `theirKeyHex:seq`.
   *
   * `ChainState.skipped` only reaches within one chain. A DH step abandons a receiving chain
   * whether or not its last messages have arrived, and uploads are late on purpose — up to eight
   * block intervals — so a message from the old chain arriving after the step is the ordinary
   * case rather than the exotic one. Without this it would be permanently unreadable, which is
   * forward secrecy indistinguishable from data loss.
   */
  acrossSteps: Record<string, string>;
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

/**
 * Mix a DH output into the root, giving a new root and one chain key.
 *
 * Two labels over the same material, because a chain key that equalled the next root would let
 * anyone holding one chain derive every ratchet after it — the same defect `ratchet.ts` avoids
 * between a message key and its successor, one level up.
 *
 * The DH output goes in as part of the LABEL rather than through a separate combiner, because
 * `subKey` is the only KDF in this system that keeps a secret inside its domain, and adding a
 * second one is adding a second place for a domain to be crossed.
 */
function rootStep(rootHex: string, shared: Uint8Array, where: string):
  { rootHex: string; chain: Secret<typeof VAULT_DOMAIN> } {
  const root = unpackChain(rootHex, where);
  const tag = hex(shared);
  return {
    rootHex: packChain(subKey(root, `hydra/dh-ratchet/root ${tag}`)),
    chain: subKey(root, `hydra/dh-ratchet/chain ${tag}`),
  };
}

/** A fresh ratchet keypair. The seed is what gets stored; the private key is never serialised. */
export const freshRatchetSeed = (): string => hex(new Uint8Array(randomBytes(32)));

export const ratchetPublic = (seedHex: string): Uint8Array =>
  rawPublic(ephemeral(unhex(seedHex)));

/**
 * Open a conversation's DH state from the shared secret X3DH produced.
 *
 * THE RESPONDER MUST PASS THE SEED IT PUBLISHED, and this signature exists because the first
 * version generated a fresh one for both ends. The initiator takes its first step against the
 * ratchet key it read out of the responder's bundle; if the responder then holds a different
 * private key, the two DH outputs are unrelated and every message fails to open with both ends
 * believing their own state is correct. `ourSeedHex` is therefore an input, not a detail.
 *
 * The initiator passes `theirRatchetKey` instead and steps immediately, so it never sends under
 * the bootstrap chain. The responder cannot step until it hears from the initiator, because until
 * then it does not know a key to step onto.
 */
export function newDhState(
  agreed: Secret<typeof VAULT_DOMAIN>,
  where: string,
  opts: { theirRatchetKey?: Uint8Array; ourSeedHex?: string } = {},
): DhState {
  const theirRatchetKey = opts.theirRatchetKey ?? null;
  const ourSeedHex = opts.ourSeedHex ?? freshRatchetSeed();
  const base: DhState = {
    rootHex: packChain(agreed),
    ourSeedHex,
    theirKeyHex: null,
    sending: newChain(subKey(agreed, "hydra/dh-ratchet/bootstrap-send")),
    receiving: newChain(subKey(agreed, "hydra/dh-ratchet/bootstrap-recv")),
    previousSendingLength: 0,
    acrossSteps: {},
  };
  if (!theirRatchetKey) return base;
  // The initiator knows the responder's key from the bundle, so it can take the first step
  // immediately and never send under the bootstrap chain.
  const shared = dh(ephemeral(unhex(ourSeedHex)), theirRatchetKey);
  const stepped = rootStep(base.rootHex, shared, where);
  return {
    ...base,
    rootHex: stepped.rootHex,
    theirKeyHex: hex(theirRatchetKey),
    sending: newChain(stepped.chain),
  };
}

/** The header the next outgoing message carries. */
export const headerFor = (state: DhState): Header => ({
  ratchetKey: ratchetPublic(state.ourSeedHex),
  previousChainLength: state.previousSendingLength,
  messageNumber: state.sending.next,
});

/** The key that seals the next outgoing message, advancing the sending chain. */
export function sendKey(state: DhState, where: string): Secret<typeof VAULT_DOMAIN> {
  const key = keyFor(state.sending, state.sending.next, where);
  if (!key) throw new Error("the sending chain refused its own next sequence — this is a bug");
  return key;
}

/**
 * A DH step: their new key arrived, so finish the old receiving chain and start two new ones.
 *
 * The order is not arbitrary. The old receiving chain is drained to `previousChainLength` FIRST
 * and its keys parked in `acrossSteps`, because after the step that chain is gone and any of its
 * messages still in flight would be unopenable. Then the receiving chain comes from our OLD key
 * against their new one, and the sending chain from a FRESH key of ours against the same — which
 * is what makes the step recover from a compromise rather than merely rotate.
 */
export function step(state: DhState, header: Header, where: string): void {
  const theirNew = hex(header.ratchetKey);
  if (state.theirKeyHex === theirNew) return;

  if (state.theirKeyHex !== null) {
    // `parkThrough` and not a loop over `keyFor`, because `keyFor` hands back a `Secret` and a
    // `Secret` cannot be packed into the hex it came from — `packChain(unpackChain(h))` is not
    // `h`. Parking that way returns a different key for every straggler, and the failure looks
    // like a corrupt message rather than like a bug here. `ratchet.ts` says so at length.
    for (const [seq, hex] of Object.entries(
      parkThrough(state.receiving, header.previousChainLength, where))) {
      state.acrossSteps[`${state.theirKeyHex}:${seq}`] = hex;
    }
  }

  const recv = rootStep(state.rootHex, dh(ephemeral(unhex(state.ourSeedHex)), header.ratchetKey), where);
  state.rootHex = recv.rootHex;
  state.receiving = newChain(recv.chain);
  state.theirKeyHex = theirNew;

  // A NEW KEYPAIR, and this is the whole of post-compromise security. Reusing ours would leave
  // every future chain derivable from the private key an attacker already took.
  state.ourSeedHex = freshRatchetSeed();
  const send = rootStep(state.rootHex, dh(ephemeral(unhex(state.ourSeedHex)), header.ratchetKey), where);
  state.rootHex = send.rootHex;
  state.previousSendingLength = state.sending.next;
  state.sending = newChain(send.chain);
}

/**
 * The key that opens an incoming message, stepping first if its header says to.
 *
 * Returns null when the key is genuinely gone — used and deleted, or skipped past and dropped.
 * That is forward secrecy working, and the caller keeps its own transcript for exactly this
 * reason.
 */
export function receiveKey(
  state: DhState,
  header: Header,
  where: string,
): Secret<typeof VAULT_DOMAIN> | null {
  const theirs = hex(header.ratchetKey);
  // A message from a chain we have already stepped past. Its key was parked before the step.
  const parked = state.acrossSteps[`${theirs}:${header.messageNumber}`];
  if (parked !== undefined) {
    delete state.acrossSteps[`${theirs}:${header.messageNumber}`];
    return unpackChain(parked, where);
  }
  if (state.theirKeyHex !== null && state.theirKeyHex !== theirs
    && !isCurrentOrNewer(state, theirs)) {
    // An old key whose message we did not park: gone, and gone on purpose.
    return null;
  }
  step(state, header, where);
  return keyFor(state.receiving, header.messageNumber, where);
}

/**
 * Whether a ratchet key is one we have not seen, as opposed to one we have moved past.
 *
 * Kept as its own function because "not the current key" and "older than the current key" are
 * different things and conflating them either drops live messages or reopens dead chains.
 */
function isCurrentOrNewer(state: DhState, theirs: string): boolean {
  return state.theirKeyHex === null || state.theirKeyHex === theirs
    || !Object.keys(state.acrossSteps).some((k) => k.startsWith(`${theirs}:`));
}

/** The root key as bytes, for a test that needs to prove two states agree or do not. */
export const rootBytes = (state: DhState): Uint8Array =>
  expose(unpackChain(state.rootHex, "dh-ratchet root, for comparison"), VAULT_DOMAIN);
