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
 * A thing the operator CANNOT see, and the name of the code that makes it so.
 *
 * ONE MECHANISM PER CLAIM, not per row, and the difference is a bug this shape exists to
 * prevent. `channel.membership` used to give the reason "nothing in an upload names a channel,
 * **and** reads arrive as batches over a client's whole set". The first clause was true, had a
 * mechanism, and had an assertion. The second was the disclosure written as though it were the
 * protection — a batch IS the channel's whole set — and no mechanism covered it, because the
 * guard only asked whether the ROW named one. A row with one mechanism and two claims is a row
 * with one claim proven.
 *
 * So a reason is a list, each element carrying the mechanism that proves that element.
 * `not-observable-mechanisms.test.ts` maps every mechanism to an assertion and checks the
 * mapping in both directions, per claim; and no two claims may share a mechanism, because two
 * claims resting on one assertion is the same defect in smaller print.
 */
export type Mechanism =
  | "no-key-in-server"
  | "no-channel-field"
  | "min-read-batch"
  | "client-pads-read"
  | "no-accounts"
  | "invite-destroyed"
  | "pad-before-seal"
  | "inbox-not-content-addressed"
  | "x3dh-authenticates-not-vault";

/** One clause of a reason, with the code that makes that clause true. */
export type Because = {
  readonly claim: string;
  readonly mechanism: Mechanism;
};

export type Guarantee = {
  /** Stable key. The capture is compared against these, so they are an interface. */
  readonly id: string;
  readonly what: string;
  readonly because: readonly Because[];
};

/** The reason as prose, for the generated statement. Joined, never authored as one string. */
export const whyOf = (g: Guarantee): string => g.because.map((b) => b.claim).join("; ");

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
    id: "blob.arrival",
    what: "when an unpinned object arrived, to the second — derived, not stored",
    why: "the server keeps no arrival time, but it must keep an expiry deadline to enforce a TTL, and that deadline minus a published constant IS the arrival time. Pinned objects carry no deadline and so disclose no arrival. Upload jitter is what stops either joining the chain timeline",
  },
  {
    id: "blob.expiry",
    what: "when an object expires, and whether it was pinned",
    why: "TTL has to be enforced, so the deadline is stored",
  },
  {
    id: "read.ids",
    what: "the set of ids in a read request, and when",
    why: "the server has to be asked for something in order to return it, so an operator watching the process sees every read. Writing them down is a separate choice and is off by default — the rows are here because the capability is unavoidable, not because this build retains it",
  },
  {
    id: "read.hit",
    what: "whether each requested id was present",
    why: "the response says so, and it must; a miss is indistinguishable from an object that expired or one that was never sent, which is what makes decoy padding in a read batch free",
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
    id: "read.channelSet",
    what: "which blobs form one conversation — the ids in a single read batch that exist are exactly one channel's objects",
    why: "a reader has to name what it wants, and what it wants is its channel's whole set. The uploads disclose no grouping; the READER supplies it, grouped, in one request. Padding widens the question and not the answer, because a padding id does not exist and is dropped for free. This was published as something the operator could NOT see until adversary/test/i3-batch-membership.test.ts recovered both channels of a two-channel session exactly",
  },
  {
    id: "store.totals",
    what: "the number of objects and total bytes held, per class",
    why: "it is a filesystem; anyone with the disk can count",
  },
];

export const OBSERVABLE_IDS: readonly string[] = OBSERVABLE.map((o) => o.id);

/**
 * A third category, and the reason it exists is a hole this table had.
 *
 * `OBSERVABLE` answers "what does the vault's own record show", and `operator-view.test.ts`
 * compares it against a capture of exactly that. Both were right and both were narrow: an
 * operator is not limited to the record. They can combine it with information the PROTOCOL
 * publishes, and get answers the record does not contain.
 *
 * The prekey inbox is the first thing that made this visible. Its slot ids are derived from a
 * recipient's public identity key, because a stranger must be able to write to you before you
 * share any secret. The vault stores those slots as ordinary objects and knows nothing about
 * them — so nothing in the record says "inbox" and the row would have been unproducible. But
 * an operator holding a published identity key computes the same ids anyone else does, and
 * reads the answer straight off the store.
 *
 * `given` names what the observer must already hold. A derivation with no `given` is just an
 * observation, and it belongs in the list above.
 */
