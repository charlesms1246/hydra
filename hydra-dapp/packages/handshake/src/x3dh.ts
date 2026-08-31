/**
 * X3DH — agreeing a vault channel secret with someone who is not online.
 *
 * `conversation.test.ts` used to hand bob alice's channel secret and say so in its header,
 * because `openChannel` derives from ONE party's vault root and the other party cannot compute
 * it. That stub is what this closes. It is the piece that was blocking a real two-party client.
 *
 * FOUR DIFFIE-HELLMANS, and each one is load-bearing:
 *
 *   DH1 = DH(IK_a, SPK_b)   authenticates ALICE   — only her identity key produces it
 *   DH2 = DH(EK_a, IK_b)    authenticates BOB     — only his identity key can complete it
 *   DH3 = DH(EK_a, SPK_b)   forward secrecy       — the prekey rotates and is then forgotten
 *   DH4 = DH(EK_a, OPK_b)   replay resistance     — used once, so a replayed first message dies
 *
 * Dropping any one of them loses exactly the property beside it, and `x3dh.test.ts` mutates each
 * out in turn to check that. DH4 is optional because one-time prekeys are exhaustible: a
 * recipient who has run out is still reachable, with replay resistance and nothing else lost,
 * and `sharedSecret` records which case it was rather than leaving it to be inferred.
 *
 * WHAT RIDES ALONGSIDE THE POINTER. The agreed secret is not the channel secret. The initiator
 * picks 32 random bytes, wraps them under the X3DH output, and the wrap travels in the first
 * blob — the chain still carries two felts and nothing else, so I4 is untouched. The channel
 * secret is then `derive(VAULT_DOMAIN, rootSeed(fromChannelWrap(…)))` on both sides.
 *
 * Why wrap rather than use the X3DH output directly, which would be less code: a channel secret
 * either side could derive alone is a channel secret either side's compromise reveals for every
 * conversation they ever had. Wrapping puts a value nobody's root determines in the middle, and
 * it is what lets the ratchet advance later without the vault's blob ids moving under it.
 *
 * NOT BUILT YET, and named rather than implied: nothing here delivers a prekey message. Bob has
 * to receive one before he can respond, and a mailbox the sender can address without already
 * sharing a secret is a disclosure the vault operator gets to see. That is the next piece.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { bundleFor, dh, ephemeral, identityDh, oneTimePrekey, rawPublic, signedPrekey, verifyBundle, KEY_BYTES }
  from "./keys.ts";
import type { Bundle } from "./keys.ts";
import { derive, rootSeed, entropyFrom, fromChannelWrap, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";
import type { Secret } from "../../identity/src/domains.ts";

/** The domain tag for everything derived here. Vault, never pool — see `keys.ts`. */
const X3DH_INFO = "hydra/vault/x3dh/v1";

/** Signal's F: a full-length byte string of 0xFF prefixed to the DH concatenation. */
const F = new Uint8Array(KEY_BYTES).fill(0xff);

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * What the initiator sends. Public values plus one sealed blob; none of it is secret except
 * what is inside `wrapped`, which is why it can travel in the clear.
 */
export type PrekeyMessage = {
  readonly identityKey: Uint8Array;
  readonly ephemeralKey: Uint8Array;
  readonly epoch: number;
  /** Which one-time prekey was consumed, or null when the recipient had none left. */
  readonly oneTimeIndex: number | null;
  /** The channel material, sealed under the X3DH output. */
  readonly wrapped: Uint8Array;
};

/**
 * The X3DH output, with the fact that matters kept beside it.
 *
 * `usedOneTimePrekey` is on the type rather than in a log because the difference is a real
 * change in what the handshake guarantees, and a caller that cannot see it cannot warn anyone.
 */
export type Agreed = {
  readonly secret: Uint8Array;
  readonly usedOneTimePrekey: boolean;
};

function agree(parts: readonly Uint8Array[], usedOneTimePrekey: boolean): Agreed {
  const ikm = Buffer.concat([F, ...parts.map((p) => Buffer.from(p))]);
  return {
    secret: new Uint8Array(hkdfSync("sha256", ikm, new Uint8Array(0),
      new TextEncoder().encode(X3DH_INFO), KEY_BYTES)),
    usedOneTimePrekey,
  };
}

const seal = (key: Uint8Array, plaintext: Uint8Array): Uint8Array => {
  const nonce = randomBytes(NONCE_BYTES);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  return new Uint8Array(Buffer.concat([nonce, c.update(plaintext), c.final(), c.getAuthTag()]));
};

