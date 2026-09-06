/**
 * What an install still needs before it can send, and where each thing comes from.
 *
 * ## THIS FILE IMPORTS NOTHING, AND THAT IS THE REASON IT IS A FILE
 *
 * It began in `cli/src/commands.ts`, which is the choke point into `vault-client` — so `view.ts`
 * may not reach it, and `web/scripts/module-graph.ts` counts `import type` edges as well as real
 * ones, deliberately. A `SetupGap` type imported from there would have dragged the whole graph into
 * the browser bundle for a string.
 *
 * So `setupGaps` takes **the four fields it reads**, not a `State`. That is what removes the last
 * edge: no type import, no value import, nothing. The precedent is `channel/src/constants.ts`,
 * which exists one layer down for the same reason — quoting a cover rate had dragged
 * `vault-client` into the site.
 *
 * ## WHY THE CONTENT IS HERE AND NOT IN THREE PRINTERS
 *
 * `hydra init` with no flags **succeeds**. It writes an identity, prints a fingerprint, and the
 * resulting client cannot send a single message — no contract, no invites. `status` rendered both
 * as ordinary values, `(unset)` and `0 invites left`, in the same visual weight as the fingerprint.
 * **A state that reads as fine because nothing named the condition.**
 *
 * The sentence that fixes it — **the vault and the invites come from whoever you are contacting,
 * not from you** — is the whole mental model of the product, and it was nowhere in the client. It
 * lives on the gap it explains so a reader meets it when the thing is missing rather than once in
 * a banner, and so the CLI, the TUI and the HTTP API cannot each phrase it differently. Same
 * argument as `warnings.ts` next door, applied to onboarding rather than to disclosure.
 *
 * ## THREE CATEGORIES, BECAUSE "MISSING" SAYS NOTHING ABOUT THE WORST TWO FIELDS
 *
 * `contract` and `invites` are empty. **`vaultUrl` and `rpcUrl` are not** — they hold devnet
 * defaults, so a blocker list passes them in silence while they are the fields that most look like
 * working configuration and are not. `unchosen` is a real third state: present, plausible, and
 * never decided by anybody.
 */

/**
 * The two URLs a fresh state carries, named so `setupGaps` cannot drift from `init`.
 *
 * **THEY POINT AT A LOCAL DEVNET AND NOTHING IS LISTENING THERE UNLESS YOU STARTED ONE.** They
 * were literals here and nowhere else, which was fine while nothing else needed to know what a
 * default looked like; the moment something has to say *"this was never chosen"* it needs the same
 * value, and a second copy of a URL is a second answer to what the default is.
 */
export const DEVNET_VAULT = "http://127.0.0.1:8080";
export const DEVNET_RPC = "http://127.0.0.1:5050";

/**
 * What a fresh install still needs before it can send anything, and where each thing comes from.
 *
 * ## THE DEFECT THIS EXISTS FOR
 *
 * `hydra init` with no flags **succeeds**. It writes an identity and prints a fingerprint. The
 * resulting client cannot send a single message — no contract, no invites — and `status` rendered
 * both as ordinary values: `(unset)` and `0 invites left`, in the same visual weight as the
 * fingerprint. **A state that reads as fine because nothing named the condition**, which is the
 * same family as a queue that looked identical whether the vault was alive or dead.
 *
 * ## WHY THREE CATEGORIES AND NOT TWO
 *
 * "Missing" was the obvious model and it says nothing about the two most misleading fields.
 * `contract` and `invites` are empty. **`vaultUrl` and `rpcUrl` are not** — they hold devnet
 * defaults, so a blocker list would pass them in silence while they are the fields that most look
 * like working configuration and are not. `unchosen` is a real third state: present, plausible,
 * and never decided by anybody.
 *
 * ## `why` CARRIES THE ONBOARDING MODEL, AND THAT IS THE POINT OF THE FIELD
 *
 * **The vault and the invites come from whoever you are contacting, not from you.** That sentence
 * is the whole mental model of the product and it was nowhere in the client. It lives here, on the
 * gap it explains, so a reader meets it at the moment the thing is missing rather than once in a
 * banner — and so the CLI, the TUI and the API cannot each phrase it differently. Same reason
 * `claims/src/warnings.ts` exists one layer up.
 *
 * ## THE REMEDY IS THE STATE FILE, AND THAT IS NOT A SHORTCUT
 *
 * **No command changes any of these after `init`** — checked against every `case` in `cli.ts`, and
 * `init` itself refuses when a state already exists. So the only route is editing the file, and a
 * reader told to "run init again" would be told to delete their identity and every channel with
 * it. The fields are plain top-level JSON and mode 0600, so editing is the honest answer; a locked
 * file needs `hydra unlock` first. **That there is no reconfiguration command is a real gap and
 * this is not it being fixed** — it is being stated instead of leaving a user to discover it by
 * losing an identity.
 *
 * No path is named here: each surface knows where its own state file is, and a path in this
 * module would be a second place that has to agree with `state.ts`.
 */
