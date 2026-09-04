/**
 * The sending and receiving chains, which is the half of the Double Ratchet that gives forward
 * secrecy.
 *
 * `decisions/0020` settled the shape of this: **store and delete.** A key you can regenerate is a
 * key you have not deleted, and every channel key in this client was regenerable from one seed —
 * `x3dh.test.ts` measured the consequence, that a root compromise plus a recorded transcript
 * recovered every past channel secret. Prekeys were fixed there. Message keys are fixed here.
 *
 * WHAT IS HERE AND WHAT IS NOT. This is the symmetric ratchet: a chain key produces one message
 * key and its own successor, and the predecessor is overwritten. That buys forward secrecy — an
 * attacker who takes the device at message 50 cannot open messages 1 to 49. It does NOT buy
 * post-compromise security, which needs a Diffie-Hellman step with fresh key material per
 * ratchet, and that needs a header on every message saying which ratchet key it used. A header
 * is a new thing for the vault operator to look at — the same 32 bytes on two blobs would link
 * them — so it has to be sealed under the addressing key, and that is a separate change with a
 * disclosure question in it. Not done, and named rather than implied.
 *
 * ADDRESSING IS NOT CONTENT, and separating them is what makes any of this possible. A channel's
 * pointer pads, blob ids and cover bodies must be derivable forever, by both ends, or a message
 * cannot be found and a decoy cannot be fetched. Its message keys must NOT be. So a direction's
 * key splits in two: an addressing key that is kept, and a chain-zero key that is used once and
 * destroyed. The agreed material is destroyed with it — keeping it would regenerate everything
 * this file exists to make unrecoverable.
 *
 * SKIPPED KEYS EXIST BECAUSE UPLOADS ARE LATE ON PURPOSE. A message's blob lands up to eight
 * block intervals after its chain event, so a reader routinely sees message 7 before message 6.
 * Advancing the chain past 6 without keeping its key would make a late message permanently
 * unreadable — forward secrecy indistinguishable from data loss. So the keys for sequences
 * stepped over are kept until they are used, and deleted then.
 */

import { subKey, expose, derive, rootSeed, entropyFrom, fromStoredSeed, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

/**
 * Two labels, and their distinctness is the property that matters.
 *
 * A message key that equalled the next chain key would mean anyone holding one message's key
 * could derive every message after it, which is the opposite of the point.
 */
const MESSAGE = "hydra/ratchet/message-key";
const STEP = "hydra/ratchet/chain-step";

/** The key that seals one message. */
const messageKeyOf = (chain: Secret<typeof VAULT_DOMAIN>): Secret<typeof VAULT_DOMAIN> =>
  subKey(chain, MESSAGE);

/** The next chain key. The caller is expected to stop holding the old one. */
export const stepped = (chain: Secret<typeof VAULT_DOMAIN>): Secret<typeof VAULT_DOMAIN> =>
  subKey(chain, STEP);

/**
 * A chain key, on its way to and from a state file.
 *
 * `where` is the honest provenance the identity package insists on: this came off a disk, and
 * how well it was protected there is the disk's answer, not this module's.
 */
export const packChain = (chain: Secret<typeof VAULT_DOMAIN>): string =>
  Buffer.from(expose(chain, VAULT_DOMAIN)).toString("hex");

export const unpackChain = (hex: string, where: string): Secret<typeof VAULT_DOMAIN> =>
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(
    fromStoredSeed(new Uint8Array(Buffer.from(hex, "hex")), where))));

/** A chain, as a client stores it: where it has reached, and the keys it stepped over. */
export type ChainState = {
  /** The current chain key, hex. Overwritten on every step — this is the deletion. */
  chainHex: string;
  /** The sequence number `chainHex` will produce a key for. */
  next: number;
  /** Sequence → message key, for messages whose blob has not arrived yet. */
  skipped: Record<string, string>;
};

