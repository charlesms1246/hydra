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
import { coverPlan } from "../../channel/src/cover.ts";
import { sealForChannel, wireBytes, uploadPathFor } from "../../vault-client/src/blobs.ts";
import { VAULT_DOMAIN } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

/** Everything one message produces, in the order it must happen. */
export type Outgoing = {
  readonly blobId: string;
  readonly uploadPath: string;
  readonly body: Uint8Array;
  /** Two felts for `privacy_invoke`. Publish these first. */
  readonly calldata: readonly [bigint, bigint];
  /** Wall-clock time to upload at, which is strictly after the chain event. */
  readonly uploadAt: number;
  readonly pointer: Pointer<typeof VAULT_DOMAIN>;
};

export type SessionConfig = ScheduleConfig & {
  readonly channel: Secret<typeof VAULT_DOMAIN>;
  /** The pool nullifier for this note. Binds the commitment to an identity without naming it. */
  readonly nullifier: bigint;
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
  const blob = sealForChannel(config.channel, plaintext);
  const body = wireBytes(blob) as unknown as Uint8Array;
  const pointer = pointerFor(config.channel, blobIdFrom(body), seq);
  return {
    blobId: blob.id,
    uploadPath: uploadPathFor(blob),
    body,
    calldata: noteCalldata(pointer, commit(config.nullifier, contentHashFor(plaintext))),
    uploadAt: scheduleUpload(publishedAt, config, random),
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

/** Decoy uploads for a session, so the first real one is not the earliest thing seen. */
export function cover(config: SessionConfig, firstAt: number, lastAt: number, random?: () => number) {
  return coverPlan(firstAt, lastAt, config, random);
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
