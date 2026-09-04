/**
 * A MECHANISM WHOSE ONLY CALLER IS ITS OWN TEST IS UNFINISHED.
 *
 * The rule this repo arrived at after finding the same defect five times in two days, in both
 * directions — nothing reaches the mechanism, or nothing consumes what it produces:
 *
 *   - `main.ts` never passed `removalToken`, so a real vault refused every takedown while the
 *     table carried the row and the tests proved it worked (E-UNREACHABLE).
 *   - `report.filed` opened the moderation disclosure table and nothing could file a report.
 *   - `summarise` — doc: "what a reviewer is shown" — did not show the report bodies, so
 *     `BODIES_KEPT`'s whole framing-attack defence protected text nothing displayed (E-SHOWN).
 *   - `appeals.ts` took a `decisionId` that `Decision` did not carry, and its own tests invented
 *     `"decision-1"` to stand in — so convincingly that nothing failed.
 *   - **The entire public class had no client path in either direction.** An operator tool, an
 *     intake endpoint, an appeal path and a transparency report had been built for objects no user
 *     could create or read.
 *
 * **Not one was found by a test. All five were found by building the thing on the other end.**
 * Unlike the guard-shape sweeps, this one has a mechanical signature, so it is a query rather than
 * a judgement: an exported function or class that no non-test source uses.
 *
 * THREE OUTCOMES, and only the third is allowlisted:
 *
 *   1. Used by another source file — fine, and most exports are this.
 *   2. Used only inside its own file — then it must not be exported. Four were, and un-exporting
 *      them was the whole fix; a module's exports should be its actual surface.
 *   3. Used only by tests — allowlisted, WITH A REASON, below.
 *
 * WHY THE ALLOWLIST IS NOT THE HAND-KEPT LIST THAT WAS REFUSED FOR `serve()`. There, the option
 * names were *derivable from the signature*, so a hand-kept copy was a second place to forget
 * something already known — and written in that commit it would have contained exactly the options
 * already known about. Here nothing derives "intentionally internal": `fromTestVector` being a
 * named test double is a judgement, not a fact in the code. **The list IS the judgement**, so it
 * has to be written down, and each entry carries its reason inline — the same discipline as the
 * destructive-operations table. Adding a line is then a deliberate act somebody has to justify,
 * rather than a line appended to turn a red suite green.
 *
 * **A REASON MUST BE A STATEMENT ABOUT THE CODE, NOT ABOUT INTENT**, and this list has already
 * broken that rule once. The inbox group was exempted with "delivery is unbuilt by decision — see
 * `decisions/0009`". It was true of `0009` and stopped being true at `0013`, when `hydra invite`
 * began writing prekey messages into inbox slots — and nothing could ever make it *look* stale,
 * because it is a claim about a document. "an in-file helper of `deliver`" is a claim the code can
 * contradict: move the helper and the reason is visibly wrong. Prose decays; an assertion about
 * where a symbol is used decays visibly.
 *
 * A SECOND SCOPE NOTE, for the same family of mistake. The first version of this scan excluded a
 * symbol's own file when looking for callers, so four functions used only INTERNALLY read as dead
 * — deleting them would have broken the build. A search whose scope quietly encodes an assumption
 * gives a confident wrong answer, which is the same shape as a test written from the code it
 * checks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

/**
 * Exported, reached only by tests, and deliberately so. Each line is the justification.
 *
 * If you are here because the suite went red: adding a name is claiming that nothing SHOULD call
 * it outside a test. If what you actually did was build a mechanism and not wire it up, the entry
 * you are about to write is the bug.
 */