/**
 * THE STORED HEX IS THE KEY, and every path here goes through it.
 *
 * `packChain` and `unpackChain` are not inverses. They cannot be: a `Secret` is only reachable
 * through the entropy adapters, so unpacking DERIVES a new secret from the packed bytes rather
 * than restoring the one they came from. That is fine as long as everything is packed exactly
 * as often — and the first version of this was not. A message key taken straight from the chain
 * was returned as a `Secret`; the same key, skipped and stored, came back through one extra
 * round trip. Two keys, same sequence number, and every message decrypted to
 * "unable to authenticate data" with both ends holding identical chains.
 *
 * So the hex is canonical and these three are the only way a key is made.
 */
const chainAt = (hex: string, where: string) => unpackChain(hex, where);

const messageHexOf = (chainHex: string, where: string): string =>
  packChain(messageKeyOf(chainAt(chainHex, where)));

const nextHexOf = (chainHex: string, where: string): string =>
  packChain(stepped(chainAt(chainHex, where)));

export const newChain = (chain: Secret<typeof VAULT_DOMAIN>): ChainState =>
  ({ chainHex: packChain(chain), next: 0, skipped: {} });

/**
 * The key for `seq`, advancing and destroying as it goes.
 *
 * Returns null when `seq` is behind the chain and was not skipped — which means its key has been
 * used and deleted, and the message cannot be opened again. That is forward secrecy doing its
 * job, and it is why a client keeps its own transcript: the plaintext it already read is the
 * only copy it will ever have.
 *
 * `limit` bounds how far the chain will run forward in one call. Without it a corrupt or hostile
 * sequence number — and any stranger can write a plausible-looking one into a mailbox slot —
 * would spin the chain for as long as the number said.
 */
export function keyFor(
  state: ChainState,
  seq: number,
  where: string,
  limit = 512,
): Secret<typeof VAULT_DOMAIN> | null {
  const held = state.skipped[String(seq)];
  if (held !== undefined) {
    delete state.skipped[String(seq)];
    return chainAt(held, where);
  }
  if (seq < state.next) return null;
  if (seq - state.next > limit) return null;

  while (state.next < seq) {
    // Kept, because its message may still be in flight. Deleted when it is used, or when the
    // caller decides it never will be.
    state.skipped[String(state.next)] = messageHexOf(state.chainHex, where);
    state.chainHex = nextHexOf(state.chainHex, where);
    state.next++;
  }
  const key = chainAt(messageHexOf(state.chainHex, where), where);
  state.chainHex = nextHexOf(state.chainHex, where);
  state.next = seq + 1;
  return key;
}

/**
 * Advance a chain to `upto` without consuming a key, parking everything stepped over.
 *
 * Exported for the DH ratchet, which has to drain a receiving chain before abandoning it — and
 * which cannot do this for itself. `keyFor` returns a `Secret`, and a `Secret` cannot be turned
 * back into the hex it came from: `packChain(chainAt(hex))` is NOT `hex`, because `unpackChain`
 * derives rather than restores. That is the defect this file's header describes, and parking a
 * key by packing the Secret reproduces it exactly — the key comes back different and every
 * message from the abandoned chain fails to open.
 *
 * So the raw hexes never leave this file's representation. The caller gets them as they are
 * stored, and hands them back to `unpackChain`, which is the same single hop `keyFor` makes.
 */
export function parkThrough(state: ChainState, upto: number, where: string): Record<string, string> {
  const parked: Record<string, string> = {};
  for (const [seq, hex] of Object.entries(state.skipped)) {
    if (Number(seq) < upto) {
      parked[seq] = hex;
      delete state.skipped[seq];
    }
  }
  while (state.next < upto) {
    parked[String(state.next)] = messageHexOf(state.chainHex, where);
    state.chainHex = nextHexOf(state.chainHex, where);
    state.next++;
  }
  return parked;
}

/**
 * Give up on the sequences skipped longest ago.
 *
 * A skipped key is a message key kept in a file, so an unbounded set of them is forward secrecy
 * quietly leaking back. The bound is on count rather than on age because a client has no clock it
 * can trust for this, and the messages worth waiting for are the recent ones.
 */
export function forgetOldSkipped(state: ChainState, keep: number): number {
  const seqs = Object.keys(state.skipped).map(Number).sort((a, b) => a - b);
  const drop = seqs.slice(0, Math.max(0, seqs.length - keep));
  for (const seq of drop) delete state.skipped[String(seq)];
  return drop.length;
}
