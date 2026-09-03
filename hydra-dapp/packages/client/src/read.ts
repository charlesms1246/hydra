/**
 * Reading, without saying which message you wanted.
 *
 * `vault-server/src/observations.ts` lists `read.target` — "which specific blob a reader
 * actually wanted" — as something the operator CANNOT see, and gives the reason: "clients fetch
 * their whole channel set, so the wanted id is one of many in the batch."
 *
 * That claim had no implementation behind it. `session.ts` resolved one pointer to one blob id,
 * and the natural next line is a fetch of that one id — which discloses exactly what the row
 * says is hidden. The server accepted batches and the operator-view test built one by hand, so
 * what was actually being tested was that the *server* could take a batch, not that any
 * *client* sent one. A disclosure claim resting on client behaviour nobody wrote is the kind of
 * claim this project exists to not make.
 *
 * So reading is batched here, and the encrypted endpoint refuses anything narrower.
 *
 * THE SHAPE OF THE BATCH MATTERS. A client asks for the same set every time — every pointer it
 * has seen on chain for that channel, padded with decoys to a floor — so consecutive reads are
 * indistinguishable from each other. A batch that varied with what the reader currently wanted
 * would leak the difference between two batches, which is the same disclosure by another route.
 */

import { randomBytes } from "node:crypto";
import { MIN_READ_BATCH } from "../../vault-server/src/server.ts";
import { recoverBlobId, ID_BYTES } from "../../channel/src/pointer.ts";
import { encryptedIdFor } from "../../vault-client/src/blobs.ts";
import { VAULT_DOMAIN } from "../../identity/src/domains.ts";
import { coverBody, coverId, coverIndex, COVER_RATE, saltFrom, isCommitment } from "../../channel/src/cover.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import type { Secret } from "../../identity/src/domains.ts";

/**
 * Re-exported from the server, which owns it because the server enforces it.
 *
 * A second copy here would be a number that could drift below what the vault accepts, and the
 * drift would show up as clients being refused rather than as a weakened guarantee — which is
 * the failure that gets "fixed" by lowering the server's floor.
 */
export { MIN_READ_BATCH } from "../../vault-server/src/server.ts";

/** A pointer seen on chain, with the sequence number it was published at. */
export type SeenPointer = {
  /**
   * The commitment this message published, read off the chain event that announced it.
   *
   * REQUIRED, and it was optional. A reader always has one — `readChannel` builds these from
   * chain events and every event carries `data[1]` — so the optional shape only ever existed to
   * let a harness skip it, and what it bought was a fallback that salted cover by SEQUENCE. Two
   * devices on one identity share a sequence and do not share a commitment, so that fallback was
   * the collision `decisions/0033` closed, reachable by a field being absent.
   */
  readonly commitment: bigint; readonly seq: number; readonly pointer: Uint8Array };

/**
 * The set of ids to ask for.
 *
 * Every pointer this client has seen for the channel, resolved, plus decoys up to the floor.
 * Decoys are random ids: the vault stores content-addressed 31-byte ids, so a random one is
 * shaped exactly like a real one and simply misses. A miss is indistinguishable from a message
 * that has not been sent yet, which is what makes the padding free.
 *
 * The order is sorted rather than as-seen, so the batch does not encode the order the client
 * learned about them — which would be a rough proxy for what it is reading now.
 */