export type SetupGap = {
  readonly id: string;
  /** The state field, so a caller can line the gap up against what it prints. */
  readonly field: string;
  /** `missing` cannot send; `unchosen` holds a devnet default nobody picked. */
  readonly severity: "missing" | "unchosen";
  readonly what: string;
  readonly why: string;
  readonly remedy: string;
};

/**
 * The one sentence about HOW to change any of these, said once rather than per gap.
 *
 * It was repeated into every `remedy` first. Printed, that put the same four lines under each of
 * four gaps — sixteen lines of identical text around the four that differed, which is how a block
 * of prose becomes something people skip. The per-gap remedy now names only its own field and
 * this carries what they share.
 */
export const RECONFIGURE =
  "No command changes any of these after `hydra init` — it refuses while a state exists, and "
  + "deleting that state destroys your identity and every channel in it. Edit the field in your "
  + "state file instead; run `hydra unlock` first if it is encrypted.";

/**
 * The four fields this reads, and nothing else.
 *
 * **NOT `State`.** A `State` parameter would need `import type { State } from "cli/src/state.ts"`,
 * and that type reaches `handshake/` and `identity/` — which `module-graph.ts` counts even though
 * the bundler erases it, on purpose. Naming the fields keeps this module at zero imports, which is
 * what lets `view.ts` reach it at all. `invites` is a COUNT rather than the codes: a renderer has
 * never needed the codes and a module that cannot receive them cannot leak them.
 */
export type SetupConfig = {
  readonly contract: string;
  readonly invites: number;
  readonly vaultUrl: string;
  readonly rpcUrl: string;
};

export function setupGaps(state: SetupConfig): readonly SetupGap[] {
  const gaps: SetupGap[] = [];
  if (!state.contract) {
    gaps.push({
      id: "contract", field: "contract", severity: "missing",
      what: "no channel contract address, so nothing can be published",
      why: "it names the deployment you and the person you are contacting are both on. they tell "
        + "you which one — there is no directory to look it up in and no default that is right.",
      remedy: "edit `contract` in your state file.",
    });
  }
  if (state.invites === 0) {
    gaps.push({
      id: "invites", field: "invites", severity: "missing",
      what: "no upload invites, so nothing can be uploaded — including the cover traffic",
      why: "invites are issued by the operator of the vault you upload to, so they come from "
        + "whoever you are contacting rather than from you. A CLIENT CANNOT MINT ITS OWN: the "
        + "invite IS that operator's admission control, and self-issuing would be granting "
        + "yourself capacity on somebody else's storage.",
      remedy: "edit `invites` in your state file. Ask the party you are contacting for codes.",
    });
  }
  if (state.vaultUrl === DEVNET_VAULT) {
    gaps.push({
      id: "vault", field: "vaultUrl", severity: "unchosen",
      what: `the vault URL is still ${DEVNET_VAULT}, which nobody chose`,
      why: "storage is the RECIPIENT's infrastructure, not yours. that address is where a local "
        + "devnet's vault would be and nothing is listening there unless you started one. the "
        + "real URL comes from whoever you are contacting.",
      remedy: "edit `vaultUrl` in your state file.",
    });
  }
  if (state.rpcUrl === DEVNET_RPC) {
    gaps.push({
      id: "rpc", field: "rpcUrl", severity: "unchosen",
      what: `the chain RPC is still ${DEVNET_RPC}, which nobody chose`,
      why: "it decides which node sees every read you make. that address is a local devnet's; a "
        + "public node is a party with its own view of what you asked for.",
      remedy: "edit `rpcUrl` in your state file.",
    });
  }
  return gaps;
}
