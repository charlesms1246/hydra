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
 *
 * **WHAT THIS TABLE CANNOT CATCH: a destructive OMISSION.** It enumerates operations and checks
 * each against the capability it removes — so something destructive that is not an operation is
 * invisible to it by construction, not by oversight.
 *
 * The instance that showed this: **forgetting the passphrase will destroy every conversation
 * irreversibly**, because the seed regenerates every channel key ever agreed. It is the most
 * destructive thing a user can do to themselves, it has no confirmation, and there is no row here
 * because there is no operation to name. `decisions/0040` §5 treats making it one as the fix —
 * named, with the consequence stated at the moment the passphrase is set rather than in
 * documentation nobody reads at that moment.
 *
 * So a review question this file cannot ask for you: **is there a way to lose something that is
 * not an operation?**
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { codeOf, statementsOf } from "../src/prose.ts";

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
    op: "lock",
    destroys: "nothing on its own — and it CREATES a way to lose everything, which is why it is "
      + "here. `decisions/0040` §5: forgetting the passphrase destroys every conversation "
      + "permanently, because the seed regenerates every channel key ever agreed. That was an "
      + "OMISSION rather than an operation, invisible to this table by construction, until it "
      + "became one",
    capability: "the passphrase, which exists only in the user's head and in whatever they wrote "
      + "down. Nothing here holds a copy and nothing can: a recovery path that did not need it "
      + "would be a second way in, and one held anywhere else would be escrow",
    announces: true,
  },
  {
    op: "unlock",
    destroys: "the protection, not the data — it writes the root key and every message back to "
      + "disk in the clear",
    capability: "none; it removes one rather than spending one. Behind `--force`, and it prints "
      + "what it is removing rather than reporting success, because turning a protection off "
      + "should not read like turning a setting on",
    announces: true,
  },
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
    // NAMED BY THE IDENTIFIER, not by a phrase. These two read "acrossSteps trim" and "prekeys
    // drop", which is what a person would call them and not what the completeness scan finds — so
    // the accounted-for list had to repeat the identifiers beside the table, and the two could
    // disagree. The description belongs in `destroys`, which is where somebody reads it anyway.
    op: "parkThrough",
    destroys: "message keys parked when a DH ratchet step abandoned a chain",
    capability: "reading a straggler from a chain that has been stepped past",
    announces: false,
  },
  {
    op: "drop",
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
      // STATEMENTS ONLY. This looks for `delete x.y` and assignments that clear state, and it
      // matched the sentence "do not delete it. A partial write…" inside an error message —
      // seventh time in this repo that prose has broken a guard about code, and the first where
      // the prose was a string literal rather than a comment. See `prose.ts`.
      // TWO VIEWS OF THE SAME FILE, and needing both is the `codeOf` / `statementsOf` fork in
      // practice. DETECTION uses statements with strings stripped, so the sentence "do not delete
      // it" in an error message cannot match a `delete x.y` pattern. ATTRIBUTION uses strings
      // intact, because `case "unlock":` IS a string literal — stripping it left `case "":` and
      // the walk-back sailed past every case label to the nearest const, reporting `die`.
      const raw = readFileSync(join(dir, file), "utf8");
      const src = statementsOf(raw).split("\n");
      const named = codeOf(raw).split("\n");
      src.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (!/\b(delete\s+\w+[.[]|\.history\s*=|\.skipped\s*=|\.pending\s*=|acrossSteps\[)/.test(line)) return;
        // The enclosing TOP-LEVEL declaration, at column zero. Walking back to the nearest
        // `const` of any kind finds the local variable on the line above instead, which is how
        // the first run of this reported `transport`, `done`, `key` and `res`.
        // A `case "x":` COUNTS AS AN ENCLOSING SCOPE, and without that every destructive
        // statement inside `cli.ts`'s switch was attributed to whichever top-level `const`
        // happened to sit above the switch — the first run after `unlock` landed reported `die`,
        // the error handler, because that was the nearest declaration. An operation misattributed
        // to an unrelated name is a row nobody can check.
        for (let j = i; j >= 0; j--) {
          const c = named[j]?.match(/^\s*case "([a-z-]+)":/);
          if (c) { found.add(c[1]); break; }
          const m = named[j]?.match(/^(?:export\s+)?(?:async\s+)?(?:function|const|class)\s+(\w+)/);
          if (m) { found.add(m[1]); break; }
        }
      });
    }
  }
  // Everything the table already accounts for, by the function that performs it.
  const named = new Set([
    // DERIVED FROM THE TABLE, not repeated beside it. This list held "forget, forgetOldSkipped,
    // keyOnTrial, drop" as literals, so adding a row above required editing here too and the two
    // could disagree — the parallel-implementation shape, in a guard.
    ...DESTRUCTIVE.map((d) => d.op),
    // Consume-on-use paths whose destruction IS the feature: a key used once, an invite spent, a
    // queued object uploaded. Each removes state and none removes an ability the caller still has.
    "readChannel", "keyFor", "receiveKey", "step", "flush", "rotatePrekey",
    "collect", "sendMessage", "drain", "openAndSend",
  ]);
  const unnamed = [...found].filter((f) => !named.has(f));
  assert.deepEqual(unnamed, [],
    "these destroy client state and are not accounted for in DESTRUCTIVE:\n"
    + `${unnamed.join(", ")}\n`
    + "Add each with the capability it feeds and whether it announces, or say why it feeds none.");
  // NAMED, NOT COUNTED. This was `=== 1`, pinned to when `forget` was the only operation that
  // announced — so `lock` and `unlock` announcing, which is the right behaviour, broke it. A count
  // cannot say WHICH, and the thing worth holding is that announcing is a deliberate property of
  // a specific operation rather than a number that drifts up.
  assert.deepEqual(DESTRUCTIVE.filter((d) => d.announces).map((d) => d.op).sort(),
    ["forget", "lock", "unlock"],
    "the set of operations that announce changed. Announcing is right when the user loses "
    + "something they cannot get back; silence is right only when the destruction IS the feature, "
    + "as with a key used once or an invite spent.");
  // And the table is not allowed to go empty or stale while the code grows.
  assert.ok(DESTRUCTIVE.length >= 5, "the table has shrunk; operations were removed, not accounted for");
});
