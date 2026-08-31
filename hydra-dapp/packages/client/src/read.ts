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
export type SeenPointer = { readonly seq: number; readonly pointer: Uint8Array };

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
): string[] {
  const real = seen.map((s) => `enc:${Buffer.from(recoverBlobId(channel, s.pointer, s.seq)).toString("hex")}`);
  const decoys: string[] = [];
  while (real.length + decoys.length < MIN_READ_BATCH) {
    decoys.push(`enc:${Buffer.from(pad(ID_BYTES)).toString("hex")}`);
  }
  return [...real, ...decoys].sort();
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
