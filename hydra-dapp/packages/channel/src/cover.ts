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
 * The lead is not among them: see `coverLeadMs`. It is the jitter window, exactly, and that is
 * what makes the floor below a floor rather than a coincidence.
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
 * COVER IS PER BUCKET, AND THE TYPE ENFORCES IT. A decoy hides a real upload only if it looks
 * like one, and size is the most visible thing about an upload. This was a caveat in this
 * comment for a while and nothing made it true: `coverPlan` returned bare times, `coverBody`
 * took whatever bucket a caller passed, and the obvious thing to pass is the smallest one. A
 * message in any other bucket then had **no cover at all** — measured at 1.000, an operator
 * identifying it every single time, because filtering by size leaves exactly one candidate.
 *
 * So a cover plan is a list of `{at, bucket}` derived from the messages it covers. There is no
 * longer a way to ask for cover without saying what size it has to look like.
 */

import { createCipheriv, randomInt } from "node:crypto";
import { encryptedIdFor } from "../../vault-client/src/blobs.ts";
import { VAULT_DOMAIN, subKey, expose } from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";
import { assertSafeSchedule, jitterWindowMs } from "./schedule.ts";
import { P } from "./commitment.ts";
import type { ScheduleConfig } from "./schedule.ts";

/** Decoys per jitter window. See the table above for why it is not larger. */
export const COVER_RATE = 4;

/**
 * How long before its event a decoy may be sent: **exactly the jitter window**, and this is not
 * a tunable.
 *
 * The floor of 1/(rate+1) holds only when a decoy's distance from the event is distributed the
 * same way the real upload's is. The real upload lands uniformly in `[event, event+W)`. A decoy
 * lands uniformly in `[event-lead, event+W)`, and `|uniform(-W, W)|` is uniform on `[0, W)` —
 * so at `lead == W`, and only there, the two are indistinguishable by distance.
 *
 * Measured, one isolated message, nearest-to-event attack, floor 0.200:
 *
 *     lead  1 block   0.142      lead  8 blocks  0.194   <- equals the window
 *     lead  2 blocks  0.130      lead 16 blocks  0.296
 *     lead  4 blocks  0.148      lead 32 blocks  0.461
 *
 * A **longer** lead is catastrophic and sounds prudent, which is the dangerous combination: at
 * four times the window the operator is right 46% of the time, more than double the floor,
 * because decoys spread wider than the real upload so the nearest candidate is usually real.
 * A shorter lead pushes accuracy below the floor, which is not safety either — an operator
 * whose guess is reliably wrong inverts it.
 *
 * This used to be an independent constant that happened to equal `MIN_JITTER_BLOCKS`. Nothing
 * enforced the equality, and anyone widening it for margin would have halved the protection
 * silently. It is derived now, and there is no knob.
 */
export const coverLeadMs = (config: ScheduleConfig): number => jitterWindowMs(config);

export type CoverConfig = ScheduleConfig & {
  /** Decoys per jitter window. Defaults to {@link COVER_RATE}. */
  readonly coverRate?: number;
};

/** A message to be covered: when its chain event lands, and the bucket its upload will be. */
export type CoverEvent = { readonly at: number; readonly bucket: number };

/**
 * A decoy as `coverPlan` schedules it: when, and at what size. No salt yet.
 *
 * Separate from {@link Decoy} because a plan is made from times and buckets alone — it has no
 * message in front of it, so it cannot know a commitment. `session.cover` is what pairs the plan
 * back to the messages it covers and adds the salt.
 */
export type PlannedDecoy = {
  readonly at: number;
  readonly bucket: number;
  /**
   * Which decoy this is, counting from zero across the session.
   *
   * It exists so the RECIPIENT can regenerate the same bodies and ask for them. A decoy nobody
   * ever fetches is a decoy the operator identifies by that alone — see `coverBody`.
   */
  readonly index: number;
};

