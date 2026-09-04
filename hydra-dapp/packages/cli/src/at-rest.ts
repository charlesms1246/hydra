/**
 * The state file, encrypted with a passphrase — `decisions/0040`.
 *
 * `state.ts` used to say the seed was on disk in the clear, that `0600` was the only protection
 * there is, and that this was "a client for a devnet and a testnet, not for anyone whose safety
 * depends on it". The product's users are sources; publishing is in v1.
 *
 * **THE WHOLE FILE, NOT THE SEED FIELD.** The state holds every message sent or read, as text.
 * Encrypting the seed and leaving the transcript beside it protects the future and not the past,
 * and **nobody is prosecuted for the messages they were going to send.** One file, one key, no
 * partial answer — because a partial answer is worse than none, since it reads as protection.
 *
 * WHAT IT BUYS, EXACTLY, and this is the claim `claims/src/warnings.ts` generates rather than a
 * sentence anybody writes here:
 *
 *   - device seized powered off, or imaged     — **yes**, this is the case it is for
 *   - device seized running, screen locked     — **no**, the key is in memory
 *   - device seized running and unlocked       — no, and neither does anything else here
 *
 * So the honest property is "an attacker with your disk does not have your conversations", and
 * explicitly not "an attacker with your running machine".
 *
 * PARAMETERS ARE RECORDED IN THE FILE, against the version field. A file nobody can open next year
 * is not encrypted, it is lost — and writing a KDF into a file with no version is how you get a
 * client that can only read what it wrote itself. That is why state versioning landed first.
 *
 * NO DEPENDENCY. `scrypt` and AES-256-GCM are in `node:crypto`, and this client's whole dependency
 * set is two packages.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual }
  from "node:crypto";

/**
 * scrypt cost, recorded per file so these can be raised without stranding old ones.
 *
 * N = 2^16 with r = 8 is about 64 MiB and roughly a second on a laptop — chosen so that a
 * passphrase a person will actually remember still costs an attacker real money per guess. `maxmem`
 * has to be passed explicitly because node's default is 32 MiB and would refuse this outright.
 */
export const KDF_DEFAULTS = { name: "scrypt" as const, N: 1 << 16, r: 8, p: 1, keyBytes: 32 };

export type Kdf = typeof KDF_DEFAULTS & { readonly saltHex: string };

/** What is written to disk when the state is locked. Everything but the ciphertext is public. */
export type Envelope = {
  readonly version: 2;
  readonly kdf: Kdf;
  readonly nonceHex: string;
  readonly ciphertextHex: string;
  readonly tagHex: string;
};

/** True for a state file that is locked. Cheap, and does not need the passphrase. */
export const isEnvelope = (parsed: unknown): parsed is Envelope =>
  typeof parsed === "object" && parsed !== null
  && (parsed as { version?: unknown }).version === 2
  && typeof (parsed as { ciphertextHex?: unknown }).ciphertextHex === "string";

function keyFrom(passphrase: string, kdf: Kdf): Buffer {
  if (kdf.name !== "scrypt") {
    throw new Error(`this file uses the ${String(kdf.name)} key derivation and this client only `
      + "knows scrypt. Refusing to guess — use the client that wrote it.");
  }
  return scryptSync(passphrase.normalize("NFKC"), Buffer.from(kdf.saltHex, "hex"), kdf.keyBytes,
    // `maxmem` must exceed 128 * N * r or node refuses. Stated rather than tuned by trial.
    { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r });
}

/**
 * Lock a state file.
 *
 * A fresh salt per save, so two files written by one passphrase share no derived key and a change
 * to the state cannot be spotted by comparing headers.
 */
export function seal(plaintext: string, passphrase: string): Envelope {
  refusePassphrase(passphrase);
  const kdf: Kdf = { ...KDF_DEFAULTS, saltHex: randomBytes(16).toString("hex") };
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(passphrase, kdf), nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: 2,
    kdf,
    nonceHex: nonce.toString("hex"),
    ciphertextHex: body.toString("hex"),
    tagHex: cipher.getAuthTag().toString("hex"),
  };
}

/**
 * Open a locked state file, or refuse.
 *
 * GCM's tag is what makes a wrong passphrase a REFUSAL rather than plausible-looking wrong bytes.
 * Without it the client would decrypt garbage into a seed and derive a working-looking identity
 * that nobody else can talk to — a failure that surfaces as everyone else's messages not opening.
 */
export function open(envelope: Envelope, passphrase: string): string {
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(passphrase, envelope.kdf),
    Buffer.from(envelope.nonceHex, "hex"));
  decipher.setAuthTag(Buffer.from(envelope.tagHex, "hex"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertextHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Deliberately says nothing about how wrong it was. There is no hint to give that would not
    // also help somebody guessing.
    throw new Error("that passphrase does not open this state file.\n\n"
      + "THERE IS NO RECOVERY. The passphrase is the only way in — a recovery path that did not "
      + "need it would be a second way in, and one held anywhere else would be escrow. If you "
      + "wrote the phrase down, that written copy is the second copy of the secret and it is what "
      + "you need now.");
  }
}

/**
 * Refuse a passphrase that is not one.
 *
 * NOT A STRENGTH METER. A meter tells somebody their guessable phrase is "strong" once it has a
 * digit in it, which is worse than saying nothing. This refuses only what is definitely not a
 * passphrase — empty, or short enough that `scrypt`'s cost is irrelevant because the space is.
 */
export const MIN_PASSPHRASE = 12;

export function refusePassphrase(passphrase: string): void {
  const p = passphrase.normalize("NFKC");
  if (p.trim().length === 0) throw new Error("an empty passphrase locks nothing");
  if (p.length < MIN_PASSPHRASE) {
    throw new Error(`a passphrase of ${p.length} characters is short enough to enumerate whatever `
      + `the key derivation costs. Use at least ${MIN_PASSPHRASE} — several words you will `
      + "remember beat a short string you will not.");
  }
}

/** Constant time, so a wrong confirmation cannot be narrowed by timing when one is set. */
export const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a.normalize("NFKC"), "utf8");
  const y = Buffer.from(b.normalize("NFKC"), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Read a passphrase from the terminal without echoing it.
 *
 * **A PROMPT, A FILE, OR A WARNING — NEVER SILENTLY THE ENVIRONMENT.** `HYDRA_PASSPHRASE` is set
 * by `export HYDRA_PASSPHRASE=…` or by prefixing a command, and either lands in the shell history:
 * **unencrypted, on the same disk as the encrypted state file.** The seizure case is the entire
 * property this encryption buys, and that delivery hands over both halves at once.
 *
 * `authority.ts` already carries the argument, one mechanism over — *"a secret in argv is in the
 * process table and in a shell history"* — and the removal token, the compelled token and now the
 * invites all follow it. The client's own passphrase was the last secret that did not.
 *
 * Returns `null` when there is no terminal, so a caller can fall back and say why rather than
 * hanging on a pipe that will never answer.
 */
export async function promptPassphrase(what = "passphrase"): Promise<string | null> {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (on: boolean) => void };
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return null;
  process.stderr.write(`${what}: `);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    let typed = "";
    for await (const chunk of stdin) {
      for (const byte of chunk as Buffer) {
        // Enter, in both line endings a terminal might send.
        if (byte === 0x0d || byte === 0x0a) { process.stderr.write("\n"); return typed; }
        // Ctrl-C: leave without a passphrase rather than returning a partial one.
        if (byte === 0x03) { process.stderr.write("\n"); return null; }
        if (byte === 0x7f) { typed = typed.slice(0, -1); continue; }
        typed += String.fromCharCode(byte);
      }
    }
    return typed;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}
