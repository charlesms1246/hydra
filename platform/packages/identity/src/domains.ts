/**
 * Key domains — the whole of invariant I1, in one file.
 *
 * The pool escrows the user's private viewing key to an auditor key held in contract
 * storage, at registration, with no opt-out and no rotation
 * (`.upstream/packages/privacy/src/privacy.cairo:329-336`). So the pool is not a
 * confidentiality boundary, and vault content keys must have no derivation path to or
 * from the pool viewing key in either direction.
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
 * broken — see `platform/decisions/0001-key-domains.md`.
 */

import { hkdfSync, randomBytes } from "node:crypto";

export const POOL_DOMAIN = "hydra/pool/viewing-key/v1";
export const VAULT_DOMAIN = "hydra/vault/content-key/v1";

export type Domain = typeof POOL_DOMAIN | typeof VAULT_DOMAIN;
export const DOMAINS: readonly Domain[] = [POOL_DOMAIN, VAULT_DOMAIN];

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

/** Fresh entropy from the OS. */
export const randomEntropy = (n = 32): Entropy => randomBytes(n) as unknown as Entropy;

/**
 * Entropy the caller is asserting came from outside — a wallet signature, a hardware
 * token, the OS. Deliberately verbose to write: every call site is somewhere a person
 * had to state where the material came from.
 */
export function entropyFrom(bytes: Uint8Array, provenance: string): Entropy {
  if (bytes.length < 32) throw new Error(`${provenance}: entropy must be at least 32 bytes`);
  return bytes as unknown as Entropy;
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
 */
export function expose<D extends Domain>(secret: Secret<D>, domain: D): Uint8Array {
  return Uint8Array.from(requireDomain(secret, domain).bytes as unknown as Uint8Array);
}

/**
 * Tag a viewing key the SDK produced.
 *
 * This value is ESCROWED. At registration the pool encrypts it to the auditor key and
 * writes it through `to_write_once_action`, so it is readable by a party the user did
 * not choose and cannot replace. It must never seed anything, and the type is what
 * enforces that: a `Secret` is not `Entropy`, its bytes are not a `Uint8Array`, and
 * there is no function that converts either.
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
