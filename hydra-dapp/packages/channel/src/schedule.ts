/**
 * When to upload a blob, relative to the chain event that points at it — invariant I3.
 *
 * `pointer.ts` closes the value join: nothing about the published value says which blob it
 * names. It does nothing about the timing join, and the timing join is the cheap attack — a
 * vault operator that ignores the pointer bytes entirely and matches each one to the nearest
 * upload in time succeeds on every pair when the client uploads as it publishes.
 *
 * Two measurements matter, and the second corrects the first.
 *
 * A deterministic, evenly-spread jitter reaches chance at four block intervals — that is the
 * sweep in `i3-timeline-join.test.ts`, and it is the BEST case, not the real one. Sampling a
 * real uniform source (`i3-upload-schedule.test.ts`) gives, on 30s blocks and 12 messages
 * where chance is 0.083:
 *
 *     4 blocks -> 0.182     8 -> 0.135     16 -> 0.115     32 -> 0.101     48 -> 0.095
 *
 * It is asymptotic and it never arrives. Twenty-four minutes of jitter still leaves the
 * operator above chance, so "enough jitter reaches chance" is false and this module does not
 * claim it.
 *
 * WHERE THE RESIDUAL LIVES, which is the useful part. Per-message accuracy at four blocks is
 * 0.65 for the first message and ~0.11 for every other. At sixteen blocks the first is still
 * 0.32. The cause is structural: an upload cannot precede its own event, so the earliest
 * upload of a session is almost always the first message's, and no width of forward-only
 * jitter hides it. Widening the window helps the interior and barely touches message one.
 *
 * So the fix for the first message is not more jitter — it is that the first real upload must
 * not be the earliest thing the operator sees, which means cover traffic before a session
 * opens. That needs the vault server to exist and belongs with Phase 3.
 *
 * The default here is eight block intervals: interior messages within ~1.3x of chance for
 * four minutes of latency, past which the curve flattens and the cost stops buying anything.
 * The handoff says "upload jitter relative to the chain event" with no number at all, and an
 * instruction shaped like that gets implemented as five seconds — which measures identically
 * to no jitter — so a configuration below the threshold is refused rather than accepted.
 */

import { randomInt } from "node:crypto";

/**
 * Eight. Not the point where the operator reaches chance — there is no such point — but where
 * the measured curve flattens: interior messages within ~1.3x of chance, for four minutes of
 * latency. Doubling it again buys 0.02. If the sweep in `i3-upload-schedule.test.ts` moves,
 * this moves with it.
 */
export const MIN_JITTER_BLOCKS = 8;

export type ScheduleConfig = {
  /** The chain's block interval, in milliseconds. The jitter window is a multiple of it. */
  readonly blockMs: number;
  /** Multiples of `blockMs` to spread uploads across. Defaults to {@link MIN_JITTER_BLOCKS}. */
  readonly jitterBlocks?: number;
};

/** The width of the window an upload is placed in. */
export function jitterWindowMs(config: ScheduleConfig): number {
  return config.blockMs * (config.jitterBlocks ?? MIN_JITTER_BLOCKS);
}

/**
 * Reject a schedule that does not defend anything.
 *
 * A separate export because it is worth calling at start-up, where a bad configuration is a
 * refusal to run rather than a surprise on the first message.
 */
export function assertSafeSchedule(config: ScheduleConfig): void {
  if (!(config.blockMs > 0)) throw new Error("schedule: blockMs must be positive");
  const blocks = config.jitterBlocks ?? MIN_JITTER_BLOCKS;
  if (!(blocks >= MIN_JITTER_BLOCKS)) {
    throw new Error(
      `schedule: jitter of ${blocks} block intervals does not defend I3 — ` +
      `below one interval it buys nothing and at one it only halves the operator's accuracy. ` +
      `Minimum is ${MIN_JITTER_BLOCKS}, and even there the first message of a session stays ` +
      `identifiable — see channel/src/schedule.ts.`,
    );
  }
}

/**
 * When to upload, given when the chain event lands.
 *
 * Uniform over `[eventAtMs, eventAtMs + window)`. Never before the event: the pointer is on
 * chain first, so an earlier upload would mean the vault held the message before anyone could
 * have asked for it — a worse correlation than the one being defended against, and a
 * three-way one, since it also tells the operator the upload was pre-arranged.
 *
 * `random` is injectable so tests can be deterministic. The default is `crypto.randomInt`;
 * a predictable default would make every schedule reconstructible by the operator, which is
 * the whole attack.
 */
export function scheduleUpload(
  eventAtMs: number,
  config: ScheduleConfig,
  random?: () => number,
): number {
  assertSafeSchedule(config);
  const window = jitterWindowMs(config);
  const draw = random ? Math.floor(random() * window) : randomInt(window);
  return eventAtMs + Math.min(draw, window - 1);
}
