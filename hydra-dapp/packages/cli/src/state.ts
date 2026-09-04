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

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isEnvelope, open as openEnvelope, seal } from "./at-rest.ts";
import type { PrekeyStore } from "../../handshake/src/prekeys.ts";
import type { DhState } from "../../handshake/src/dh-ratchet.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const STATE_DIR = process.env.HYDRA_HOME ?? join(homedir(), ".hydra-msg");
export const STATE_FILE = join(STATE_DIR, "state.json");

export type PendingUpload = {
  readonly channel: string;
  readonly id: string;
  readonly bodyB64: string;
  /**
   * The stored form of this object's delete capability — `channel/src/deletion.ts`.
   *
   * Carried on the queue rather than recomputed at flush time because the token's derivation
   * depends on the message's CLASS, and the queue is the last place that knows it: a decoy and a
   * signed message look identical from here on, which is the point of both.
   */
  readonly deleteHash?: string;
  readonly uploadAt: number;
  /** False for cover traffic, which is uploaded exactly like a message because it must be. */
  readonly real: boolean;
};

export type ChannelState = {
  /**
   * Ids in this channel that the vault reported REMOVED UNDER LEGAL PROCESS — `D6`.
   *
   * Persisted rather than reported once, because a compelled removal is not news that expires: a
   * user who reads the conversation again next month should still be told, and a notice they
   * happened not to be looking at is a notice they never got.
   */
  removedUnderProcess?: string[];

  readonly peer: string;
  /**
   * Which end of the handshake this is.
   *
   * A channel is not one key. It was, and a reply broke it: both parties derived the same cover
   * from the same sequence numbers, so ten uploads became six objects, eight invites bought
   * four, and every message sat at a sequence number the other end was also using. Nothing in
   * the suite noticed, because nothing in the suite ever replied. See
   * `claude-docs/decisions/0023-two-way-channels.md`.
   *
   * Kept for the record now that both addressing keys are stored outright — it is how a reader
   * of this file knows which end wrote it.
   */
  readonly role: "initiator" | "responder";

  /**
   * THE ADDRESSING KEYS, kept forever, and the AGREED MATERIAL IS NOT HERE.
   *
   * A channel's pointer pads, blob ids and cover bodies have to be derivable for as long as the
   * conversation exists, by both ends — a message that cannot be found is lost and a decoy that
   * cannot be fetched is worthless (`decisions/0014`). So these are kept.
   *
   * What is deliberately absent is `materialHex`, the bytes X3DH agreed. It used to be here and
   * everything descended from it, which meant every message key this client had ever used could
   * be regenerated from this file. Keeping it would undo the ratchet below entirely: a key you
   * can regenerate is a key you have not deleted.
   */
  readonly addressSendHex: string;
  readonly addressRecvHex: string;
  /**
   * The other end's Ed25519 key, which is what their signed messages verify against.
   *
   * Learned during the handshake and BOUND there: the initiator's copy comes from the bundle,
   * under the bundle's own signature; the responder's comes from inside the sealed wrap, where
   * GCM's tag refuses a substitution. A signing key accepted unauthenticated is a signing key a
   * relay can swap, after which this client attributes content to a key of their choosing.
   */
  readonly peerSigningKeyHex: string;
  /**
   * The Starknet address their signing key is published at, once it has been checked.
   *
   * Absent until somebody confirms it, and absent is the honest default: the key above arrived
   * over the handshake, which binds it to the person who ran the handshake and to nobody else.
   * That is trust on first use — good enough that a relay cannot swap it mid-conversation, and
   * no help at all if the wrong person answered in the first place.
   *
   * `anchorPeer` sets this only when a record published at an address carries the SAME key, so
   * the value means "this key is also on chain", not "this key came from chain". A record that
   * disagrees is refused rather than stored, because a disagreement is either the handshake or
   * the record being wrong and the client cannot tell which.
   */
  anchor?: string;

  /**
   * The ratchet — both directions, plus the DH state that re-keys them.
   *
   * It used to be two bare `ChainState`s, one per direction, which is the symmetric half:
   * forward secrecy, and no recovery from a compromise. `DhState` still holds a chain per
   * direction and adds what re-keys them, so every property the old shape had is still a
   * property of `dh.sending` and `dh.receiving`.
   *
   * See `handshake/src/dh-ratchet.ts` and `decisions/0032`.
   */
  dh: DhState;

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
   * THE COST IS A PLAINTEXT TRANSCRIPT AT REST, protected exactly as well as the seed above: a
   * 0600 file and nothing else. It does not widen who can read the conversation, since anyone
   * holding the seed could fetch and open it anyway — but the words are here without any work.
   *
   * IT IS ALSO WHAT MAKES THE RATCHET MEAN SOMETHING. A message key is used once and destroyed,
   * so a message this client has read cannot be read again from the vault. This transcript is
   * the only copy. Deleting an entry therefore actually deletes the message, which was not true
   * before: anything could be re-derived and re-fetched.
   */
  history: ReceivedMessage[];
  /**
   * Objects seen in THIS client's own sending direction that this client did not send.
   *
   * Non-zero means a second client is running on the same identity. Counted during a read rather
   * than derived from the transcript, because a second client sends at sequence numbers you have
   * used and its messages cannot be told from yours by position — only by blob id, which is what
   * the read compares. See `commands.ts` `foreignSends`.
   */
  /**
   * The accounts that could still have produced every upload this channel has ever made.
   *
   * `decisions/0029`'s crowd, as a SET rather than a count, and kept per channel because that is
   * the level the number is true at. A crowd is set by its worst-covered message — one message of
   * six sent into a quiet chain took a measured 34.9 to zero — so a figure that recovered after a
   * bad send would be a lie about a message already on chain. Intersecting a set cannot recover;
   * a minimum over per-message counts could, because the minimum of two counts is not the size of
   * their intersection.
   *
   * `undefined` means NOT KNOWN — no chain that can resolve senders has been asked. It is not
   * zero, and anything rendering it must say so: unknown and "the operator names you every time"
   * are opposite claims.
   */
  crowd?: string[];

  foreignSeen: number;
  /**
   * Messages that opened under this channel's key and were then refused.
   *
   * A body whose commitment does not match the chain event that carried it, or a signature that
   * is present and does not verify. Both mean somebody with write access to the vault or the
   * mailbox tried something; neither is a delivery failure, and neither should be shown as a
   * message. Counted so the client can say it happened rather than silently dropping content.
   */
  refusedSeen: number;
};