const REACHED_ONLY_BY_TESTS: Record<string, string> = {
  // Test doubles and fixtures — the caller being a test is what they are for.
  fromTestVector: "takes a caller-supplied fixed byte vector and a label; no product code path "
    + "has a fixed vector to pass it",
  memoryChain: "an in-memory Chain implementation; every product path builds one through "
    + "`chainFor(state)`, which never returns it",

  // Disclosure tables. The guards ARE the intended consumer: a table exists to be checked in both
  // directions against real captures, and nothing in the product reads its own id list.
  DERIVABLE_IDS: "the id list of the DERIVABLE table; its consumer is the guard that checks every "
    + "row has a proof, and no product code reads its own table",
  MODERATION_OBSERVABLE_IDS: "the moderation table's ids, read by its completeness guard only",
  NODE_OBSERVABLE_IDS: "the node table's ids, read by its completeness guard only",

  // Internal steps exported so a property can be checked on the step rather than only on the
  // whole. Each is used inside its own file by the function that ships.
  publicIdFor: "used by publish and openPublic in-file; exported so the derivation is checkable",
  appealStatement: "used by appealDigest in-file; exported so the signed bytes are inspectable",
  verifyRequest: "used by verifierAgainst in-file; exported so a test can inspect the RPC built — "
    + "and that inspection is what caught the selector being a name instead of a felt",
  verifyReply: "same, for the reply side; fail-closed is only a property if something checks it",
  bucketFor: "the bucket ladder's lookup, used by padTo in-file",
  isPublic: "a class predicate used in-file; exported so I5 can assert on it directly",
  shortString: "felt encoding used in-file by the commitment builder",
  pointerToFelt: "used in-file by noteCalldata; exported so the felt encoding is testable alone",
  coverKey: "used in-file by coverBody and coverId",
  contentKey: "used in-file by vaultRoot; exported so the derivation is checkable on its own",
  signerFor: "used in-file by the authorship signer",
  freshRatchetSeed: "used in-file by newDhState",
  rootBytes: "used in-file by the DH root step; exported so the root derivation is assertable",
  adoptPoolKey: "used in-file; exported so I1 can assert the adopt path exists and is domain-checked",
  components: "used in-file by links; exported so the decomposition is assertable on its own",

  // Alternative compositions kept because a test asserts a property of the whole that the shipped
  // path reaches by a different route. `linkability` is the case that produced a real finding: the
  // client's arithmetic used to be a SECOND copy, and `covering` now shares the predicate.
  linkability: "the pure one-shot crowd; the client's path is stateful and intersects across "
    + "sends, so it calls the shared `covering` predicate rather than this composition",
  regularity: "a pruning statistic used in-file by prune; exported so the rule is testable alone",
  crowdOf: "`covering().length`, used in-file by `linkability`; the client calls `covering` "
    + "directly because it needs the members rather than the count",

  // SURFACED WHEN THE SCAN STOPPED COUNTING COMMENTS AS CALLS. All three were masked by prose
  // naming them, and the reasons below are what the code says rather than what was intended.
  respond: "the derived-prekey path; `respondWith` is the only caller-facing responder and "
    + "declares its own return type from this one, so it is reachable in type position only",
  openChannel: "a named wrapper over `channelSecret` for a caller holding a vault root; the "
    + "client derives channel secrets from the X3DH agreement and never holds a channel id",
  explain: "translates upstream SDK errors for the pool's register/transfer/deposit flows, and "
    + "NOTHING IN THIS PACKAGE PERFORMS THOSE — it has no consumer here, which is recorded "
    + "rather than dressed up; see the note to review",

  // The anchor WRITE path, deliberately unwired: `hydra record` prints the felts and refuses to
  // write, because which account pays is exactly the link the record creates. The READ path used
  // to be listed here too — `bundleOf`, `readRecordCall`, `decodeRecordReply`, `assertUsableId` —
  // and `hydra lookup` wired all four up. The stale-exemption check is what said so, on the same
  // run, which is the half of this guard that stops the list decaying into permission slips.
  writeRecordCalldata: "builds calldata for the identity contract's setter; no CLI case calls it "
    + "— `hydra record` prints the felts and returns without a transaction",
  identityContract: "same group — the deployed contract address per network",
  assertUsableId: "called by `readRecordCall` in-file, which is the single place the id rule is "
    + "written; `bundleFromChain` deliberately does not repeat the check at its call site",
  feltFromShortString: "same group — network name to felt",

  // Prekey delivery, and THIS BLOCK'S FIRST REASON WAS FALSE. It said "delivery is unbuilt by
  // decision — see decisions/0009", which was true of `0009` and stopped being true at `0013`:
  // `hydra invite` writes a prekey message into an inbox slot and `hydra collect` reads it. These
  // four are in-file helpers of `deliver`/`collect` in the same module, like `coverKey`. An
  // allowlist entry justifying an exemption with a stale reason is exactly the failure this list
  // is supposed to make hard, and it survived because nobody had to re-read it.
  inboxSlot: "used in-file by deliver/collect; exported so slot derivation is checkable alone",
  inboxSlots: "used in-file by deliver/collect; exported so the slot set is assertable",
  encodePrekey: "used in-file by deliver; exported so the wire encoding is testable on its own",
  decodePrekey: "used in-file by collect; exported so a malformed slot can be tested directly",

  // Miscellaneous, each used in-file.
  LABELS: "key labels used in-file; exported so the domain separation is assertable",
  links: "used in-file by evidence; exported so a linkage claim is checkable without its prose",
};

type Found = { name: string; file: string };

