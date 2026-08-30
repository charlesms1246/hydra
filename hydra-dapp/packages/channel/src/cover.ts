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
 * MEASURED, at the default eight-block jitter over twelve messages, with an eight-block lead:
 *
 *     rate    decoys  overhead   first message   mean
 *     0       0       0.0x       0.46            0.135
 *     1       3       0.3x       0.30            0.105
 *     2       7       0.6x       0.19            0.080
 *     4       14      1.2x       0.11            0.059
 *     6       20      1.7x       0.08            0.047
 *     8       27      2.3x       0.06            0.038
 *
 * THE TENSION, which is worth stating rather than tuning away: no rate makes both numbers
 * equal chance. At rate 2 the mean is exactly chance while the first message is still 2.3x it;
 * by the time the first message reaches chance the mean has fallen well below it. **Below
 * chance is not better.** An operator whose nearest-in-time guess is reliably wrong has learned
 * something — avoid the nearest — and can invert it. The default is rate 4 because it puts
 * both numbers within about 1.4x of chance, which is the closest either gets to carrying no
 * signal at all.
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
 * When to send decoys, covering a session that runs from its first chain event to its last.
 *
 * Times may be negative relative to `firstEventMs` — that is the lead, and it is the point.
 * A caller that clamps them to the session start has removed the defence and kept the cost.
 */
export function coverPlan(
  firstEventMs: number,
  lastEventMs: number,
  config: CoverConfig,
  random: () => number = () => randomInt(1 << 30) / (1 << 30),
): number[] {
  assertSafeSchedule(config);
  const rate = config.coverRate ?? COVER_RATE;
  if (!(rate > 0)) throw new Error("cover: a rate of zero is no cover at all");
  const window = jitterWindowMs(config);
  const start = firstEventMs - (config.leadBlocks ?? COVER_LEAD_BLOCKS) * config.blockMs;
  const end = lastEventMs + window;
  const count = Math.max(1, Math.round((rate * (end - start)) / window));
  return Array.from({ length: count }, () => start + random() * (end - start)).sort((a, b) => a - b);
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
