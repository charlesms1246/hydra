/**
 * Key domains — the whole of invariant I1, in one file.
 *
 * The pool escrows the user's private viewing key to an auditor key held in contract
 * storage, at registration, with no opt-out
 * (`.upstream/packages/privacy/src/privacy.cairo:331-350`). So the pool is not a
 * confidentiality boundary, and vault content keys must have no derivation path to or
 * from the pool viewing key in either direction.
 *
 * An earlier draft of this header said "no rotation", which is half wrong in the
 * direction that matters. What cannot change is the USER's side: `public_key` and
 * `enc_private_key` are written with `to_write_once_action` and re-registration reverts
 * (`privacy.cairo:315-317`, `:336-350`). The AUDITOR key is rotatable by the security
 * governor (`privacy.cairo:1151-1154` calling `:1196-1204`). Rotation writes one storage
 * slot and touches no user record — and since `enc_private_key` is write-once it could
 * not re-encrypt them even if it tried — so every key escrowed before a rotation stays
 * readable by whoever held the old auditor key, forever. The escrow audience only ever
 * grows.
 *
 * Four types carry that, and the separation lives in the TYPES rather than in a
 * convention, because a convention is something you remember and a type is something
 * the build checks:
 *
 *   Entropy      raw material from outside. The only input to a seed.
 *   Seed         a root secret. Exactly one function mints one — one place to audit.
 *   Secret<D>    derived, and permanently tagged with the domain it belongs to.
 *   SecretBytes  the material inside a Secret. NOT a Uint8Array.
 *
 * That last one is the load-bearing decision, and the first draft of this file got it
 * wrong. If `Secret.bytes` is a branded `Uint8Array`, it is still assignable to
 * `Uint8Array`, so `rootSeed(entropyFrom(poolSecret.bytes, "…"))` type-checks — one
 * call that launders the escrowed key into the vault domain while every runtime check
 * still passes. Making the material opaque is what turns that into a compile error,
 * and a compile error is the "fails the build" half of the handoff's I1 acceptance
 * condition.
 *
 * The cost is that raw bytes need a way out, and `expose()` is it: one function, tag
 * checked, greppable. One escape hatch you can audit beats a boundary that leaks
 * everywhere.
 *
 * NOTE: nothing here derives a pool viewing key. The SDK does that
 * (`.upstream/client/src/viewing-key.ts:51-58`, a passphrase salted with the account
 * address). `adoptPoolKey` tags what the SDK produces on the way in. If that passphrase
 * ever also seeds `rootSeed`, every check in this file still passes and I1 is still
 * broken — see `claude-docs/decisions/0001-key-domains.md`.
 */

import { hkdfSync, randomBytes } from "node:crypto";

export const POOL_DOMAIN = "hydra/pool/viewing-key/v1";
export const VAULT_DOMAIN = "hydra/vault/content-key/v1";

/**
 * Disposable material for the sandbox — invariant I6.
 *
 * The web surfaces include "a sandbox whose keys are disposable and never touch the chain",
 * and I6's test requires that "sandbox key material carries a distinct type that on-chain code
 * paths refuse". This is that type. It is a full domain rather than a flag, so a sandbox secret
 * is not merely marked as disposable — it is cryptographically unrelated to the real one, and
 * `requireDomain` turns every existing boundary into a sandbox boundary for free.
 *
 * The refusal that matters is in `channel/src/note.ts`: what reaches the chain is a pointer,
 * and a pointer carries the domain it was derived under, so a sandbox pointer will not type-check
 * as calldata.
 */
export const SANDBOX_DOMAIN = "hydra/sandbox/disposable/v1";

export type Domain = typeof POOL_DOMAIN | typeof VAULT_DOMAIN | typeof SANDBOX_DOMAIN;
export const DOMAINS: readonly Domain[] = [POOL_DOMAIN, VAULT_DOMAIN, SANDBOX_DOMAIN];

declare const entropyBrand: unique symbol;
declare const seedBrand: unique symbol;
declare const secretBrand: unique symbol;

/** Raw key material from outside this package. The only thing a seed can be made of. */
export type Entropy = Uint8Array & { readonly [entropyBrand]: true };

/** A root secret. */
export type Seed = { readonly bytes: Uint8Array; readonly [seedBrand]: true };

/**
 * The material inside a Secret. Deliberately NOT a `Uint8Array` — see the header.
 * `expose()` is the only way to read it, and it checks the domain first.
 */