function scan(): { testOnly: Found[]; internal: Found[]; dead: Found[] } {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(PACKAGES);
  const isTest = (p: string) => p.includes(`${"/"}test${"/"}`) || p.endsWith(".test.ts");
  const src = files.filter((p) => !isTest(p));
  const tests = files.filter(isTest);
  // COMMENTS STRIPPED BEFORE ANYTHING IS COUNTED AS A USE. A doc comment naming a symbol is not a
  // caller, and this scan was fooled by one the first time a file explained a past mistake by
  // name: `claims/src/warnings.ts` cites "a duplicated `assertUsableId`", and the sweep read that
  // as a second caller and declared the allowlist entry stale.
  //
  // Fifth instance in this repo of an accurate explanation breaking a guard — `grep()` in the
  // mechanism checks strips comments for exactly this reason, and a negative claim assertion
  // strips backticked spans for it too. The rule is the same in all three: **a guard must measure
  // the code, never the prose about it.**
  // BLOCK COMMENTS AND WHOLE-LINE `//` ONLY. Stripping every `//` to end of line ate the rest of
  // any line containing a URL — `http://127.0.0.1:8080` is not a comment — and that silently HID
  // real callers, which is the worse direction for this guard. A trailing comment after code is
  // left in; it is a much rarer way to name a symbol you are not calling.
  const strip = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const text = new Map(files.map((p) => [p, strip(readFileSync(p, "utf8"))]));

  const exports = new Map<string, string>();
  const decl = /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+class|class|function)\s+([A-Za-z_$][\w$]*)/gm;
  const arrow = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(?[^=]*\)?\s*(?::[^=]*)?=>/gm;
  for (const p of src) {
    // The adversary package is the test package; its own helpers are test infrastructure.
    if (p.includes(`${"/"}adversary${"/"}`)) continue;
    for (const re of [decl, arrow]) {
      re.lastIndex = 0;
      for (const m of text.get(p)!.matchAll(re)) exports.set(m[1], p);
    }
  }

  const used = (name: string, where: string[], skip?: string) =>
    where.some((p) => p !== skip && new RegExp(`\\b${name}\\b`).test(text.get(p)!));

  const testOnly: Found[] = []; const internal: Found[] = []; const dead: Found[] = [];
  for (const [name, file] of [...exports].sort()) {
    if (used(name, src, file)) continue;
    const body = text.get(file)!.replace(
      new RegExp(`^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+class|class|function|const)\\s+${name}\\b`, "m"), "");
    const selfUsed = new RegExp(`\\b${name}\\b`).test(body);
    const inTests = used(name, tests);
    if (inTests) testOnly.push({ name, file });
    else if (selfUsed) internal.push({ name, file });
    else dead.push({ name, file });
  }
  return { testOnly, internal, dead };
}

const rel = (f: string) => f.slice(f.indexOf("packages"));

test("NO EXPORTED MECHANISM IS REACHED ONLY BY ITS OWN TEST", () => {
  const { testOnly } = scan();
  // A sanity floor: if the parse breaks and finds nothing, the guard is satisfied by having
  // checked nothing, which is the failure this whole class is about.
  assert.ok(testOnly.length > 10, `only ${testOnly.length} candidates found — the scan is broken`);

  const unjustified = testOnly.filter((f) => !(f.name in REACHED_ONLY_BY_TESTS));
  assert.deepEqual(unjustified.map((f) => `${f.name} (${rel(f.file)})`), [],
    "these are exported and nothing but a test calls them. Either wire them to the thing that "
    + "should use them, or add a line to REACHED_ONLY_BY_TESTS saying why nothing should — and "
    + "if what you did was build a mechanism and not wire it up, that line is the bug.");
});

test("NOTHING IS EXPORTED THAT ONLY ITS OWN FILE USES", () => {
  // The second outcome, and it has no allowlist on purpose: a module's exports should be its
  // actual surface, and there is no reason to widen it for a function nobody outside can want.
  // Four were in this state — `respondUsing`, `messageKeyOf`, `commitmentBytes`, `identityOf` —
  // and they read as DEAD in the first sweep because it excluded the defining file. Internal use
  // is not deadness, and that correction is why they were un-exported rather than deleted.
  const { internal } = scan();
  assert.deepEqual(internal.map((f) => `${f.name} (${rel(f.file)})`), [],
    "exported, but only used inside its own file — drop the `export`");
});

test("NOTHING EXPORTED HAS NO CALLER AT ALL", () => {
  // The third, also without an allowlist. `fromWalletSignature` and `fromHardwareToken` lived here
  // while the product's own UI told users there is "no passphrase, no keychain, no hardware
  // token" — code carrying a mechanism the product says it does not have. That direction is not
  // harmless: somebody reading the source concludes the capability exists.
  const { dead } = scan();
  assert.deepEqual(dead.map((f) => `${f.name} (${rel(f.file)})`), [], "exported and never called");
});

test("the allowlist has no entries for things that are now wired up", () => {
  // A stale exemption is a guard quietly narrowed. If a listed symbol acquires a real caller, the
  // line justifying its absence is no longer true and should go.
  const { testOnly } = scan();
  const live = new Set(testOnly.map((f) => f.name));
  const stale = Object.keys(REACHED_ONLY_BY_TESTS).filter((n) => !live.has(n));
  assert.deepEqual(stale, [],
    "these are allowlisted as test-only and are no longer test-only — remove the exemption");
  for (const [name, why] of Object.entries(REACHED_ONLY_BY_TESTS)) {
    assert.ok(why.length > 25, `${name}'s exemption is not a reason`);
  }
});
