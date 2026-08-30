/**
 * I6 — every route from sandbox material to the chain. None may compile.
 *
 * Not run. `i6-sandbox-separation.test.ts` type-checks this file and requires tsc to reject
 * every numbered attempt.
 *
 * `HYDRA_HANDOFF.md` I6: the sandbox has "keys that are disposable and never touch the chain",
 * and its test requires that "sandbox key material carries a distinct type that on-chain code
 * paths refuse". Viewing keys are write-once by contract, so a key that reaches the chain from
 * a disposable context cannot be withdrawn afterwards — there is no remedy, which is why this
 * is a build failure and not a warning.
 */

import { noteCalldata } from "../../channel/src/note.ts";
import { channelSecret, pointerFor, blobIdFrom } from "../../channel/src/pointer.ts";
import type { Pointer } from "../../channel/src/pointer.ts";
import {
  SANDBOX_DOMAIN, VAULT_DOMAIN, derive, entropyFrom, rootSeed,
} from "../../identity/src/domains.ts";

const seed = rootSeed(entropyFrom(new Uint8Array(32).fill(1), "i6 fixture"));
const sandbox = channelSecret(derive(SANDBOX_DOMAIN, seed), "toy channel");
const real = channelSecret(derive(VAULT_DOMAIN, seed), "real channel");
const blobId = blobIdFrom(new Uint8Array(64));
const sandboxPointer = pointerFor(sandbox, blobId, 0);

// 1. The blunt one: put a sandbox pointer on the chain.
noteCalldata(sandboxPointer, 1n);

// 2. Strip the tag by copying the bytes. A plain Uint8Array is not a Pointer.
noteCalldata(Uint8Array.from(sandboxPointer), 1n);

// 3. Claim it is a real pointer by widening to the union.
const either: ReturnType<typeof pointerFor> = sandboxPointer;
noteCalldata(either, 1n);

// 4. Declare it as the real thing directly, rather than widening to the union as in 3.
const asReal: Pointer<typeof VAULT_DOMAIN> = sandboxPointer;

// NOT here, deliberately: `requireDomain(sandbox, VAULT_DOMAIN)`. That compiles, and should —
// it takes an untyped `Secret` on purpose, because it is the RUNTIME half of the boundary, for
// call sites the types cannot reach. It throws when it runs, which
// `i6-sandbox-separation.test.ts` asserts. A fixture that expected it to fail the build would
// be testing the opposite of the design.

// 5. Derive a "real" channel from sandbox material by relabelling the root.
const relabelled: typeof real = sandbox;

// 6. Concatenate a real pointer's brand onto sandbox bytes.
const forged: typeof sandboxPointer = Uint8Array.from(sandboxPointer);

export { asReal, relabelled, forged };