export type SecretBytes<D extends Domain> = { readonly [secretBrand]: D };

/** Key material that knows which domain it belongs to, and cannot be reseeded. */
export type Secret<D extends Domain = Domain> = {
  readonly domain: D;
  readonly bytes: SecretBytes<D>;
};

const KEY_BYTES = 32;
/** Separates the domain from the label so no label can impersonate a domain suffix. */
const SEP = "\u0000";

declare const externalBrand: unique symbol;

/**
 * Material that came from OUTSIDE this system.
 *
 * The point of the type is what it excludes. `entropyFrom` used to take a `Uint8Array` and a
 * provenance string, which meant this compiled:
 *
 * ```ts
 * rootSeed(entropyFrom(expose(sandboxSecret, SANDBOX_DOMAIN), "wallet"))
 * ```
 *
 * — key material that had been through a browser, or the pool's escrowed viewing key, becoming
 * the root of a real identity, with an honest-looking provenance string right there in the
 * call. The string was documentation, and documentation does not stop anything.
 *
 * So entropy now arrives only through the adapters below. Each names a real source, and none
 * of them accepts a value this system derived. `expose` returns a `Uint8Array`, and a
 * `Uint8Array` is no longer enough.
 */
export type ExternalBytes = {
  readonly [externalBrand]: true;
  readonly bytes: Uint8Array;
  readonly provenance: string;
};

const external = (bytes: Uint8Array, provenance: string): ExternalBytes => {
  if (bytes.length < 32) throw new Error(`${provenance}: entropy must be at least 32 bytes`);
  return { bytes: Uint8Array.from(bytes), provenance } as unknown as ExternalBytes;
};

/** The operating system's CSPRNG. */
export const fromOsRandom = (n = 32): ExternalBytes => external(randomBytes(n), "os random");

/**
 * A wallet signature over a message this system chose.
 *
 * `message` is required and recorded because of the residual risk named in
 * `claude-docs/decisions/0001-key-domains.md`: if one signature ever feeds both the SDK's
 * viewing-key derivation and `rootSeed`, every domain check still passes and I1 is still
 * broken. Naming the message at the call site is what makes "a different signature over a
 * different message" reviewable rather than remembered.
 */
export const fromWalletSignature = (signature: Uint8Array, message: string): ExternalBytes =>
  external(signature, `wallet signature over ${JSON.stringify(message)}`);

/** A hardware token or smartcard. */
export const fromHardwareToken = (bytes: Uint8Array, device: string): ExternalBytes =>
  external(bytes, `hardware token ${device}`);

/**
 * A fixed vector, for tests.
 *
 * Exported deliberately rather than hidden behind a flag: tests need reproducible seeds, and
 * the honest way to allow that is a source whose name makes it obvious in any call site that
 * the material is not real. `grep -r fromTestVector src/` over non-test code should be empty.
 */
export const fromTestVector = (bytes: Uint8Array, label: string): ExternalBytes =>
  external(bytes, `test vector ${label}`);

/**
 * Channel material delivered by a peer, inside a handshake.
 *
 * The one adapter whose material this system did not choose. `handshake/src/x3dh.ts` has the
 * initiator pick 32 random bytes and wrap them to the recipient's prekey bundle, so both sides
 * end up holding the same value and neither derived it from a root — which is the point, since
 * a channel secret either side could derive alone would be a channel secret either side's
 * compromise would reveal for every conversation they ever had.
 *
 * It is an entropy SOURCE rather than an adopt-style shortcut, so the delivered bytes are
 * stretched through `rootSeed`/`derive` like everything else and never become a `Secret`
 * directly. `peer` is recorded for the same reason `fromWalletSignature` records its message:
 * it makes "whose material is this" answerable at the call site rather than remembered.
 *
 * It cannot launder pool material. The bytes arrive out of an AES-GCM open under a key that
 * only X3DH produces, and X3DH's inputs are `Secret<VAULT_DOMAIN>` by signature.
 */
export const fromChannelWrap = (bytes: Uint8Array, peer: string): ExternalBytes =>
  external(bytes, `channel wrap from ${peer}`);

/**
 * This client's own entropy, read back off disk.
 *
 * A client that cannot be restarted is not a client, so the root has to be written down and
 * re-entered. `where` is recorded because it is the honest answer to "how well is this
 * protected" — the CLI's answer is a 0600 file and nothing else, and
 * `cli/src/state.ts` says so at the top rather than leaving it to be discovered.
 *
 * Deliberately not `fromTestVector`, which was the near-miss: it would have worked, and
 * `i1-key-domains.test.ts` greps production source for it precisely so that reaching for the
 * convenient adapter fails the build instead of putting "test vector" in the provenance of
 * every real user's root key.
 */
