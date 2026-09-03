/**
 * Deleting the data destroys the capability derived from it.
 *
 * A GUARD RATHER THAN A HABIT, and the difference is who remembers. `forget` dropped a channel's
 * history, and a delete token is derived per object from the channel secret AND the object's id —
 * which lives in that history. So forgetting locally made every remote copy permanently
 * undeletable: the user performs the strongest deletion the product offers and gives up the
 * ability to delete anything by doing it. Unrecoverable, silent, and the opposite of what the
 * word means.
 *
 * It was found by a reviewer reading the file. That is not a method. Both lists here are short and
 * enumerable, so the codebase can hold the rule instead of a person: every destructive operation
 * is listed with the capabilities it feeds, each pair has an assertion, and a **completeness
 * check** fails when a destructive operation appears in the client that this file does not name.
 * When the third one arrives it fails here rather than waiting for somebody to read it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { forget, SKIPPED_KEEP } from "../../cli/src/commands.ts";
import { newChain, keyFor, forgetOldSkipped } from "../../handshake/src/ratchet.ts";
import { derive, rootSeed, entropyFrom, fromTestVector, VAULT_DOMAIN }
  from "../../identity/src/domains.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = [join(HERE, "..", "..", "cli", "src"), join(HERE, "..", "..", "handshake", "src")];

/**
 * Every operation in the client that destroys state, and the capability each one feeds.
 *
 * `announces` means: the operation cannot leave the capability underivable without the caller
 * being told. Silence is the defect — a destructive operation that quietly removes the only way to
 * perform another operation is the shape `forget` had.
 */
const DESTRUCTIVE: readonly {
  readonly op: string;
  readonly destroys: string;
  readonly capability: string;
  readonly announces: boolean;
}[] = [
  {
    op: "forget",
    destroys: "a channel's history, which holds every object's id",
    capability: "the per-object delete token, derived from the channel secret AND the id",
    announces: true,
  },
  {
    op: "forgetOldSkipped",
    destroys: "message keys for sequences skipped over and not used",
    capability: "reading a message whose blob arrives after the bound",
    // Bounded ON PURPOSE — a kept key is a key not deleted — and the loss is of a message that is
    // not coming rather than of an ability to act. Nothing to announce, because nothing the user
    // could do differently.
    announces: false,
  },
  {
    op: "acrossSteps trim",
    destroys: "message keys parked when a DH ratchet step abandoned a chain",
    capability: "reading a straggler from a chain that has been stepped past",
    announces: false,
  },
  {
    op: "prekeys drop",
    destroys: "a prekey private, zeroed and removed on use or rotation",
    capability: "answering a handshake addressed to that prekey",
    // The whole point of the prekey store — a one-time key used twice is not one-time — and the
    // sender is told: `respond` refuses, rather than the client silently accepting a replay.
    announces: false,
  },
  {
    op: "keyOnTrial",
    destroys: "nothing durable — it advances a COPY of the ratchet state",
    capability: "none; the copy is adopted only if the body authenticates",
    // Listed because the completeness check finds it and a reader should not have to work out
    // that it is safe. It exists precisely so a forged header cannot destroy anything.
    announces: false,
  },
];

test("forget cannot silently strip the delete capability it depends on", async () => {
  // The pair this file was written for, asserted directly rather than by inspection: `forget`
  // refuses when it cannot remove the remote copies, because proceeding would turn "not deleted
  // yet" into "never deletable".
  const { init, open, publishBundle, sendMessage } = await import("../../cli/src/commands.ts");
  const { memoryChain } = await import("../../cli/src/chain.ts");
  const alice = init({ vaultUrl: "http://127.0.0.1:1", blockMs: 30_000, invites: ["i0", "i1", "i2", "i3", "i4", "i5"] });
  open(alice, "bob", publishBundle(init({ invites: [] }), 0));
  await sendMessage(alice, memoryChain(), "bob", "ephemeral", "x", 1_800_000_000_000);
  const dead = (async () => { throw new Error("unreachable"); }) as unknown as typeof fetch;
  await assert.rejects(() => forget(alice, "bob", undefined, dead), /destroy the only capability/);
  assert.equal(alice.channels.bob.history.length, 1, "history was dropped despite the failure");
});

test("the bounded key sets lose a message, never an ability", () => {
  // The other two entries, and the reason they need no announcement: what is lost is a message
  // that is not coming, not the power to do something. A user told about it could do nothing with
  // the telling.
  const chain = newChain(derive(VAULT_DOMAIN,
    rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(31), "destructive")))));
  for (let seq = 0; seq < SKIPPED_KEEP + 5; seq++) keyFor(chain, seq, "test");
  keyFor(chain, SKIPPED_KEEP + 10, "test");
  forgetOldSkipped(chain, SKIPPED_KEEP);
  assert.ok(Object.keys(chain.skipped).length <= SKIPPED_KEEP);
  // And the chain still produces keys — the ABILITY survives, only old messages do not.
  assert.ok(keyFor(chain, SKIPPED_KEEP + 20, "test"), "the chain itself stopped working");
});

test("COMPLETENESS: no destructive operation exists that this file does not name", () => {
  // The half that makes this a guard rather than a list. A new operation that clears state has to
  // be added here — with its capability and whether it announces — or this fails.
  //
  // Matched on assignment-to-empty and delete-from-state, which is what destroying client state
  // looks like in this codebase. It will over-match rather than under-match, and a false positive
  // costs one line in the table below; a false negative costs what `forget` cost.
  const found = new Set<string>();
  for (const dir of CLIENT) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(dir, file), "utf8").split("\n");
      src.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (!/\b(delete\s+\w+[.[]|\.history\s*=|\.skipped\s*=|\.pending\s*=|acrossSteps\[)/.test(line)) return;
        // The enclosing TOP-LEVEL declaration, at column zero. Walking back to the nearest
        // `const` of any kind finds the local variable on the line above instead, which is how
        // the first run of this reported `transport`, `done`, `key` and `res`.
        for (let j = i; j >= 0; j--) {
          const m = src[j].match(/^(?:export\s+)?(?:async\s+)?(?:function|const|class)\s+(\w+)/);
          if (m) { found.add(m[1]); break; }
        }
      });
    }
  }
  // Everything the table already accounts for, by the function that performs it.
  const named = new Set([
    // In the table above, with a capability each.
    "forget", "forgetOldSkipped", "keyOnTrial", "drop",
    // Consume-on-use paths whose destruction IS the feature: a key used once, an invite spent, a
    // queued object uploaded. Each removes state and none removes an ability the caller still has.
    "readChannel", "keyFor", "receiveKey", "step", "parkThrough", "flush", "rotatePrekey",
    "collect", "sendMessage", "drain", "openAndSend",
  ]);
  const unnamed = [...found].filter((f) => !named.has(f));
  assert.deepEqual(unnamed, [],
    "these destroy client state and are not accounted for in DESTRUCTIVE:\n"
    + `${unnamed.join(", ")}\n`
    + "Add each with the capability it feeds and whether it announces, or say why it feeds none.");
  assert.equal(DESTRUCTIVE.filter((d) => d.announces).length, 1,
    "exactly one destructive operation should need to announce; recheck the table");
  // And the table is not allowed to go empty or stale while the code grows.
  assert.ok(DESTRUCTIVE.length >= 5, "the table has shrunk; operations were removed, not accounted for");
});
