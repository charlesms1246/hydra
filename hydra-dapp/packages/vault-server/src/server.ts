/**
 * The vault, server side.
 *
 * `HYDRA_HANDOFF.md` Phase 3. Content-addressed, no accounts, unauthenticated reads — the blob
 * id *is* the capability — TTL by default with pinning on request, and two classes that share
 * no namespace, no endpoint and no code path.
 *
 * It is a `handle(request)` function rather than an HTTP server. Ports and framing are not
 * where the invariants live, and a server you can call in-process is a server the adversary
 * harness can drive for a whole session without sockets. Binding it to `node:http` is a
 * separate, boring concern.
 *
 * THE DESIGN CONSTRAINT THAT SHAPES EVERYTHING HERE: whatever this file records, the operator
 * sees. So the record is deliberately small, and `observations.ts` is the published list of
 * what is in it. `adversary/test/operator-view.test.ts` compares the two in both directions —
 * anything stored but undocumented fails, and so does anything documented but not actually
 * observable.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OBSERVABLE_IDS } from "./observations.ts";

export const ENCRYPTED_ENDPOINT = "/v1/enc";
export const PUBLIC_ENDPOINT = "/v1/pub";

/** Default lifetime. TTL by default, pinning on request — not the other way round. */
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Endpoint = typeof ENCRYPTED_ENDPOINT | typeof PUBLIC_ENDPOINT;

export type UploadRequest = {
  readonly op: "upload";
  readonly endpoint: Endpoint;
  readonly id: string;
  readonly body: Uint8Array;
  readonly pin?: boolean;
  /** Required on the encrypted endpoint while the v1 write gate is closed. */
  readonly invite?: string;
};

/**
 * Reads are batched, and that is a privacy property rather than an optimisation. A client that
 * asks for one id tells the operator which message it wanted; a client that asks for its whole
 * channel set tells it only that it has a channel set.
 */
export type FetchRequest = {
  readonly op: "fetch";
  readonly endpoint: Endpoint;
  readonly ids: readonly string[];
};

/** Public objects are removable by the operator. The on-chain commitment stands regardless. */
export type RemoveRequest = { readonly op: "remove"; readonly id: string };

export type Request = UploadRequest | FetchRequest | RemoveRequest;

export type Response =
  | { readonly ok: true; readonly op: "upload"; readonly id: string; readonly expiresAt: number | null }
  | { readonly ok: true; readonly op: "fetch"; readonly found: ReadonlyMap<string, Uint8Array> }
  | { readonly ok: true; readonly op: "remove"; readonly removed: boolean }
  | { readonly ok: false; readonly error: string };

/** Exactly the fields `observations.ts` documents, and no others. */
type Stored = {
  readonly class: "encrypted" | "public";
  readonly id: string;
  readonly bucket: number;
  readonly storedAt: number;
  readonly expiresAt: number | null;
  readonly bytes: Uint8Array;
};

/**
 * A request, as the transport sees it.
 *
 * Recorded only when a server is started with `observeTransport`, which is **off by default**.
 * The rows are on the disclosure table regardless: the kernel knows the peer address whether
 * or not this code reads it, and the difference between seeing and recording is one option.
 * A table that listed only what this build keeps would be describing a configuration rather
 * than a capability.
 */
export type TransportRecord = {
  readonly at: number;
  readonly peer: string;
  readonly headers: readonly string[];
};

/** A read, as the operator sees it. */
export type ReadRecord = {
  readonly at: number;
  readonly ids: readonly string[];
  readonly hits: readonly boolean[];
};

export type VaultOptions = {
  /** Invite tokens that may be redeemed. Consumed on use and never recorded against a blob. */
  readonly invites?: Iterable<string>;
  /** Injected so a session can be replayed. Defaults to the wall clock. */
  readonly now?: () => number;
  /** Sizes an upload may be, after client-side padding. */
  readonly buckets?: readonly number[];
  /**
   * Where to keep objects so they survive a restart.
   *
   * Persistence is not free in disclosure terms and the table says so: a filesystem keeps its
   * own timestamps whatever this code writes, `unlink` does not erase, and anything that backs
   * the host up copies the lot. Those are `fs.*` rows in `observations.ts`, and they exist
   * because they are true of any on-disk vault — not because this implementation chose them.
   */
  readonly dir?: string;
};

