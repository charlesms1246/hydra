/**
 * A messaging session: where the pieces meet.
 *
 * Everything else in this platform is one invariant's worth of code. This is the layer that
 * composes them, and composition is where invariants get lost — a caller that seals but forgets
 * to pad, or publishes before the upload is scheduled, or hands a sandbox pointer to the chain,
 * has broken something no single package can see.
 *
 * So the only public operation is `send`, and it does the whole sequence. There is deliberately
 * no `justSeal` or `publishNow`: an API that lets a caller do half of it is an API where half
 * of it is what happens.
 *
 * THE ORDER IS LOAD-BEARING, and not the obvious one:
 *
 *   1. seal, which pads to a bucket first (`vault-client/src/buckets.ts`)
 *   2. derive the pointer under the VAULT-domain channel secret, never the pool's
 *   3. commit to the content, binding authorship to the note
 *   4. publish the pointer on chain
 *   5. schedule the upload for LATER — `schedule.ts`, at least eight block intervals
 *
 * Five follows four. Uploading first would put the blob in the vault before the chain event
 * that names it, and an operator seeing a blob arrive shortly before its pointer knows the two
 * are related without any further work. `i3-upload-schedule.test.ts` asserts an upload never
 * precedes its own event; this is the code that has to keep that true.
 */

import { channelSecret, pointerFor, blobIdFrom, recoverBlobId } from "../../channel/src/pointer.ts";
import type { Pointer } from "../../channel/src/pointer.ts";
import { noteCalldata } from "../../channel/src/note.ts";
import { commit, contentHashFor } from "../../channel/src/commitment.ts";
import { scheduleUpload, assertSafeSchedule } from "../../channel/src/schedule.ts";
import type { ScheduleConfig } from "../../channel/src/schedule.ts";
import { coverPlan, coverIndex, COVER_RATE, saltFrom, saltForSequence } from "../../channel/src/cover.ts";
import type { Decoy } from "../../channel/src/cover.ts";
import { sealForChannel, wireBytes, uploadPathFor } from "../../vault-client/src/blobs.ts";
import { VAULT_DOMAIN } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";
import { frame, freshBlind } from "../../handshake/src/authorship.ts";
import { headerFor, sendKey, encodeHeader } from "../../handshake/src/dh-ratchet.ts";
import type { DhState } from "../../handshake/src/dh-ratchet.ts";
import type { Attribution } from "../../handshake/src/authorship.ts";

/** Everything one message produces, in the order it must happen. */
export type Outgoing = {
  readonly blobId: string;
  readonly uploadPath: string;
  readonly body: Uint8Array;
  /** Two felts for `privacy_invoke`. Publish these first. */
  readonly calldata: readonly [bigint, bigint];
  /** Wall-clock time to upload at, which is strictly after the chain event. */
  readonly uploadAt: number;
  /** When the chain event was published. Carried so cover can be derived from the messages. */
  readonly publishedAt: number;
  /**
   * The message's position in its channel.
   *
   * Carried because the recipient derives a decoy's index from it — see `cover`. It was already
   * an argument to `send`; not returning it meant the caller had to keep it alongside, and a
   * caller that kept the wrong one would mint decoys nobody fetches.
   */
  readonly seq: number;
  readonly pointer: Pointer<typeof VAULT_DOMAIN>;
};

export type SessionConfig = ScheduleConfig & {
  /** Decoys per message. Both sides must agree, or the recipient stops fetching some. */
  readonly coverRate?: number;
  /**
   * The ADDRESSING key: pointer pads, blob ids, cover bodies, read sets.
   *
   * Kept for the life of the channel by both ends, because a message that cannot be found is
   * lost and a decoy that cannot be fetched is worthless (`decisions/0014`).
   */
  readonly channel: Secret<typeof VAULT_DOMAIN>;
  /**
   * What SEALS the body, if it is not the addressing key.
   *
   * Separate so a client can ratchet content while addressing stays derivable — see
   * `handshake/src/ratchet.ts`. Defaulting to `channel` keeps every harness that is about
   * addressing free of a key it does not care about; the client that does ratchet is held to it
   * by `adversary/test/ratchet.test.ts`, which fails if two messages seal under one key.
   */
  readonly content?: Secret<typeof VAULT_DOMAIN>;
  /**
   * The DH ratchet, if this client has one. Supersedes `content` when present.
   *
   * Passing it changes two things at once, and they belong together: the body seals under a key
   * from the DH-derived sending chain, and the blob carries a header naming the ratchet public
   * key that chain came from. Neither is useful without the other — a header nobody reads is
   * sixty-eight wasted bytes, and a DH-derived key nobody can name is a message nobody can open.
   *
   * `decisions/0032` for the disclosure argument: the header takes a reserved prefix inside the
   * bucket, so blob sizes do not move and no row is added to the operator's table.
   *
   * MUTATED BY `send`, unlike everything else in this config. A ratchet that did not advance
   * would seal every message under one key, which is the defect `ratchet.ts` exists to prevent.
   */
  readonly ratchet?: DhState;
  /**
   * WHO WROTE THIS, and it has no default.
   *
   * Required, so every call site chooses between a signature that nobody including your
   * counterparty can forge and deniability that nobody including your counterparty can
   * disprove. This used to be a `nullifier` derived from the channel's shared material, which
   * bound a message to a CONVERSATION and let either end mint one as the other —
   * `two-way.test.ts` carried that as a residual until it stopped being acceptable.
   *
   * The absence of a default is the point. Deniability that nobody selected is not a property;
   * it is an accident that has not been noticed yet.
   */
  readonly author: Attribution;
};