export function readSet(
  channel: Secret<typeof VAULT_DOMAIN>,
  seen: readonly SeenPointer[],
  pad: (n: number) => Uint8Array = randomBytes,
  coverRate: number = COVER_RATE,
): string[] {
  const real = seen.map((s) => `enc:${Buffer.from(recoverBlobId(channel, s.pointer, s.seq)).toString("hex")}`);

  // THE CHANNEL'S OWN DECOYS, and this is not politeness toward the cover traffic.
  //
  // A vault operator serves reads as well as writes. A real message is fetched — that is why it
  // was sent — and a decoy nobody can name is fetched by nobody, so "was this object ever asked
  // for" separated the two perfectly. `i3-read-pattern.test.ts` measured it at 1.000 before
  // this line existed: the anonymity set was not small, it was empty, and every decoy's storage
  // was spent buying nothing.
  //
  // Every bucket for every index, because a reader does not know a message's size band until it
  // has read it, and waiting to find out would mean two rounds of requests with the real ones
  // in the first. The extra ids miss, and a miss is indistinguishable from a message not yet
  // sent — the same reason the random padding below is free.
  //
  // DEDUPED BY SEQUENCE, which is not an optimisation. A caller may pass the same seq many
  // times — `cli/src/commands.ts` pairs every chain event with every plausible sequence number,
  // because a pointer says which channel it belongs to only to whoever holds the key. A decoy's
  // index depends on the sequence alone, so generating them per candidate PAIR multiplied the
  // request by the number of events and pushed it past the vault's body limit. The failure was
  // "body too large", which names the symptom.
  // DEDUPED BY COMMITMENT, which used to be by sequence, and the change is what closes the
  // two-device collision. A decoy is salted with the commitment its message published, so the
  // recipient derives it from the chain event rather than from a sequence number that two
  // devices share. Each event carries exactly one commitment, where one sequence pairs with many
  // events — so this is not the per-candidate-PAIR blowup that pushed the request past the
  // vault's body limit; it is tighter than the version it replaces.
  //
  // An entry with no commitment is one from a caller that has no chain — the addressing-only
  // harnesses — and it falls back to the unsalted derivation so those keep measuring what they
  // were written to measure.
  const decoyIds: string[] = [];
  // The commitment where the caller has a chain, the sequence where it does not — the same
  // choice `session.cover` makes when it mints them, and the reason both ends agree.
  // A COMMITMENT FROM THE CHAIN IS SOMEBODY ELSE'S DATA, so it is checked rather than trusted.
  // `saltFrom` refuses a value that cannot be a commitment, which is correct for a sender holding
  // its own — and would be a denial of service here, because a note published with a commitment
  // of `1` would make every reader throw. An event we cannot salt has no decoys of ours under it.
  const salts = new Set(seen
    .filter((s) => isCommitment(s.commitment))
    .map((s) => saltFrom(s.commitment)));
  for (const salt of salts) {
    for (let k = 0; k < coverRate; k++) {
      for (const bucket of BUCKETS) {
        decoyIds.push(coverId(coverBody(channel, bucket, k, salt)));
      }
    }
  }

  const decoys: string[] = [];
  while (real.length + decoyIds.length + decoys.length < MIN_READ_BATCH) {
    decoys.push(`enc:${Buffer.from(pad(ID_BYTES)).toString("hex")}`);
  }
  if (process.env.HYDRA_DEBUG_READ) {
    console.error(`real=${real.length} salts=${salts.size} decoys=${decoyIds.length} pad=${decoys.length}`);
  }
  return [...new Set([...real, ...decoyIds, ...decoys])].sort();
}

/**
 * Pick one message out of a batch the client already holds.
 *
 * Separate from `readSet` on purpose: selection happens after the fetch, on the client, so the
 * server never learns which of the returned blobs was the interesting one. A function that
 * fetched and selected in one step would be one refactor away from fetching only the selected
 * id, and that refactor would pass every test that does not exist to stop it.
 */
export function select(
  batch: ReadonlyMap<string, Uint8Array>,
  channel: Secret<typeof VAULT_DOMAIN>,
  wanted: SeenPointer,
): Uint8Array | null {
  const id = `enc:${Buffer.from(recoverBlobId(channel, wanted.pointer, wanted.seq)).toString("hex")}`;
  const bytes = batch.get(id);
  if (bytes === undefined) return null;
  // The batch is a map the VAULT built. Decryption alone would not catch a vault that filed one
  // of this channel's messages under another's id — every message in a channel opens under the
  // same key, so the substituted one decrypts to real text and the reader sees the wrong
  // message with nothing wrong. Content addressing is what binds bytes to the pointer that
  // named them, and it is only a binding if somebody checks it.
  if (encryptedIdFor(bytes) !== id) {
    throw new Error(`the vault returned bytes that are not ${id.slice(0, 12)}…; it filed a blob under an id it does not hash to`);
  }
  return bytes;
}
