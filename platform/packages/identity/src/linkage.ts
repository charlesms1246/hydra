/**
 * What the pool discloses about WHO, and to whom.
 *
 * `claude-docs/HYDRA_HANDOFF.md` Phase 1 makes fresh-identity provisioning a v1 critical-path item and
 * gives it an acceptance clause: "an analyst given both identities' on-chain activity cannot
 * link a fresh identity to its owner." This module is how that clause gets *computed* rather
 * than asserted — the standing rule for this project is that a privacy claim we cannot
 * compute is a claim the product does not make.
 *
 * The model is deliberately small. Two observers, one join rule:
 *
 *   public    anyone reading the chain. Sees event fields that are not encrypted, and sees
 *             the sender of every transaction.
 *   auditor   anyone holding ANY generation of the auditor key. Sees everything `public`
 *             sees, plus the `enc_*` fields, plus — because it holds the user's escrowed
 *             viewing key — the note and channel graph. See `claude-docs/decisions/0001-key-domains.md`.
 *
 * The join rule: an observer links two parties when it sees them **named together in one
 * record**. A transaction is a record, so the submitter of a transaction is co-named with
 * whatever that transaction's events disclose. Links are transitive, which is what makes an
 * analyst an analyst rather than a reader.
 *
 * WHAT THIS CANNOT DO. It reasons over the pool's disclosures only. Timing correlation, gas
 * fingerprinting, IP-level observation of the submitting endpoint, and the vault's own upload
 * timeline are all outside it — I3 covers the last of those and has its own harness. A plan
 * this module calls unlinked is unlinked *by the pool*, which is a narrower and more honest
 * statement than "anonymous".
 */

/** Anyone reading the chain, and anyone holding any generation of the auditor key. */
export type Observer = "public" | "auditor";

/** A named role in a provisioning plan — "owner", "fresh", "relayer", an exchange, whatever. */
export type Party = string;

/**
 * One step of a provisioning plan.
 *
 * `submitter` is the address that sends the Starknet transaction, and it is deliberately a
 * separate field from `user`. The pool's `main` takes `user_addr` as an argument and never
 * compares it to the caller (`privacy.cairo:253-262`) — the proof is what authenticates —
 * so a third party can submit on a user's behalf. That separation is the whole reason a
 * fresh identity can exist at all; see `claude-docs/decisions/0002-fresh-identity-funding.md`.
 */
export type Step =
  | { op: "register"; user: Party; submitter: Party }
  | { op: "deposit"; user: Party; submitter: Party }
  | { op: "withdraw"; user: Party; to: Party; submitter: Party }
  | { op: "privateTransfer"; from: Party; to: Party; submitter: Party }
  /** An ordinary token transfer outside the pool. The token contract emits both ends. */
  | { op: "erc20"; from: Party; to: Party };

/** One record an observer can read, and the source that says so. */
export type Record = {
  readonly step: Step["op"];
  readonly observer: Observer;
  /** Parties named together in this record. Two or more is a join. */
  readonly names: readonly Party[];
  readonly why: string;
  readonly cite: string;
};

const POOL = ".upstream/packages/privacy/src";

/**
 * Every transaction names its own sender, whatever else it does. This is the record that
 * makes `submitter` load-bearing: a fresh identity registered by its owner is linked by the
 * transaction, not by anything the pool chose to disclose.
 */
const submitterRecord = (step: Step["op"], named: Party[]): Record => ({
  step,
  observer: "public",
  names: named,
  why: "the transaction's own sender is co-named with everything the transaction emits",
  cite: `${POOL}/privacy.cairo:845-856 (the fee is charged to get_caller_address, in plaintext STRK)`,
});