const open = (key: Uint8Array, wrapped: Uint8Array): Uint8Array => {
  if (wrapped.length <= NONCE_BYTES + TAG_BYTES) throw new Error("wrapped material is too short");
  const d = createDecipheriv("aes-256-gcm", key, wrapped.slice(0, NONCE_BYTES));
  d.setAuthTag(wrapped.slice(wrapped.length - TAG_BYTES));
  const body = wrapped.slice(NONCE_BYTES, wrapped.length - TAG_BYTES);
  return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
};

/**
 * Turn agreed material into the channel secret, identically on both sides.
 *
 * Both sides must compute this the same way or they agree on a secret and still cannot talk, so
 * it is one function called from both `initiate` and `respond` rather than two that match
 * today. `peer` goes only into the recorded provenance, never into the key — a mismatch there
 * must not silently produce different secrets.
 */
function channelFrom(material: Uint8Array, peer: string): Secret<typeof VAULT_DOMAIN> {
  return derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromChannelWrap(material, peer))));
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * Alice's side. Needs only bob's published bundle, so bob can be offline.
 *
 * The bundle is verified here rather than by the caller: a caller who forgets loses the only
 * protection X3DH offers against a directory that swapped the prekey, and there is no path
 * through this function that skips it.
 */
export function initiate(
  myVaultRoot: Secret<typeof VAULT_DOMAIN>,
  theirBundle: Bundle,
  options: { ephemeralSeed?: Uint8Array; channelMaterial?: Uint8Array } = {},
): { message: PrekeyMessage; channel: Secret<typeof VAULT_DOMAIN>; agreed: Agreed } {
  verifyBundle(theirBundle);

  const ek = ephemeral(options.ephemeralSeed ?? new Uint8Array(randomBytes(KEY_BYTES)));
  const ik = identityDh(myVaultRoot);

  const parts = [
    dh(ik, theirBundle.signedPrekey),   // DH1 — alice is who she says
    dh(ek, theirBundle.identityKey),    // DH2 — bob is who he says
    dh(ek, theirBundle.signedPrekey),   // DH3 — forward secrecy
  ];
  if (theirBundle.oneTimePrekey) parts.push(dh(ek, theirBundle.oneTimePrekey)); // DH4 — replay

  const agreed = agree(parts, Boolean(theirBundle.oneTimePrekey));
  const material = options.channelMaterial ?? new Uint8Array(randomBytes(KEY_BYTES));
  if (material.length !== KEY_BYTES) throw new Error("channel material must be 32 bytes");

  return {
    message: {
      identityKey: rawPublic(ik),
      ephemeralKey: rawPublic(ek),
      epoch: theirBundle.epoch,
      oneTimeIndex: theirBundle.oneTimeIndex ?? null,
      wrapped: seal(agreed.secret, material),
    },
    channel: channelFrom(material, hex(theirBundle.identityKey)),
    agreed,
  };
}

/**
 * Bob's side. Recomputes the same four DHs from the other direction and unwraps.
 *
 * A message naming a one-time prekey he has already consumed is the caller's problem to
 * detect, not this function's: consumption is state, this is arithmetic, and a function that
 * quietly tracked it would put the replay defence somewhere a second instance of the client
 * would not see. `respond` reports which index was used; refusing a repeat is the caller's job
 * and `x3dh.test.ts` asserts the shape of that.
 */
export function respond(
  myVaultRoot: Secret<typeof VAULT_DOMAIN>,
  message: PrekeyMessage,
): { channel: Secret<typeof VAULT_DOMAIN>; agreed: Agreed; oneTimeIndex: number | null } {
  const spk = signedPrekey(myVaultRoot, message.epoch);
  const ik = identityDh(myVaultRoot);

  const parts = [
    dh(spk, message.identityKey),   // DH1
    dh(ik, message.ephemeralKey),   // DH2
    dh(spk, message.ephemeralKey),  // DH3
  ];
  if (message.oneTimeIndex !== null) {
    parts.push(dh(oneTimePrekey(myVaultRoot, message.oneTimeIndex), message.ephemeralKey)); // DH4
  }

  const agreed = agree(parts, message.oneTimeIndex !== null);
  // Throws on a wrong key or a tampered message, which is the authentication: only someone who
  // completed the same four DHs can produce a wrap that opens here.
  const material = open(agreed.secret, message.wrapped);
  return {
    channel: channelFrom(material, hex(message.identityKey)),
    agreed,
    oneTimeIndex: message.oneTimeIndex,
  };
}

export { bundleFor, verifyBundle };
export type { Bundle };
