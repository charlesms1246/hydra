/**
 * I1 at the handshake — every route from pool or sandbox material into a key agreement.
 *
 * Not run. `x3dh.test.ts` type-checks this file and requires tsc to reject every numbered
 * attempt, counted by DISTINCT LINE so that one route quietly compiling cannot hide behind
 * another route producing two errors.
 *
 * The mistake being prevented is the one the whole decision turns on: a channel agreed under
 * pool material would be readable by whoever holds the escrowed auditor key, so the vault's
 * contents would be disclosed to a party the user did not choose — while every runtime check
 * still passed and the conversation still worked.
 */

import { bundleFor, initiate } from "../../handshake/src/x3dh.ts";
import { identityDh, signedPrekey, oneTimePrekey } from "../../handshake/src/keys.ts";
import {
  adoptPoolKey, derive, rootSeed, entropyFrom, fromTestVector, subKey,
  SANDBOX_DOMAIN, VAULT_DOMAIN,
} from "../../identity/src/domains.ts";

const pool = adoptPoolKey(0x1234n);
const sandbox = derive(SANDBOX_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(2), "fixture"))));
const vault = derive(VAULT_DOMAIN,
  rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(3), "fixture"))));

// 1. Publish a bundle whose keys come from the escrowed pool key.
bundleFor(pool, 0);

// 2. Agree a channel as the pool identity.
initiate(pool, bundleFor(vault, 0));

// 3. The same with a sub-key, since sub-keys carry their domain.
bundleFor(subKey(pool, "handshake"), 0);

// 4. Sandbox material — I6. Disposable keys must never reach a real conversation.
bundleFor(sandbox, 0);

// 5. And as the initiator.
initiate(sandbox, bundleFor(vault, 0));

// 6. Reach past the bundle helpers to the raw key derivations.
identityDh(pool);

// 7. A pool-domain signed prekey.
signedPrekey(pool, 0);

// 8. A sandbox one-time prekey.
oneTimePrekey(sandbox, 0);