/** What each observer reads off one step. */
export function records(step: Step): Record[] {
  switch (step.op) {
    case "register":
      return [
        submitterRecord("register", [step.user, step.submitter]),
        {
          step: "register",
          observer: "public",
          names: [step.user],
          why: "registration publishes the address and its pool public key, both indexed",
          cite: `${POOL}/events.cairo:5-13 (ViewingKeySet), emitted ${POOL}/privacy.cairo:351-355`,
        },
      ];

    case "deposit":
      return [
        submitterRecord("deposit", [step.user, step.submitter]),
        {
          step: "deposit",
          observer: "public",
          names: [step.user],
          why: "a deposit names the depositing address in the clear, indexed",
          cite: `${POOL}/events.cairo:31-39 (Deposit), emitted ${POOL}/privacy.cairo:501`,
        },
        {
          step: "deposit",
          observer: "public",
          names: [step.user],
          why: "and the token contract emits its own Transfer for the TransferFrom",
          cite: `${POOL}/privacy.cairo:499-500`,
        },
      ];

    case "withdraw":
      return [
        submitterRecord("withdraw", [step.to, step.submitter]),
        {
          step: "withdraw",
          observer: "public",
          names: [step.to],
          why: "the destination is public; the withdrawing pool identity is not",
          cite: `${POOL}/events.cairo:17-27 (Withdrawal), emitted ${POOL}/privacy.cairo:527-529`,
        },
        {
          step: "withdraw",
          observer: "auditor",
          names: [step.user, step.to],
          why: "enc_user_addr joins the withdrawing identity to the public destination",
          cite: `${POOL}/privacy.cairo:518-523 (encrypt_user_addr), ${POOL}/events.cairo:18-19`,
        },
      ];

    case "privateTransfer":
      return [
        // The public side of a private transfer names nobody: EncNoteCreated carries a note id
        // and a packed value, NoteUsed carries a nullifier. Neither holds an address.
        submitterRecord("privateTransfer", [step.submitter]),
        {
          step: "privateTransfer",
          observer: "auditor",
          names: [step.from, step.to],
          why: "the escrowed viewing key derives the channel and decrypts the note, so the auditor reads the edge",
          cite: `${POOL}/privacy.cairo:331-350 (the escrow), :669 (EncNoteCreated), :630 (NoteUsed)`,
        },
      ];

    case "erc20":
      return [
        {
          step: "erc20",
          observer: "public",
          names: [step.from, step.to],
          why: "an ordinary transfer names both ends; nothing about it is private",
          cite: "ERC20 Transfer — outside the pool entirely",
        },
      ];
  }
}

/** An observer sees everything weaker observers see. */
const visibleTo = (observer: Observer, record: Record): boolean =>
  observer === "auditor" ? true : record.observer === "public";

/**
 * Parties whose co-naming does not propagate a link.
 *
 * A relayer that submits for one user is that user. A relayer that submits for ten thousand
 * users is a hub, and joining through it links every one of them to every other — which is
 * not analysis, it is the model over-fitting on a shared address.
 *
 * Declaring a hub is therefore an ASSUMPTION about an anonymity set, and this module cannot
 * check it: nothing on chain says how many distinct users a relayer served, and a relayer
 * with two users provides no cover at all. Every hub named here is a claim someone has to
 * justify outside this file. Passing none is the paranoid reading, and the tests exercise
 * both — because the difference between them is precisely the value the relayer is adding.
 */
export type Assumptions = {
  readonly hubs?: readonly Party[];
};

/**
 * The parties one observer can join into a single identity set, transitively.
 *
 * Union-find, written as repeated merging because a provisioning plan is a handful of steps
 * and the clever version would be harder to read than the thing it replaces.
 */
export function components(
  plan: readonly Step[],
  observer: Observer,
  assume: Assumptions = {},
): Party[][] {
  const hubs = new Set(assume.hubs ?? []);
  const sets: Set<Party>[] = [];
  for (const step of plan) {
    for (const record of records(step)) {
      if (!visibleTo(observer, record)) continue;
      const named = new Set(record.names.filter((p) => !hubs.has(p)));
      if (named.size === 0) continue;
      const touching = sets.filter((s) => [...named].some((p) => s.has(p)));
      for (const s of touching) {
        for (const p of s) named.add(p);
        sets.splice(sets.indexOf(s), 1);
      }
      sets.push(named);
    }
  }
  return sets.map((s) => [...s].sort());
}

/** Does `observer` link `a` to `b`? */
export function links(
  plan: readonly Step[],
  observer: Observer,
  a: Party,
  b: Party,
  assume: Assumptions = {},
): boolean {
  return components(plan, observer, assume).some((c) => c.includes(a) && c.includes(b));
}

/**
 * The records that produced a link, so a failure explains itself with citations rather than
 * leaving someone to re-derive why. Returns the records naming two or more parties.
 */
export function evidence(plan: readonly Step[], observer: Observer): Record[] {
  return plan
    .flatMap(records)
    .filter((r) => visibleTo(observer, r) && new Set(r.names).size > 1);
}