/**
 * Prepare one message.
 *
 * Returns a plan rather than performing it. The chain write and the upload happen at different
 * times by design — minutes apart — so a function that did both would either block for minutes
 * or lie about having finished.
 */
export function send(
  config: SessionConfig,
  plaintext: Uint8Array,
  seq: number,
  publishedAt: number,
  random?: () => number,
): Outgoing {
  assertSafeSchedule(config);

  // The commitment goes on chain and the signature is over the commitment, so a signature is a
  // statement about a specific message at a specific chain event rather than about some bytes.
  // The blind rides inside the sealed frame, because a reader who cannot recompute the
  // commitment can only check that the author signed SOMETHING.
  const blind = freshBlind();
  const commitment = commit(blind, contentHashFor(plaintext));
  const signature = config.author.kind === "signed" ? config.author.sign(commitment) : null;

  // The DH ratchet if there is one, the sequence-keyed chain otherwise, the addressing key if
  // neither. One expression rather than a branch, because a second sealing path is a second
  // place for a key decision to drift.
  const header = config.ratchet ? headerFor(config.ratchet) : null;
  const sealing = config.ratchet
    ? sendKey(config.ratchet, "session send")
    : config.content ?? config.channel;
  const blob = sealForChannel(sealing, frame(signature, blind, plaintext),
    header ? { bytes: encodeHeader(header), addressing: config.channel } : undefined);
  const body = wireBytes(blob) as unknown as Uint8Array;
  const pointer = pointerFor(config.channel, blobIdFrom(body), seq);
  return {
    blobId: blob.id,
    uploadPath: uploadPathFor(blob),
    body,
    calldata: noteCalldata(pointer, commitment),
    uploadAt: scheduleUpload(publishedAt, config, random),
    publishedAt,
    seq,
    pointer,
  };
}

/** Where to look in the vault, given a pointer read off the chain. */
export function receive(
  channel: Secret<typeof VAULT_DOMAIN>,
  pointer: Uint8Array,
  seq: number,
): string {
  return `enc:${Buffer.from(recoverBlobId(channel, pointer, seq)).toString("hex")}`;
}

/**
 * Decoy uploads for a session, so the first real one is not the earliest thing seen.
 *
 * Takes the `Outgoing` messages rather than bare times, and that is not a convenience. A decoy
 * only hides an upload it resembles, and size is the first thing an operator filters on — a
 * message in a bucket with no decoys is identified **every time**. Deriving the plan from the
 * messages themselves is what makes a mismatch impossible to write.
 *
 * Cover is per event, so the count is `coverRate` times the number of messages regardless of
 * how long the conversation runs. See `channel/src/cover.ts` for why the span version was
 * unaffordable.
 */
export function cover(
  config: SessionConfig,
  messages: readonly {
    readonly publishedAt: number;
    readonly body: Uint8Array;
    readonly seq: number;
    /** The commitment this message published, if the caller has a chain. See `Decoy.salt`. */
    readonly commitment?: bigint;
  }[],
  random?: () => number,
): Decoy[] {
  const rate = config.coverRate ?? COVER_RATE;
  const plan = coverPlan(
    messages.map((m) => ({ at: m.publishedAt, bucket: m.body.length })),
    config,
    random,
  );
  // SALTED PER MESSAGE, INDEXED WITHIN IT, and the pair is what the recipient enumerates. It
  // used to be a single global index folded from the sequence; the salt replaces that, because a
  // sequence number is shared by two devices on one identity and a commitment is not.
  //
  // A caller with no chain salts by sequence, which reproduces exactly the separation the old
  // index gave. A caller that passed a subset of its messages here still mints decoys the
  // recipient asks for, because the salt comes from the message rather than from a position in
  // this array — the never-fetched signal that indexing exists to remove.
  return plan.map((d) => {
    const message = messages[Math.floor(d.index / rate)];
    return {
      ...d,
      index: d.index % rate,
      salt: message.commitment === undefined
        ? saltForSequence(message.seq)
        : saltFrom(message.commitment),
    };
  });
}

