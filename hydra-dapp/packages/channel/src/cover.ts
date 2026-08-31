/**
 * Cover traffic — the half of I3 that jitter cannot reach.
 *
 * `adversary/test/i3-upload-schedule.test.ts` measures a structural leak: an upload cannot
 * precede the event that announced it, so the earliest upload of a session is almost always
 * the first message's, and the operator identifies it about 0.46 of the time against a chance
 * of 0.083. Widening the jitter window barely moves that number — at sixteen block intervals
 * the first message is still identified 0.32 of the time.
 *
 * The fix is not a wider window. It is that the earliest upload the operator sees must not be
 * a real message. So a session opens with cover: indistinguishable decoy uploads, beginning
 * before the first real one and continuing throughout.
 *
 * MEASURED at the default rate of 4, against the strongest of four matchers
 * (`adversary/src/matchers.ts`), over twelve messages in four session shapes:
 *
 *     shape                       decoys   overhead   first    mean
 *     evenly spaced, 30s apart    48       4x         0.030    0.018
 *     bursts of four              48       4x         0.059    0.052
 *     Poisson, ~2min mean         48       4x         0.106    0.058
 *     one a day (isolated)        48       4x         0.214    0.197
 *
 * The last row IS the floor — 1/(rate+1) = 0.2 — and the others beat it because overlapping
 * windows merge anonymity sets. The overhead is constant because cover is per event.
 *
 * COVER IS PER BUCKET. A decoy hides a real upload only if it looks like one, and size is the
 * most visible thing about an upload. Decoys in the 1 KiB bucket do nothing for a 64 KiB
 * message: the operator simply ignores everything that is the wrong size. So each bucket in
 * use needs its own cover stream, and `coverPlan` takes the bucket it is covering.
 */

import { randomBytes, randomInt } from "node:crypto";
import { encryptedIdFor } from "../../vault-client/src/blobs.ts";
import { VAULT_DOMAIN, subKey } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";
import { assertSafeSchedule, jitterWindowMs } from "./schedule.ts";
import type { ScheduleConfig } from "./schedule.ts";

/** Decoys per jitter window. See the table above for why it is not larger. */
export const COVER_RATE = 4;

/**
 * How long before the first real message cover begins, in block intervals.
 *
 * It matters far less than the rate — the measurements move by about 0.02 between a four-block
 * and a sixteen-block lead — but it cannot be zero, or the first upload of the session is again
 * the first message's and the whole leak is back.
 */
export const COVER_LEAD_BLOCKS = 8;

export type CoverConfig = ScheduleConfig & {
  /** Decoys per jitter window. Defaults to {@link COVER_RATE}. */
  readonly coverRate?: number;
  readonly leadBlocks?: number;
};

/**
 * When to send decoys: `coverRate` of them around each chain event.
 *
 * PER EVENT, NOT PER SESSION, and the difference is the whole cost model. The first version
 * spread decoys uniformly from the first event to the last at a fixed rate per jitter window,
 * which makes the decoy count a function of session DURATION. For a conversation spanning
 * eleven days that is 15,848 decoys to carry twelve messages — 1,320x overhead, and 15 MiB of
 * someone else's disk. Every number this project published came from a five-minute session
 * where the same formula costs 1.2x, so the cost never showed up in a measurement.
 *
 * Concentrating cover around each event is affordable and, for clustered conversations, better:
 * on evenly spaced messages it scores 0.018 against the old design's 0.061. The reason it is
 * sound is that the chain has ALREADY published when each message happened — those events are
 * public and timestamped. Cover is not hiding that a message exists. It is breaking the
 * correspondence between an upload and an event, and that correspondence only lives inside a
 * jitter window. Decoys spread across the dead time between conversations defend nothing and
 * are billed anyway.
 *
 * THE GUARANTEE THIS BUYS, and it is a floor rather than a hope: an event's window contains its
 * own upload and `coverRate` decoys, so an operator picking among them is right about
 * **1/(coverRate + 1)** of the time — 0.2 at the default. Measured at 0.197 for messages a day
 * apart, which is the isolated case. When messages are close enough that their windows overlap
 * the sets merge and the operator does far worse; that is a bonus, not the guarantee.
 *
 * So the floor is a property of the RATE, and the only way to lower it is to pay: rate 9 gives
 * 0.1 for 9x storage. Choosing that is a product decision and is stated as one.
 *
 * Times may be negative relative to the first event — that is the lead, and it is the point.
 * A caller that clamps them to the session start has removed the defence and kept the cost.
 */
export function coverPlan(
  events: readonly number[],
  config: CoverConfig,
  random: () => number = () => randomInt(1 << 30) / (1 << 30),
): number[] {
  assertSafeSchedule(config);
  const rate = config.coverRate ?? COVER_RATE;
  if (!(rate > 0)) throw new Error("cover: a rate of zero is no cover at all");
  if (events.length === 0) throw new Error("cover: a session with no events needs no cover");
  const window = jitterWindowMs(config);
  const lead = (config.leadBlocks ?? COVER_LEAD_BLOCKS) * config.blockMs;
  const out: number[] = [];
  for (const at of events) {
    // Spanning [event - lead, event + window): the lead is what stops the session's earliest
    // upload being its first message, and the window is where the real upload will land.
    for (let k = 0; k < rate; k++) out.push(at - lead + random() * (lead + window));
  }
  return out.sort((a, b) => a - b);
}

/** The floor this rate buys: an operator's accuracy against an isolated message. */
export function anonymitySetFloor(config: CoverConfig): number {
  return 1 / ((config.coverRate ?? COVER_RATE) + 1);
}

/**
 * A decoy body for one bucket.
 *
 * Random bytes, sealed length. It is not encrypted under the channel key and does not need to
 * be: AES-GCM ciphertext is indistinguishable from random to anyone without the key, and the
 * operator is by construction without the key. Using the real key would be worse — it would
 * mean the decoys decrypt to something, and a client that ever tried to read one would find it.
 *
 * The `channel` argument is taken and used only to derive nothing, deliberately: it is here so
 * that a future version which *does* need the channel (say, to make decoys recognisable to the
 * recipient so they can be skipped) has the parameter already, and so that call sites read as
 * per-channel cover rather than global noise.
 */
export function coverBody(_channel: Secret<typeof VAULT_DOMAIN>, bucket: number): Uint8Array {
  return new Uint8Array(randomBytes(bucket));
}

/**
 * A decoy's id. Content-addressed like any other blob, so it is indistinguishable in the
 * namespace as well as on the wire.
 *
 * It calls `vault-client`'s own constructor rather than repeating it. A second copy of that
 * line would make decoys filterable the moment the two drifted, and nothing would fail.
 */
export function coverId(body: Uint8Array): string {
  return encryptedIdFor(body);
}

/**
 * A channel's cover sub-key.
 *
 * Reserved rather than used: decoys are random bytes today, and this exists for the version
 * where a recipient needs to recognise a decoy in order to skip it without downloading it.
 * It is in the vault domain like everything else here, so it can never be reached from a pool
 * secret.
 */
export function coverKey(channel: Secret<typeof VAULT_DOMAIN>): Secret<typeof VAULT_DOMAIN> {
  return subKey(channel, "cover traffic");
}
