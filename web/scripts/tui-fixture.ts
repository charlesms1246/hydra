/**
 * The one fixture both terminal renders draw from.
 *
 * ⛔ **SHARED SO THAT ONE GUARD COVERS BOTH PATHS.** `capture-tui.ts` asserts the frame it writes
 * contains neither this machine's home directory nor its username — that check exists because the
 * first capture put a real username on a public marketing page. **A live render in the browser
 * never passes through it**: no build step sits between that fixture and a reader.
 *
 * Two fixtures would mean the static frame is guarded and the live one is not, showing the same
 * data through two doors with a check on one. So there is one, and `capture-tui.ts` asserts over
 * it at build time on behalf of both.
 *
 * ## Everything here is visibly fake, and that is a requirement
 *
 * A plausible-looking fingerprint in a marketing asset is a string somebody eventually quotes as
 * real. Peer ids are runs of one character; the seed is a repeating pattern; the contract is
 * counting hex. **The seed is DISTINCT from every other value on purpose** — it was zeros while the
 * contract was also zeros, and the leak check fired on the contract. A canary triggerable by
 * something other than what it watches for teaches people to widen it.
 *
 * ## No imports
 *
 * Plain data, so a client component can import it without pulling anything from `hydra-dapp` into a
 * browser bundle. I6 lives or dies on that graph staying clean.
 */

/** Never a real seed, and never equal to any other fixture value. */
export const SEED = "5e5e".repeat(16);

/**
 * ⛔ Set before the renderer is imported — `cli/src/state.ts` evaluates
 * `STATE_DIR = process.env.HYDRA_HOME ?? join(homedir(), …)` at module load, and the status pane
 * prints it. A placeholder home, deliberately not this machine's.
 */
export const FIXTURE_HOME = "/home/you/.hydra-msg";

export const FIXTURE_STATE = {
  vaultUrl: "http://127.0.0.1:8080",
  rpcUrl: "http://127.0.0.1:5050",
  contract: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  fromBlock: 1,
  accountsFile: "/tmp/accounts.json",
  account: "demo",
  network: "devnet",
  blockMs: 1000,
  seedHex: SEED,
  /*
   * ⛔ A full `PrekeyStore`, not a stub. `viewOf` derives an identity bundle, which reads
   * `signed[epoch]` and throws "the store is broken" if it is missing — a fixture shaped like the
   * type but not like a working store fails at the first derive rather than at the type.
   *
   * These are fake private seeds and are 32 bytes of a repeating pattern, distinct from `SEED` so
   * the leak check cannot fire on one while watching for the other.
   */
  prekeys: {
    epoch: 0,
    signed: { "0": "a1a1".repeat(16) },
    oneTime: { "0": "b2b2".repeat(16) },
    nextOneTime: 1,
  },
  invites: [],
  pending: [],
  channels: {
    ana: { peer: "a".repeat(32), role: "initiator", readTo: 0, messages: [] },
    bo: { peer: "b".repeat(32), role: "responder", readTo: 0, messages: [] },
  },
};

/**
 * The two leak lists, and they are separate because they guard different things.
 *
 * ⛔ **The seed may appear in the FIXTURE and must not appear in the RENDER.** It is the fixture's
 * own field; asserting it absent from the fixture would be asserting the fixture has no seed. What
 * must never happen is the renderer printing it onto a page.
 *
 * ⛔ **The machine's identity must appear in NEITHER.** Not in the render, because that is a
 * username on a public page — the defect that produced these checks. Not in the fixture, because a
 * live render draws straight from it with no build step in between, so a fixture carrying a real
 * path would put it on the page through a door this script never sees.
 *
 * Collapsing the two lists into one is what fired the check on the fixture's own seed, which is a
 * canary going off at the thing it is standing next to.
 */
export function renderOnlyNeedles(): [string, string][] {
  return [
    ["fixture seed", SEED],
    ["fixture seed prefix", SEED.slice(0, 16)],
  ];
}

export function identityNeedles(homeDir: string, user: string): [string, string][] {
  return [
    ...(homeDir.length > 3 ? ([["home directory", homeDir]] as [string, string][]) : []),
    ...(user.length > 2 ? ([["username", user]] as [string, string][]) : []),
  ];
}
