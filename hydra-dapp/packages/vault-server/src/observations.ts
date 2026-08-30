/**
 * What the vault operator can see. The published disclosure table, as data.
 *
 * `HYDRA_HANDOFF.md` Phase 3's acceptance condition: "run the server, capture everything it
 * can observe across a realistic session, assert the capture matches the published disclosure
 * table exactly. Anything observable but undocumented is a bug."
 *
 * That only works if the table is machine-readable, so it lives here rather than in prose, and
 * `adversary/test/operator-view.test.ts` compares it against a real capture in both
 * directions. Undocumented-but-observable is the bug the clause names. Documented-but-not-
 * observable is the other half and matters just as much: a table that over-claims teaches
 * people to distrust it, and then the entries that are true get ignored too.
 *
 * The standing rule this serves: privacy claims are computed, never asserted. Nothing here is
 * a promise about what the operator *would* do — it is a list of what the software puts in
 * front of them.
 *
 * Which is why the `transport.*` rows are here even though `http.ts` writes no access log. The
 * kernel knows the peer address regardless, and one changed line turns it into a record. "We
 * choose not to log it" is a promise about behaviour; the table states properties, so it lists
 * what an operator *can* see rather than what this build happens to keep.
 */

/** One thing the operator can observe, and why it is unavoidable. */
export type Observation = {
  /** Stable key. The capture is compared against these, so they are an interface. */
  readonly id: string;
  readonly what: string;
  /** Why the design cannot avoid it, or what it would cost to. */
  readonly why: string;
};

/**
 * Everything observable. Adding a field to a stored record or a log line without adding a row
 * here fails the operator-view test, which is the point of keeping it as data.
 */
export const OBSERVABLE: readonly Observation[] = [
  {
    id: "blob.class",
    what: "which of the two classes a blob belongs to — encrypted or public",
    why: "they are separate endpoints and separate namespaces by I5, so the class is the address",
  },
  {
    id: "blob.id",
    what: "the blob id, for every stored object",
    why: "content addressing: the id is what the object is stored under and is also the read capability",
  },
  {
    id: "blob.bucket",
    what: "the padded size bucket, not the true length",
    why: "the server stores bytes and can count them; bucketing before encryption is what limits this to a bucket",
  },
  {
    id: "blob.storedAt",
    what: "when the object arrived, to the second",
    why: "the server writes it down when it happens; upload jitter is what stops this joining the chain timeline",
  },
  {
    id: "blob.expiry",
    what: "when an object expires, and whether it was pinned",
    why: "TTL has to be enforced, so the deadline is stored",
  },
  {
    id: "read.ids",
    what: "the set of ids in a read request, and when",
    why: "the server has to be asked for something to return it",
  },
  {
    id: "read.hit",
    what: "whether each requested id was present",
    why: "the response says so; a miss is indistinguishable from an object that expired",
  },
  {
    id: "invite.redeemed",
    what: "that some invite was redeemed, and when",
    why: "single-use enforcement needs the token consumed; the token itself is destroyed and never linked to what follows",
  },
  {
    id: "transport.peer",
    what: "the source address of every request, once the vault is served over HTTP",
    why: "the kernel knows the peer address whether or not the server reads it; only an onion or a proxy removes it, and neither is this server's to provide",
  },
  {
    id: "transport.headers",
    what: "request headers, including whatever a client's HTTP stack adds unasked",
    why: "they arrive with the request; the server sets none of its own in reply, but it cannot unsee the ones it is sent",
  },
  {
    id: "transport.timing",
    what: "when each request arrived and how long the body took to transfer",
    why: "a socket has timing; a large upload on a slow link is visibly a large upload on a slow link",
  },
  {
    id: "rate.peerBucket",
    what: "a per-client request counter, when rate limiting is set to per-peer",
    why: "limiting per client requires knowing which client. The key is a salted hash rather than an address and the salt is per process, but within a window requests from one source are linkable to each other — the `global` mode avoids this entirely at the cost of one client being able to degrade the service for all",
  },
  {
    id: "fs.timestamps",
    what: "the filesystem's own mtime and atime on every stored object, once the vault persists to disk",
    why: "the kernel writes them whatever this code stores; atime in particular records reads that the server itself never logged, so a persistent vault discloses more than an in-memory one",
  },
  {
    id: "fs.deletedResidue",
    what: "the bytes of expired and removed objects, until something overwrites them",
    why: "unlink is not erasure. A TTL that has passed removes the object from service, not from the device, and any snapshot or backup of the host keeps it for as long as the backup exists",
  },
  {
    id: "store.totals",
    what: "the number of objects and total bytes held, per class",
    why: "it is a filesystem; anyone with the disk can count",
  },
];

export const OBSERVABLE_IDS: readonly string[] = OBSERVABLE.map((o) => o.id);

/**
 * Things the operator explicitly cannot see, asserted by the same test.
 *
 * A disclosure table that lists only what leaks reads as a confession. What makes it useful is
 * the other column — and unlike the prose version, each of these is checked against the
 * capture rather than believed.
 */
export const NOT_OBSERVABLE: readonly Observation[] = [
  {
    id: "content.plaintext",
    what: "the contents of an encrypted blob",
    why: "the server never holds a key; sealing happens client-side",
  },
  {
    id: "channel.membership",
    what: "which blobs belong to the same channel",
    why: "nothing in an upload names a channel, and reads arrive as batches over a client's whole set",
  },
  {
    id: "read.target",
    what: "which specific blob a reader actually wanted",
    why: "clients fetch their whole channel set, so the wanted id is one of many in the batch",
  },
  {
    id: "uploader.identity",
    what: "who uploaded an object",
    why: "there are no accounts, and an invite is destroyed at redemption rather than recorded against what it created",
  },
  {
    id: "blob.trueLength",
    what: "the exact byte length of a message",
    why: "padding to a bucket happens before encryption, so the true length never reaches the wire",
  },
];
