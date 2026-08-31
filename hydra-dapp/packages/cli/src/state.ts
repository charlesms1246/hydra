/**
 * What the client keeps between commands, and what keeping it costs.
 *
 * THE SEED IS ON DISK IN THE CLEAR. Said here rather than buried: this file holds the vault
 * root, and the vault root regenerates every prekey private (see
 * `claude-docs/decisions/0009-key-agreement.md`) and every channel key ever agreed. Anyone who
 * reads it reads every past and future conversation. It is written 0600 and that is the only
 * protection there is — no passphrase, no OS keychain, no hardware token, because a passphrase
 * prompt this client cannot yet ask for would be worse than an honest plaintext file that says
 * what it is.
 *
 * A GUI is where that changes. Until then the disclosure is: **this is a client for a devnet
 * and a testnet, not for anyone whose safety depends on it.** `hydra status` prints that.
 *
 * The pending queue is the other thing worth explaining. An upload must happen strictly AFTER
 * the chain event that names it and by a jittered delay — see `channel/src/schedule.ts` — so
 * `send` cannot upload, and a command that blocked for four minutes would be a command people
 * work around. `send` queues; `flush` uploads what is due. A client that uploaded immediately
 * would pass every test in this repo and hand the vault operator the correlation the whole
 * design exists to deny.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PrekeyStore } from "../../handshake/src/prekeys.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const STATE_DIR = process.env.HYDRA_HOME ?? join(homedir(), ".hydra-msg");
export const STATE_FILE = join(STATE_DIR, "state.json");

export type PendingUpload = {
  readonly channel: string;
  readonly id: string;
  readonly bodyB64: string;
  readonly uploadAt: number;
  /** False for cover traffic, which is uploaded exactly like a message because it must be. */
  readonly real: boolean;
};

export type ChannelState = {
  /** The bytes X3DH agreed, not the derived key — see `commands.ts` `channelOf`. */
  readonly materialHex: string;
  readonly peer: string;
  /**
   * Which end of the handshake this is, and it decides which of the channel's TWO keys this
   * client sends under.
   *
   * A channel is not one key. It was, and a reply broke it: both parties derived the same cover
   * from the same sequence numbers, so ten uploads became six objects, eight invites bought
   * four, and every message sat at a sequence number the other end was also using. Nothing in
   * the suite noticed, because nothing in the suite ever replied. See
   * `claude-docs/decisions/0023-two-way-channels.md`.
   */
  readonly role: "initiator" | "responder";
  nextSeq: number;
  /**
   * How many chain events this client has already looked at.
   *
   * Reading replays the chain from block zero and asks the vault for a candidate id per
   * (event, sequence, direction) triple, because a pointer names no channel — that is I3 and
   * the cost is the feature. Replaying it EVERY time is not. Measured: a conversation stopped
   * working at **35 messages**, with the client asking for 4800 ids in a 323 KiB request against
   * a vault that accepts 257 KiB. Not slow — dead, with a clear error message and no way past it.
   */
  readTo: number;
  /**
   * Every message this client has opened, plus everything it has sent.
   *
   * THE COST IS A PLAINTEXT TRANSCRIPT AT REST, and it is the same protection as the seed above:
   * a 0600 file, nothing else. Anyone who can read this file could already derive every channel
   * key from `seedHex` and fetch the conversation themselves, so this does not widen who can
   * read it — but it does mean the words are there without any work, and it means deleting a
   * message from this file is the only way to not have it.
   */
  history: ReceivedMessage[];
};

/** One message in a transcript, from either end. */
export type ReceivedMessage = {
  /**
   * The blob id, which is what makes a message unique.
   *
   * Not `(direction, sequence)`, which was the first key and which HID the condition
   * `foreignSends` exists to report: a second client on the same identity sends at the same
   * sequence in the same direction, so keying on that pair silently discarded its messages as
   * duplicates of your own. A blob id is a hash of the ciphertext, so two different messages
   * cannot share one.
   */
  readonly id: string;
  readonly seq: number;
  readonly text: string;
  /** True for messages this client sent. */
  readonly mine: boolean;
  /** The index of the chain event that carried it — the ordering both ends agree on. */
  readonly at: number;
};

export type State = {
  vaultUrl: string;
  rpcUrl: string;
  contract: string;
  fromBlock: number;
  accountsFile: string;
  account: string;
  network?: string;
  /** Set to publish through the pool instead of directly. See `cli.ts` `chainFor`. */
  controlUrl?: string;
  poolAccount?: string;
  blockMs: number;
  /** The vault root. See the header. */
  seedHex: string;
  /**
   * Prekey privates, which are DELETED on rotation and on use.
   *
   * The one part of this file whose contents are supposed to disappear. Everything else here can
   * be regenerated from the seed; these cannot, deliberately — see `handshake/src/prekeys.ts`,
   * including what "deleted" honestly means when the file has already been written once.
   */
  prekeys: PrekeyStore;
  /**
   * Upload tokens, consumed one per object.
   *
   * Cover traffic spends them too, at `COVER_RATE` per message, and that is not an oversight to
   * optimise away: a decoy admitted by a different route than a message would be separable by
   * that route. The cost of the timing defence is denominated in invites.
   */
  invites: string[];
  channels: Record<string, ChannelState>;
  pending: PendingUpload[];
};

export function load(): State {
  if (!existsSync(STATE_FILE)) throw new Error(`no state at ${STATE_FILE} — run \`hydra init\` first`);
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
}

export function save(state: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  // Set explicitly as well as at creation: `writeFileSync`'s mode applies only when the file
  // does not already exist, so a file created some other way would keep its own permissions.
  chmodSync(STATE_FILE, 0o600);
}

export const exists = (): boolean => existsSync(STATE_FILE);