export type Derivation = Observation & {
  /** Public information the observer must already have. Never a secret. */
  readonly given: string;
};

export const DERIVABLE: readonly Derivation[] = [
  {
    id: "inbox.exists",
    given: "a person's published identity key",
    what: "that this person is reachable for a first message, and how many are waiting for them",
    why: "the slot ids are a public function of the identity key, because a stranger must be able to write to you before you share any secret. Anyone who can start a conversation with you can compute them, and the operator can too. There is no version of this without accounts, and accounts would disclose more. It does NOT show who wrote, what they wrote, or which conversation it becomes",
  },
  {
    id: "inbox.activity",
    given: "a person's published identity key",
    what: "when that person's mailbox is written to, and when they collect from it",
    why: "the slots are ordinary objects, so arrival and read times are as visible as any other object's. Over time this is a usage pattern attached to one named identity, which is the sharpest thing anywhere on this table",
  },
  {
    id: "channel.author",
    given: "the blockchain, which is public",
    what: "which conversation belongs to which publishing account — by matching a channel's object count against an account's message count, with no need to link any individual upload to any individual event",
    why: "the vault's side gives a set of blobs per channel (read.channelSet) and the chain's side gives a set of events per account, and matching SETS is a different problem from matching items. Cover does not blunt it: cover is a fixed number of decoys per event, so a channel's object count is the message count times a published constant and divides back out exactly. The 0.2 figure elsewhere on this table is about matching an upload to an event, which this attack never attempts",
  },
];

export const DERIVABLE_IDS: readonly string[] = DERIVABLE.map((d) => d.id);

/**
 * Things the operator explicitly cannot see, asserted by the same test.
 *
 * A disclosure table that lists only what leaks reads as a confession. What makes it useful is
 * the other column — and unlike the prose version, each of these is checked against the
 * capture rather than believed.
 */
export const NOT_OBSERVABLE: readonly Guarantee[] = [
  {
    id: "content.plaintext",
    what: "the contents of an encrypted blob",
    because: [
      { claim: "the server holds no key, so it cannot decrypt regardless of intent",
        mechanism: "no-key-in-server" },
    ],
  },
  {
    id: "upload.channel",
    what: "which channel a blob belongs to, at the moment it is uploaded",
    because: [
      { claim: "nothing in an upload request or in the stored record names a channel",
        mechanism: "no-channel-field" },
    ],
  },
  {
    id: "read.target",
    what: "which specific blob a reader actually wanted",
    because: [
      { claim: "the encrypted endpoint refuses a read of fewer than eight ids",
        mechanism: "min-read-batch" },
      { claim: "a client asks for its whole channel set, padded to that floor, so the wanted id is one of many",
        mechanism: "client-pads-read" },
    ],
  },
  {
    id: "uploader.identity",
    what: "who uploaded an object",
    because: [
      { claim: "there are no accounts, so there is no identity for an upload to be attributed to",
        mechanism: "no-accounts" },
      { claim: "an invite is destroyed at redemption rather than recorded against what it created",
        mechanism: "invite-destroyed" },
    ],
  },
  {
    id: "blob.trueLength",
    what: "the exact byte length of a message",
    because: [
      { claim: "padding to a bucket happens before encryption, so the true length never reaches the wire",
        mechanism: "pad-before-seal" },
    ],
  },
  {
    id: "inbox.sender",
    what: "who put a prekey message in someone's mailbox",
    because: [
      { claim: "a slot is addressed by its recipient, so nothing about the sender determines where it lands",
        mechanism: "inbox-not-content-addressed" },
      { claim: "the vault authenticates nothing, so a stranger writing into a slot produces something the recipient discards rather than something the operator can attribute",
        mechanism: "x3dh-authenticates-not-vault" },
    ],
  },
];
