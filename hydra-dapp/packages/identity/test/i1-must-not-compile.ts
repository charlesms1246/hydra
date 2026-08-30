/**
 * Every route from an escrowed pool key into the vault domain. NONE of these may
 * compile.
 *
 * `i1-key-domains.test.ts` runs `tsc --noEmit` over this file and fails if the errors
 * stop appearing — that is the "the cross-domain derivation test fails the build when
 * deliberately broken" condition in claude-docs/HYDRA_HANDOFF.md Phase 1.
 *
 * `@ts-nocheck` is deliberately NOT set, and this file is deliberately inside the
 * tsconfig's `include`. The errors ARE the assertion.
 */

import {
  VAULT_DOMAIN, POOL_DOMAIN, derive, rootSeed, subKey, expose, adoptPoolKey, entropyFrom,
} from "../src/domains.ts";
import { contentKey, vaultRoot } from "../src/vault-key.ts";
import type { Seed } from "../src/domains.ts";

const pool = adoptPoolKey(0x1234n);

// 1. A Secret is not a Seed.
derive(VAULT_DOMAIN, pool);

// 2. Laundering the material through the seed constructor. This is the call that would
//    silently break I1 while every runtime check still passed, and the reason
//    SecretBytes is opaque rather than a branded Uint8Array.
rootSeed(pool.bytes);

// 3. Re-declaring escrowed material as outside entropy. Two barriers now: the bytes are
//    opaque, AND entropyFrom no longer takes bytes at all.
entropyFrom(pool.bytes, "laundered");

// 3b. The route that used to compile, and is the reason `ExternalBytes` exists: read the
//     escrowed key out through the one legitimate exit, then feed it back in with an
//     honest-looking provenance string. The string was documentation; documentation does not
//     stop anything. Now there is no overload that accepts a Uint8Array.
entropyFrom(expose(pool, POOL_DOMAIN));

// 4. Forging a Seed around pool material.
const forged: Seed = { bytes: pool.bytes };
vaultRoot(forged);

// 5. A pool secret where a vault secret is required.
contentKey(pool, "blob-1");

// 6. Sub-keying in the pool domain, then using the result as a vault key. `subKey` is
//    in-domain by construction, so the domain travels with it.
contentKey(subKey(pool, "x"), "blob-1");

// 7. Reading pool material out under the vault tag.
expose(pool, VAULT_DOMAIN);

export { forged };
