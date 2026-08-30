/**
 * I5 — every route from an encrypted blob to a published one. None may compile.
 *
 * Not run. `i5-blob-separation.test.ts` type-checks this file and requires tsc to reject every
 * numbered attempt below, which is the "type-level separation that makes the mistake
 * uncompilable" half of I5's acceptance condition.
 *
 * The mistake being prevented: a private message published by accident. It cannot be un-read,
 * and the author cannot be warned, because the product does not know who they are.
 */

import {
  sealForChannel, publish, wireBytes, uploadPathFor, PUBLIC_ENDPOINT,
} from "../../vault-client/src/blobs.ts";
import { rootSeed, entropyFrom, derive, VAULT_DOMAIN, fromTestVector} from "../../identity/src/domains.ts";
import { channelSecret } from "../../channel/src/pointer.ts";

const chan = channelSecret(
  derive(VAULT_DOMAIN, rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(1), "fixture")))),
  "alice→bob",
);
const secret = sealForChannel(chan, new TextEncoder().encode("this must never be public"));
const intent = { confirmedPublicAt: "2026-08-30T00:00:00Z", reason: "fixture" };

// 1. The blunt one: hand the encrypted blob to the publisher.
publish(secret, intent);

// 2. Reach past the blob for its payload. The ciphertext is opaque, not a Uint8Array.
publish(secret.ciphertext, intent);

// 3. Launder it through the transport's byte accessor.
publish(wireBytes(secret), intent);

// 4. Relabel the class and keep everything else.
const relabelled: ReturnType<typeof publish> = { ...secret, class: "public" };

// 5. Move an encrypted id into the public namespace.
const stolenId: ReturnType<typeof publish>["id"] = secret.id;

// 6. Publish with no stated intent — publishing is an act, never a default.
publish(new Uint8Array([1, 2, 3]));

// 7. Send an encrypted blob to the public endpoint by naming the endpoint directly.
uploadPathFor(secret, PUBLIC_ENDPOINT);

export { relabelled, stolenId };