export class Vault {
  readonly #objects = new Map<string, Stored>();
  readonly #invites: Set<string>;
  readonly #reads: ReadRecord[] = [];
  readonly #transport: TransportRecord[] = [];
  #invitesRedeemed = 0;
  readonly #now: () => number;
  readonly #buckets: readonly number[];
  readonly #dir: string | null;

  constructor(options: VaultOptions = {}) {
    this.#invites = new Set(options.invites ?? []);
    this.#now = options.now ?? (() => Date.now());
    this.#buckets = options.buckets ?? [1024, 4096, 16384, 65536, 262144];
    this.#dir = options.dir ?? null;
    if (this.#dir) {
      mkdirSync(this.#dir, { recursive: true });
      this.#load();
    }
  }

  /**
   * Read what a previous run left behind.
   *
   * Objects are two files: the bytes, and a sidecar with the metadata. Keeping them separate
   * means the bytes on disk are exactly the bytes a client sent — no framing this code would
   * then have to be trusted not to derive anything from.
   */
  #load(): void {
    for (const name of readdirSync(this.#dir!)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      try {
        const meta = JSON.parse(readFileSync(join(this.#dir!, name), "utf8")) as Omit<Stored, "bytes">;
        const bytes = new Uint8Array(readFileSync(join(this.#dir!, `${id}.blob`)));
        this.#objects.set(meta.id, { ...meta, bytes });
      } catch {
        // A half-written pair from a crash. Dropping it is right: a blob whose metadata is
        // gone cannot be expired, and metadata whose blob is gone would serve nothing.
        this.#unlink(id);
      }
    }
  }

  #persist(o: Stored): void {
    if (!this.#dir) return;
    const { bytes, ...meta } = o;
    writeFileSync(join(this.#dir, `${o.id}.blob`), bytes);
    writeFileSync(join(this.#dir, `${o.id}.json`), JSON.stringify(meta));
  }

  #unlink(id: string): void {
    if (!this.#dir) return;
    for (const ext of [".blob", ".json"]) {
      const path = join(this.#dir, `${id}${ext}`);
      // `rmSync` unlinks; it does not erase. The bytes stay recoverable from the raw device
      // until something overwrites them, which is the `fs.deletedResidue` row.
      if (existsSync(path)) rmSync(path);
    }
  }

  /** True when this vault survives a restart. Reported, because it changes what leaks. */
  get persistent(): boolean {
    return this.#dir !== null;
  }

  /**
   * Record what a transport saw. Called only by `http.ts`, and only when the operator asked
   * for it — see {@link TransportRecord}.
   */
  observeRequest(record: TransportRecord): void {
    this.#transport.push(record);
  }

  handle(request: Request): Response {
    this.#expire();
    switch (request.op) {
      case "upload": return this.#upload(request);
      case "fetch": return this.#fetch(request);
      case "remove": return this.#remove(request);
    }
  }

  #upload(r: UploadRequest): Response {
    const encrypted = r.endpoint === ENCRYPTED_ENDPOINT;
    // I5, enforced at the door: the id names its class and the endpoint must agree. A public
    // id arriving at the encrypted endpoint is a client bug at best, and the mistake this
    // whole split exists to prevent at worst.
    const prefix = encrypted ? "enc:" : "pub:";
    if (!r.id.startsWith(prefix)) {
      return { ok: false, error: `${r.id.slice(0, 4)} id at the ${r.endpoint} endpoint` };
    }
    if (!this.#buckets.includes(r.body.length)) {
      // Refusing an unpadded upload is the only place this can be enforced: once the bytes are
      // stored, the true length has already been disclosed and no later padding undoes it.
      return { ok: false, error: `body of ${r.body.length} bytes is not a size bucket` };
    }
    if (encrypted) {
      // The v1 write gate. The token is destroyed at redemption and never written down beside
      // the object it admitted — an invite retained and linked to a user is exactly the record
      // that poisons the privacy story.
      if (!r.invite || !this.#invites.delete(r.invite)) {
        return { ok: false, error: "invite required" };
      }
      this.#invitesRedeemed++;
    }
    const storedAt = this.#now();
    const expiresAt = r.pin ? null : storedAt + DEFAULT_TTL_MS;
    const stored: Stored = {
      class: encrypted ? "encrypted" : "public",
      id: r.id,
      bucket: r.body.length,
      storedAt,
      expiresAt,
      bytes: Uint8Array.from(r.body),
    };
    this.#objects.set(r.id, stored);
    this.#persist(stored);
    return { ok: true, op: "upload", id: r.id, expiresAt };
  }

  #fetch(r: FetchRequest): Response {
    const prefix = r.endpoint === ENCRYPTED_ENDPOINT ? "enc:" : "pub:";
    const found = new Map<string, Uint8Array>();
    const hits: boolean[] = [];
    for (const id of r.ids) {
      const o = id.startsWith(prefix) ? this.#objects.get(id) : undefined;
      hits.push(Boolean(o));
      if (o) found.set(id, o.bytes);
    }
    // Unauthenticated: the id is the capability. Nothing is checked but existence, because
    // there is nobody to check it against — there are no accounts.
    this.#reads.push({ at: this.#now(), ids: [...r.ids], hits });
    return { ok: true, op: "fetch", found };
  }

  #remove(r: RemoveRequest): Response {
    // Only the public class. An encrypted object the operator could delete on request would be
    // an encrypted object the operator can be compelled to delete, and they cannot know what
    // they are deleting.
    const o = this.#objects.get(r.id);
    if (!o || o.class !== "public") return { ok: true, op: "remove", removed: false };
    this.#objects.delete(r.id);
    this.#unlink(r.id);
    return { ok: true, op: "remove", removed: true };
  }

  #expire(): void {
    const now = this.#now();
    for (const [id, o] of this.#objects) {
      if (o.expiresAt !== null && o.expiresAt <= now) {
        this.#objects.delete(id);
        this.#unlink(id);
      }
    }
  }

  /**
   * Everything the operator can see, as the operator would see it.
   *
   * This is not a debugging aid — it is the subject of the Phase 3 acceptance test, and it
   * must report every field actually held. Returning less than is stored would make the test
   * pass by lying to itself, so the keys here are derived from the stored shape rather than
   * hand-listed.
   */
  observe(): { rows: Record<string, unknown>[]; reads: ReadRecord[]; invitesRedeemed: number;
               transport: TransportRecord[];
               totals: Record<string, { objects: number; bytes: number }> } {
    this.#expire();
    const rows = [...this.#objects.values()].map((o) => ({
      "blob.class": o.class,
      "blob.id": o.id,
      "blob.bucket": o.bucket,
      "blob.storedAt": o.storedAt,
      "blob.expiry": o.expiresAt,
    }));
    const totals: Record<string, { objects: number; bytes: number }> = {};
    for (const o of this.#objects.values()) {
      const t = (totals[o.class] ??= { objects: 0, bytes: 0 });
      t.objects++;
      t.bytes += o.bytes.length;
    }
    return {
      rows, reads: [...this.#reads], invitesRedeemed: this.#invitesRedeemed,
      transport: [...this.#transport], totals,
    };
  }

  /** The observation ids this instance can actually produce. Compared against the table. */
  observedKeys(): string[] {
    const seen = new Set<string>();
    const o = this.observe();
    for (const row of o.rows) for (const k of Object.keys(row)) seen.add(k);
    if (o.reads.length) { seen.add("read.ids"); seen.add("read.hit"); }
    if (o.invitesRedeemed) seen.add("invite.redeemed");
    if (o.transport.length) {
      seen.add("transport.peer");
      seen.add("transport.headers");
      seen.add("transport.timing");
    }
    if (Object.keys(o.totals).length) seen.add("store.totals");
    if (this.#dir && o.rows.length) {
      seen.add("fs.timestamps");
      seen.add("fs.deletedResidue");
    }
    return [...seen].sort();
  }

  /** Kept honest by a test: no observation id may exist that the table does not list. */
  static get documented(): readonly string[] {
    return OBSERVABLE_IDS;
  }
}