/** One message in a transcript, from either end. */
/**
 * Whether a message's author is established, and by what.
 *
 * `signed` means an Ed25519 signature over the on-chain commitment verified under the peer's
 * published key — a key their counterparty does not hold, so nobody in the conversation can
 * produce it for anybody else.
 *
 * `unverifiable` means the only authenticator was the AEAD tag under the channel's shared
 * content key, which EITHER participant can produce. That is deniability, and it is chosen. It
 * is called unverifiable rather than "unsigned" because the product's rule (invariant I7) is
 * about what may be DISPLAYED: content with this value may never be shown under an author's
 * name.
 */
export type Attributed = "signed" | "unverifiable";

export type ReceivedMessage = {
  readonly attribution: Attributed;
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
  /**
   * Whether this client should keep its state encrypted — `decisions/0040`.
   *
   * Set by `hydra lock` and never cleared by an ordinary save: a write must not silently downgrade
   * a locked file to plaintext.
   */
  lockedAtRest?: boolean;

  /**
   * The shape this file is in. Absent means 1 — see {@link STATE_VERSION}.
   *
   * Optional in the type because every file written before this existed has no version, and a
   * required field would strand every install to prove a point.
   */
  version?: number;

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

/**
 * The shape this client writes.
 *
 * **BEFORE KEY-AT-REST, NOT AFTER** — `decisions/0040` records the KDF and its parameters in the
 * file so a future client can open an old one, and writing a KDF into a file with no version field
 * is how you get a client that can only read files it wrote itself. `moderation` has had a version
 * and a migration since its first snapshot; the client, which holds the root key, had neither.
 *
 * 1 is the shape that already existed. A file with no `version` is version 1, because every file
 * on disk today has no version and refusing them would strand every existing install.
 */
export const STATE_VERSION = 1;

/**
 * Where the passphrase comes from.
 *
 * An environment variable, and NOT A PROMPT, in this commit. `hydra flush` is meant to run on a
 * timer, unattended — `decisions/0011` says flush cadence *is* the timing defence — and **a prompt
 * cannot be answered by a timer.** An agent holding the key with a stated idle timeout is what
 * makes this usable and is the next piece; until it exists, an env var is the honest interim,
 * because it is what a user would otherwise build themselves out of a shell alias.
 *
 * It is not free and the client says so where it is set: an environment variable is visible to
 * anything else running as you, and it is in the shell history if it was typed rather than read.
 */
export const PASSPHRASE_ENV = "HYDRA_PASSPHRASE";

const passphrase = (): string | undefined => process.env[PASSPHRASE_ENV] || undefined;

/** Whether the state on disk is locked. Answerable without the passphrase. */
export function locked(): boolean {
  if (!existsSync(STATE_FILE)) return false;
  try { return isEnvelope(JSON.parse(readFileSync(STATE_FILE, "utf8"))); } catch { return false; }
}

export function load(): State {
  if (!existsSync(STATE_FILE)) throw new Error(`no state at ${STATE_FILE} — run \`hydra init\` first`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    // A CORRUPT FILE IS A LOUD FAILURE NAMING THE FILE. It used to be a bare `JSON.parse`, and in
    // the TUI that runs at module scope — before the `uncaughtException` handler and before the
    // alt-screen switch — so a truncated write killed it with no frame drawn and no explanation.
    throw new Error(`${STATE_FILE} is not readable as JSON (${(e as Error).message}). It holds `
      + "your root key and every conversation; do not delete it. A partial write from an "
      + "interrupted save is the usual cause, and a backup beside it may be intact.");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${STATE_FILE} does not contain a client state object`);
  }
  // LOCKED FILES ARE OPENED BEFORE ANYTHING ELSE LOOKS AT THEM, so no caller ever sees an
  // envelope and mistakes it for a state with missing fields.
  if (isEnvelope(parsed)) {
    const secret = passphrase();
    if (!secret) {
      throw new Error(`${STATE_FILE} is locked. Set ${PASSPHRASE_ENV} to open it.\n\n`
        + "There is no recovery: the passphrase is the only way in, and a path that did not need "
        + "it would be a second way in. If you wrote the phrase down, that copy is what you need.");
    }
    parsed = JSON.parse(openEnvelope(parsed, secret)) as unknown;
  }
  const version = (parsed as { version?: unknown }).version ?? STATE_VERSION;
  if (version !== STATE_VERSION) {
    // REFUSED RATHER THAN GUESSED AT, the same rule the moderation snapshot uses: a state read
    // wrong is a key derived wrong, and the failure would appear as somebody else's messages
    // failing to open rather than as a version problem.
    throw new Error(`${STATE_FILE} was written by state version ${String(version)} and this `
      + `client is ${STATE_VERSION}. Refusing to guess at the difference — a state file read `
      + "wrong is a root key used wrong. Use the client that wrote it, or start fresh.");
  }
  return parsed as State;
}

export function save(state: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  // WRITTEN VIA A TEMPORARY FILE AND A RENAME, for the reason the operator queue is: a process
  // interrupted mid-write leaves a truncated file, and `load` then refuses it — correctly — so the
  // user has no state at all. `rename` is atomic within a filesystem, so a reader sees the old
  // file or the new one and never a half of either.
  const tmp = `${STATE_FILE}.writing`;
  const plain = `${JSON.stringify({ version: STATE_VERSION, ...state }, null, 2)}\n`;
  // LOCKED IF IT WAS LOCKED, OR IF A PASSPHRASE IS SET. A save must never silently downgrade a
  // locked file to plaintext — that would remove the protection at the moment of an ordinary
  // write, with nothing said. Opt-in, so an existing install is unaffected until `hydra lock`.
  const secret = passphrase();
  const body = secret && (locked() || state.lockedAtRest)
    ? `${JSON.stringify(seal(plain, secret), null, 2)}\n`
    : plain;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, STATE_FILE);
  // Set explicitly as well as at creation: `writeFileSync`'s mode applies only when the file
  // does not already exist, so a file created some other way would keep its own permissions.
  chmodSync(STATE_FILE, 0o600);
}

export const exists = (): boolean => existsSync(STATE_FILE);