/** Open a channel. Named so a caller cannot accidentally pass a pool or sandbox root. */
export function openChannel(
  vaultRoot: Secret<typeof VAULT_DOMAIN>,
  channelId: string,
): Secret<typeof VAULT_DOMAIN> {
  return channelSecret(vaultRoot, channelId);
}

// ---------------------------------------------------------------------------
// Failures the pool does not name
// ---------------------------------------------------------------------------

/**
 * What the pool actually says, and what a person needs to hear.
 *
 * Measured against a live pool in `adversary/test/live-lifecycle.test.ts`. Re-registering a
 * viewing key fails during proof compilation, before anything reaches the chain, so there is no
 * revert reason to surface — the client gets:
 *
 *     simulated __execute__ emitted no server message; the pool did not compile the actions
 *
 * Nothing in that says "you are already registered", and a user who sees it concludes the
 * software is broken. Translation is the client's job because the pool will not do it.
 *
 * The mapping is deliberately narrow. A catch-all that turned every compilation failure into
 * "already registered" would be worse than the raw string: it would be confidently wrong, and
 * the honest answer for an unrecognised failure is to say so and show the original.
 *
 * `recipient-not-registered` came from a fresh chain. The lifecycle suite had been passing on a
 * devnet that survived several sessions, where the recipient happened to have registered at
 * some point nobody recorded; rebuilt from nothing, the transfer failed. The SDK asserts at
 * `.upstream/sdk/src/internal/compiler.ts:294` that the sender holds channel context for the
 * recipient, and the string it produces names a data structure rather than the situation. The
 * situation is that **the other person has not set themselves up and you cannot do it for
 * them** — which is the one failure here that is not the user's to fix, so saying so is the
 * whole value of the translation.
 */
export type Explained = { readonly kind: string; readonly says: string; readonly raw: string };

export function explain(error: string, context: "register" | "transfer" | "deposit"): Explained {
  const compiled = /did not compile the actions|no server message/.test(error);
  if (compiled && context === "register") {
    return {
      kind: "already-registered",
      says: "This account already has a viewing key. Keys are write-once and cannot be "
        + "replaced, so there is nothing to do — you are set up.",
      raw: error,
    };
  }
  if (/INVALID_BASE_BLOCK_NUMBER/.test(error)) {
    return {
      kind: "proof-too-fresh",
      says: "The proof was built against the current block. It needs one more block before it "
        + "can be used; try again in a moment.",
      raw: error,
    };
  }
  if (/proof.*(expired|stale)|base_block/i.test(error)) {
    return {
      kind: "proof-expired",
      says: `The proof is older than the pool's ${PROOF_VALIDITY_BLOCKS}-block window and has `
        + "to be rebuilt. Nothing was sent and nothing was spent.",
      raw: error,
    };
  }
  if (/Missing channel context for recipient/i.test(error)) {
    return {
      kind: "recipient-not-registered",
      says: "The person you are sending to has not registered a viewing key with the pool. "
        + "Nothing you can do on your side fixes this — a channel can only be opened to "
        + "someone the pool can already encrypt to, so they have to register first.",
      raw: error,
    };
  }
  if (/surplus/i.test(error)) {
    return {
      kind: "no-change-destination",
      says: "Notes cannot be partly spent, so sending less than a whole note leaves change, "
        + "and the change needs somewhere to go.",
      raw: error,
    };
  }
  // The honest default. Anything else gets the original text and an admission.
  return {
    kind: "unknown",
    says: "The pool rejected this and did not say why. The raw error is below; it is not "
      + "something you did wrong that we can name.",
    raw: error,
  };
}

/**
 * The pool's proof window, in blocks.
 *
 * Read from a live pool via `get_proof_validity_blocks` and asserted by
 * `live-lifecycle.test.ts`. `HYDRA_HANDOFF.md` Phase 2 calls this a "10-block delay", which it
 * is not: `.upstream/packages/privacy/src/privacy.cairo:833` requires only that the base block
 * is strictly before the current one, and `:835` caps the age at this number. What a client
 * must handle is the expiry, not a wait.
 */
export const PROOF_VALIDITY_BLOCKS = 450;
