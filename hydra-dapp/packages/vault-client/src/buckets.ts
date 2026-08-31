/**
 * Size buckets, applied before encryption.
 *
 * `HYDRA_HANDOFF.md` Phase 3: "size buckets applied before encryption". The order is the whole
 * point and it is easy to get backwards. AES-GCM ciphertext is the length of its plaintext
 * plus a fixed overhead, so padding *after* sealing pads a value whose true length has already
 * been fixed — the operator reads the real message length off the bucket boundary. Padding
 * first is what makes the length a bucket rather than a measurement.
 *
 * The padding has to be removable without a length field in the clear, so the plaintext is
 * prefixed with its own length inside the sealed region. A trailing marker would work too and
 * is worse: it makes the parser depend on content that an attacker chooses.
 *
 * Callers do not pad. `sealForChannel` and `publish` do it themselves, because padding that a
 * caller can forget is padding that a caller will forget — and the server can only refuse an
 * unpadded upload, never repair one: by then the true length has already been disclosed.
 */

/**
 * Powers of four from 1 KiB. Few enough that a bucket is a weak signal, spaced widely enough
 * that the overhead is bounded — the worst case is just under 4x, and the alternative (one
 * bucket for everything) costs the largest supported size on every message.
 */
export const BUCKETS: readonly number[] = [1024, 4096, 16384, 65536, 262144];

/** The 4-byte big-endian length prefix that makes padding removable. */
export const LENGTH_PREFIX = 4;

/** What AES-GCM adds after padding: a nonce in front and a tag behind. */
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const SEAL_OVERHEAD = NONCE_BYTES + TAG_BYTES;

/**
 * The bucket a message lands in, given how many bytes will be added after padding.
 *
 * `reserve` is what makes this correct for both classes. An encrypted blob gains 28 bytes of
 * nonce and tag after padding, a public one gains nothing, and padding both to the same
 * pre-seal size would put them in different buckets on the wire — which would make the class
 * readable from the length alone, after I5 went to some trouble to separate them.
 */
export function bucketFor(length: number, reserve = 0): number {
  const needed = length + LENGTH_PREFIX + reserve;
  const bucket = BUCKETS.find((b) => b >= needed);
  if (bucket === undefined) {
    throw new Error(`${length} bytes exceeds the largest bucket (${BUCKETS.at(-1)})`);
  }
  return bucket;
}

/**
 * Pad so that the value is exactly one bucket once `reserve` further bytes are added.
 *
 * The tail is zeros rather than random bytes: for the encrypted class it is about to be
 * encrypted, so it is indistinguishable from random on the wire either way, and zeros make a
 * padding bug obvious in a hex dump instead of plausible.
 */
export function padTo(plaintext: Uint8Array, reserve: number): Uint8Array {
  const out = new Uint8Array(bucketFor(plaintext.length, reserve) - reserve);
  new DataView(out.buffer).setUint32(0, plaintext.length, false);
  out.set(plaintext, LENGTH_PREFIX);
  return out;
}

/** Recover the plaintext. Throws rather than returning garbage on a corrupt length. */
export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < LENGTH_PREFIX) throw new Error("padded body is too short to hold a length");
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
  if (length > padded.length - LENGTH_PREFIX) {
    throw new Error(`declared length ${length} exceeds the body`);
  }
  return padded.slice(LENGTH_PREFIX, LENGTH_PREFIX + length);
}