/** A decoy ready to mint: a planned one, plus what separates it from another message's. */
export type Decoy = PlannedDecoy & {
  /**
   * What separates this message's decoys from every other message's.
   *
   * The on-chain COMMITMENT where there is a chain, and the sequence number where there is not.
   * Both uniquely name a message to a recipient that has already read the chain event; only the
   * commitment also separates two DEVICES sharing an identity, because it descends from a random
   * blind rather than from a counter both devices keep. See `coverBody`.
   */
  readonly salt: Salt;
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
  events: readonly CoverEvent[],
  config: CoverConfig,
  random: () => number = () => randomInt(1 << 30) / (1 << 30),
): PlannedDecoy[] {
  assertSafeSchedule(config);
  const rate = config.coverRate ?? COVER_RATE;
  if (!(rate > 0)) throw new Error("cover: a rate of zero is no cover at all");
  if (events.length === 0) throw new Error("cover: a session with no events needs no cover");
  const window = jitterWindowMs(config);
  const lead = coverLeadMs(config);
  const out: PlannedDecoy[] = [];
  let index = 0;
  for (const event of events) {
    // Spanning [event - lead, event + window): the lead is what stops the session's earliest
    // upload being its first message, and the window is where the real upload will land.
    //
    // The bucket is the covered message's own. A decoy of a different size is not cover; an
    // operator filters by size before it does anything else.
    for (let k = 0; k < rate; k++) {
      out.push({
        at: event.at - lead + random() * (lead + window),
        bucket: event.bucket,
        index: index++,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The global index of one decoy: message `seq`, decoy `k`.
 *
 * ONE definition, used by the sender when it mints a decoy and by the recipient when it asks
 * for one. Two copies of this arithmetic would drift, the recipient would stop fetching some
 * decoys, and those decoys would go back to being identifiable by never being read — with
 * nothing failing. That is the same shape as the bug this indexing exists to fix.
 */
export const coverIndex = (seq: number, k: number, rate: number = COVER_RATE): number =>
  seq * rate + k;

/** The floor this rate buys: an operator's accuracy against an isolated message. */
export function anonymitySetFloor(config: CoverConfig): number {
  return 1 / ((config.coverRate ?? COVER_RATE) + 1);
}

/**
 * A decoy body for one bucket, DERIVED so the recipient can ask for it.
 *
 * It used to be `randomBytes(bucket)`, with the `channel` argument taken and deliberately
 * unused under a comment reserving it for "a future version which does need the channel". This
 * is that version, and the reason is not a refinement — it is a hole that made cover worth
 * nothing against an operator who reads their own request log.
 *
 * A vault operator serves the READS as well as the writes; `observations.ts` lists `read.ids`
 * and `read.hit` because seeing a request is forced even though recording it is a choice. A real
 * message is fetched — that is why it was sent. A random decoy is fetched by nobody, because
 * nobody can compute its id. So "was this object ever asked for" is one bit that separates the
 * two perfectly, and `i3-read-pattern.test.ts` measured the old design at **1.000**: not a
 * weakened anonymity set, an empty one.
 *
 * Deriving the body from `coverKey(channel)` gives the recipient the ids, so a decoy is fetched
 * in the same batch as everything else and the bit disappears.
 *
 * AES-CTR over zeros rather than HKDF: HKDF-SHA256 tops out at 8160 bytes and the largest
 * bucket is 262144. A keystream is indistinguishable from random without the key, which is the
 * property the old random bytes had and the only one this needs.
 *
 * THE SALT CLOSES THE TWO-DEVICE COLLISION, which `decisions/0023` recorded as unfixable.
 *
 * The argument for unfixable was that a decoy has to be regenerable by the RECIPIENT, who knows
 * the channel and the sequence and nothing about which device sent it — so any per-device salt is
 * a salt the recipient cannot compute. That is true of anything the sender picks privately. It is
 * not true of the **commitment**, which the sender puts on chain and the recipient reads off it
 * before it fetches anything.
 *
 * The commitment is `commit(blind, contentHash)` and the blind is `randomBytes` per message, so
 * two devices at the same sequence publish different commitments — and therefore mint different
 * decoys — without coordinating, without a device identifier, and without the recipient needing
 * to know a second client exists.
 *
 * THE SALT IS A BRANDED TYPE, and that took two goes to get right.
 *
 * It began optional, defaulting to the old unsalted derivation — the wrong shape for a
 * security-relevant argument, because a production call site could drop it on one branch and
 * nothing would fail; the decoys would simply go back to colliding across devices. Making it
 * required fixed that and left a second hole one level down: a plain `bigint` parameter accepts
 * `0n`, which type-checks and reads as innocuous.
 *
 * {@link Salt} closes it. The only constructors are {@link saltFrom} and {@link NO_CHAIN}, so a
 * bare literal is a type error at the call site rather than a silent regression at runtime. The
 * grep in `i3-cover-traffic.test.ts` is kept as a second layer over the sentinel's name, but the
 * load is on the type.
 */
export function coverBody(
  channel: Secret<typeof VAULT_DOMAIN>,
  bucket: number,
  index: number,
  salt: Salt,
): Uint8Array {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("a decoy index is a non-negative integer");
  }
  // THE SALT IS THE ON-CHAIN COMMITMENT, and it is what stops two devices minting the same
  // decoys. See the note on `decisions/0023`'s residual below.
  const key = expose(subKey(coverKey(channel), `body/${bucket}/${salt}`), VAULT_DOMAIN);
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(index, 12);
  const c = createCipheriv("aes-256-ctr", key, iv);
  return new Uint8Array(Buffer.concat([c.update(Buffer.alloc(bucket)), c.final()]));
}

/**
 * A decoy's id. Content-addressed like any other blob, so it is indistinguishable in the
 * namespace as well as on the wire.
 *
 * It calls `vault-client`'s own constructor rather than repeating it. A second copy of that
 * line would make decoys filterable the moment the two drifted, and nothing would fail.
 */
declare const saltBrand: unique symbol;

/**
 * What separates one message's decoys from another's — a BRANDED bigint, and the brand is the
 * point.
 *
 * A plain `bigint` parameter was the first shape and it is not enough. Requiring the argument
 * stops a call site omitting it; it does nothing about one passing `0n`, which type-checks, greps
 * clean past a search for the sentinel's name, and puts two devices back to minting the same
 * decoys — silently, because nothing about a zero looks wrong.
 *
 * So the only two ways to make a `Salt` are {@link saltFrom}, which takes a commitment off the
 * chain, and {@link NO_CHAIN}, which spells an absence. A bare literal does not type-check, and
 * the guarantee sits on the type rather than on a text search standing in for one. The grep in
 * `i3-cover-traffic.test.ts` stays as the second layer, not the first.
 */
export type Salt = bigint & { readonly [saltBrand]: true };

/**
 * The floor a real commitment is above, and the reason there is one.
 *
 * A commitment is `poseidonHashMany(...)`, uniform over the field, so the chance of a genuine one
 * landing below 2^64 is about 2^-187. Anything under it is therefore not a hash — it is a counter,
 * an index, a default, or a field that was never set. Those are the values that reach a
 * constructor by accident, and every one of them would silently weaken cover rather than fail.
 */
const COMMITMENT_FLOOR = 1n << 64n;

/**
 * The salt for a message that went on chain: its commitment.
 *
 * The commitment is `commit(blind, contentHash)` with the blind drawn per message, published by
 * the sender and read by the recipient off the same event it uses to find the blob. It is the only
 * value in this protocol that is simultaneously unpredictable to a second device on the same
 * identity and already in the recipient's hands — `decisions/0033`.
 *
 * IT REFUSES A VALUE THAT CANNOT BE A COMMITMENT, and that is the point of the function existing
 * rather than a cast at each call site.
 *
 * The brand stops a bare `0n` being written where a salt belongs. It does nothing about a
 * commitment field that is legitimately unset, defaulted, or zero-initialised flowing through the
 * honest path — and `saltFrom(0n)` was `NO_CHAIN`, indistinguishable to every layer below, so that
 * would have restored the two-device collision through the correct constructor with the correct
 * type in code nobody edited wrongly. Not hypothetical in this repo: `events()` was found dropping
 * `transaction_hash` and handing back `undefined` from a mapping that had quietly stopped
 * applying, one file over.
 *
 * So the sentinel is unreachable from here, and an accidentally-empty commitment fails loudly at
 * the boundary instead of silently disabling the defence. Refusing to send is the correct
 * response: the alternative is sending with cover that a second device can reproduce.
 */
/**
 * Whether a value could be a commitment this protocol produced.
 *
 * EXPORTED BECAUSE A READER MUST NOT THROW ON SOMEBODY ELSE'S EVENT. `saltFrom` refuses a value
 * that cannot be a commitment, which is right for the SENDER — its own commitment failing that
 * check means its own hashing is broken. It is wrong for the reader: chain events come from
 * anyone, and a note published with a commitment of `1` would make every reader's `readSet` throw.
 * That is a denial of service anyone with an account can mount for the price of one transaction.
 *
 * So a reader asks first and skips what it cannot salt. An event whose commitment could not be
 * ours has no decoys of ours under it, so there is nothing to ask the vault for.
 */
export const isCommitment = (value: bigint): boolean =>
  value >= COMMITMENT_FLOOR && value < P;

export function saltFrom(commitment: bigint): Salt {
  if (commitment < COMMITMENT_FLOOR) {
    throw new Error(
      `a commitment of ${commitment} is too small to be one — a Poseidon hash lands below 2^64 `
      + "about once in 2^187 times, so this is a counter, an index, or a field nobody set. "
      + "Salting cover with it would let a second device on this identity mint the same decoys; "
      + "see claude-docs/decisions/0033.");
  }
  if (commitment >= P) throw new Error(`a commitment must be a felt: ${commitment} is not below P`);
  return commitment as Salt;
}

/**
 * The salt for a caller that has no chain to read a commitment from.
 *
 * Only the harnesses in `adversary/` that measure cover as a size or a keystream. Making them
 * invent a commitment would be making them measure a fixture, so the absence is spelled instead.
 *
 * NEVER VALID IN PRODUCTION. Two devices sharing an identity would mint the same decoys again,
 * which is the whole of `decisions/0033`.
 */
export const NO_CHAIN = 0n as Salt;

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