export const fromStoredSeed = (bytes: Uint8Array, where: string): ExternalBytes =>
  external(bytes, `stored seed at ${where}`);

/** Fresh entropy from the OS. */
export const randomEntropy = (n = 32): Entropy => entropyFrom(fromOsRandom(n));

/**
 * Entropy, from a named external source and nothing else.
 *
 * There is no overload taking raw bytes. Adding one would restore the hole this closed.
 */
export function entropyFrom(source: ExternalBytes): Entropy {
  return source.bytes as unknown as Entropy;
}

/** The one place a root secret is minted. The test asserts there is exactly one. */
export function rootSeed(entropy: Entropy): Seed {
  return { bytes: Uint8Array.from(entropy) } as unknown as Seed;
}

/** HKDF-SHA256 over a domain tag and a label. */
function kdf(ikm: Uint8Array, domain: Domain, label: string): Uint8Array {
  const info = new TextEncoder().encode(`${domain}${SEP}${label}`);
  return new Uint8Array(hkdfSync("sha256", ikm, new Uint8Array(0), info, KEY_BYTES));
}

/** Derive domain-separated key material from a root seed. */
export function derive<D extends Domain>(domain: D, seed: Seed, label = ""): Secret<D> {
  return { domain, bytes: kdf(seed.bytes, domain, label) } as unknown as Secret<D>;
}

/**
 * Derive a sub-key from an existing secret, staying inside its domain.
 *
 * In-domain by construction — it reuses `secret.domain` and never takes one — so a
 * caller cannot use it to cross the boundary, and the vault does not need to launder
 * its own root back through `entropyFrom` to scope a key per blob.
 */
export function subKey<D extends Domain>(secret: Secret<D>, label: string): Secret<D> {
  const ikm = secret.bytes as unknown as Uint8Array;
  return { domain: secret.domain, bytes: kdf(ikm, secret.domain, label) } as unknown as Secret<D>;
}

/** The runtime half of the boundary, for call sites the types cannot reach. */
export function requireDomain<D extends Domain>(secret: Secret, domain: D): Secret<D> {
  if (secret.domain !== domain) {
    throw new Error(`domain boundary: this is ${secret.domain}, and ${domain} was required`);
  }
  return secret as Secret<D>;
}

/**
 * Read the raw bytes. The only route out, and it checks the tag first.
 *
 * Every call site is a place key material becomes an ordinary array again, which is
 * where it can be logged, serialised or handed to the wrong function. Grep for it.
 *
 * `NoInfer` on the domain, and it is load-bearing. Without it TypeScript infers `D` from BOTH
 * arguments, so `expose(poolSecret, VAULT_DOMAIN)` widens `D` to the union of the two and
 * compiles — `Secret<D>` is covariant in `D`, so a pool secret satisfies `Secret<pool | vault>`
 * and the vault tag satisfies the same union. The runtime `requireDomain` caught it, but I1's
 * claim is that the type stops it, and for that call the type did not.
 *
 * It was route 7 of `i1-must-not-compile.ts`, and it had been passing because the test counted
 * type ERRORS rather than rejected routes: seven errors across eight attempts looked like eight.
 */
export function expose<D extends Domain>(secret: Secret<D>, domain: NoInfer<D>): Uint8Array {
  return Uint8Array.from(requireDomain(secret, domain).bytes as unknown as Uint8Array);
}

/**
 * Tag a viewing key the SDK produced.
 *
 * This value is ESCROWED. At registration the pool encrypts it to the auditor key and
 * writes it through `to_write_once_action`, so it is readable by a party the user did
 * not choose, and the user can neither replace it nor re-register
 * (`privacy.cairo:315-317`). Rotating the auditor key does not help either — see the
 * header. It must never seed anything, and the type is what enforces that: a `Secret` is
 * not `Entropy`, its bytes are not a `Uint8Array`, and there is no function that
 * converts either.
 */
export function adoptPoolKey(scalar: bigint): Secret<typeof POOL_DOMAIN> {
  const bytes = new Uint8Array(32);
  let v = scalar;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return { domain: POOL_DOMAIN, bytes } as unknown as Secret<typeof POOL_DOMAIN>;
}
