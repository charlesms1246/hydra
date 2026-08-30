/**
 * what_does_this_leak(tx) — computes a disclosure set.
 *
 * The whole design constraint is standing rule 6: privacy claims must be generated,
 * never asserted. So this file contains no table of conclusions. Every cell it emits is
 * selected by a branch on (a) the action's on-chain footprint as read from upstream
 * source and (b) the configuration the caller declared. Where the caller did not declare
 * something the branch needs, the cell is UNKNOWN — never the reassuring answer.
 *
 * Three invariants are enforced by tests, not by convention:
 *   1. The auditor row is CLEAR/DECRYPTABLE for every field of every action, always.
 *   2. No anonymity-set size is emitted unless it is derived here from a stated basis.
 *   3. No cell is ever emitted without at least one citation.
 */

import {
  CLEAR,
  DECRYPTABLE,
  NOT_DISCLOSED,
  UNKNOWN,
  NA,
  FIELDS,
  PARTIES,
  CITE,
  NETWORKS,
  ACTION_TYPES,
  DISCOVERY_KINDS,
  PROVING_KINDS,
  UPSTREAM_COMMIT,
} from "./facts.mjs";

const cell = (disclosure, why, cites) => ({ disclosure, why, cites });

/** Every action lands in a public block, so timing is CLEAR to anyone watching the pool. */
const publicTiming = (what) =>
  cell(
    CLEAR,
    `apply_actions is an ordinary public Starknet transaction, so the block and timestamp of ` +
      `${what} are public. Whether that timing identifies you depends on the addresses row.`,
    [CITE.APPLY_ACTIONS]
  );

// ---------------------------------------------------------------------------
// Per-action public footprint, read from upstream events and storage writes
// ---------------------------------------------------------------------------

function publicFootprint(a) {
  switch (a.type) {
    case "register":
      return {
        amount: cell(NA, "SetViewingKey moves no value.", [CITE.EV_VIEWING_KEY_SET]),
        token: cell(NA, "SetViewingKey names no token.", [CITE.EV_VIEWING_KEY_SET]),
        counterparty: cell(NA, "SetViewingKey has no counterparty.", [CITE.EV_VIEWING_KEY_SET]),
        timing: publicTiming("your registration"),
        addresses: cell(
          CLEAR,
          "ViewingKeySet emits user_addr and public_key as indexed (#[key]) event fields, and " +
            "get_public_key(addr) is a public view. Pool membership is public per address: " +
            "anyone can enumerate who has registered and when.",
          [CITE.EV_VIEWING_KEY_SET, CITE.AUDITOR_STORAGE]
        ),
      };

    case "deposit":
      return {
        amount: cell(
          CLEAR,
          "Deposit.amount is emitted as a plain u128, and the pool performs a real ERC20 " +
            "transfer_from, so the amount also appears in the token's own Transfer event.",
          [CITE.EV_DEPOSIT, CITE.TRANSFER_FROM]
        ),
        token: cell(CLEAR, "Deposit.token is an indexed (#[key]) event field.", [CITE.EV_DEPOSIT]),
        counterparty: cell(
          CLEAR,
          "A deposit's counterparty is the pool contract itself, and the transfer_from names it " +
            "as recipient. Nothing about a deposit is directed at another user.",
          [CITE.EV_DEPOSIT, CITE.TRANSFER_FROM]
        ),
        timing: publicTiming("your deposit"),
        addresses: cell(
          CLEAR,
          "Deposit.user_addr is an indexed (#[key]) event field naming the depositor, and the " +
            "ERC20 transfer_from is from that address. The depositor is not anonymised at all.",
          [CITE.EV_DEPOSIT, CITE.TRANSFER_FROM]
        ),
      };

    case "withdraw":
      return {
        amount: cell(
          CLEAR,
          "Withdrawal.amount is emitted as a plain u128, and the pool performs a real ERC20 " +
            "transfer to to_addr.",
          [CITE.EV_WITHDRAWAL, CITE.TRANSFER_TO]
        ),
        token: cell(CLEAR, "Withdrawal.token is an indexed (#[key]) event field.", [
          CITE.EV_WITHDRAWAL,
        ]),
        counterparty: cell(
          CLEAR,
          "Withdrawal.to_addr is an indexed (#[key]) event field. The destination of a withdrawal " +
            "is public.",
          [CITE.EV_WITHDRAWAL, CITE.TRANSFER_TO]
        ),
        timing: publicTiming("your withdrawal"),
        addresses: cell(
          CLEAR,
          "to_addr is in the clear. The withdrawing pool user is NOT: it is carried as " +
            "enc_user_addr, whose own doc comment says it can be decrypted by the auditor. So " +
            "the destination is public and the source is auditor-only — the linkage that " +
            "matters is exactly the one escrow preserves.",
          [CITE.EV_WITHDRAWAL, CITE.F01]
        ),
      };

    case "transfer": {
      // OpenChannel is what discloses the recipient, and it happens only on the first
      // transfer into a (sender, recipient) channel. If the caller has not said which
      // this is, the answer is UNKNOWN — not the reassuring branch.
      const opens = a.opensChannel;
      const counterparty =
        opens === true
          ? cell(
              CLEAR,
              "This transfer opens a channel. OpenChannel produces an Append server action whose " +
                "storage map recipient_channels is keyed by the plaintext recipient address, and " +
                "get_num_of_channels(recipient_addr) is a public view returning how many channels " +
                "have been opened to that address. So a public observer learns that a channel was " +
                "opened to this recipient, in this block. It does NOT learn who opened it.",
              [CITE.RECIPIENT_CHANNELS, CITE.NUM_OF_CHANNELS_VIEW]
            )
          : opens === false
            ? cell(
                NOT_DISCLOSED,
                "The caller states the channel already exists, so this transfer emits no Append " +
                  "and writes nothing keyed by a plaintext address — only EncNoteCreated " +
                  "{note_id, packed_value} and NoteUsed {nullifier}.",
                [CITE.EV_ENC_NOTE, CITE.EV_NOTE_USED, CITE.RECIPIENT_CHANNELS]
              )
            : cell(
                UNKNOWN,
                "opensChannel was not declared. If this is the first transfer to this recipient, " +
                  "the pool appends to recipient_channels[recipient_addr] — a storage map keyed " +
                  "by the plaintext recipient address, readable via the public view " +
                  "get_num_of_channels — and the recipient is disclosed. If the channel already " +
                  "exists, it is not. This tool cannot tell which without chain state, so it " +
                  "reports UNKNOWN rather than the reassuring branch.",
                [CITE.RECIPIENT_CHANNELS, CITE.NUM_OF_CHANNELS_VIEW]
              );
      return {
        amount: cell(
          NOT_DISCLOSED,
          "EncNoteCreated carries only note_id and packed_value; the amount is inside " +
            "packed_value together with a 120-bit salt. No plaintext amount is emitted and no " +
            "ERC20 transfer occurs — value moves between notes inside the pool.",
          [CITE.EV_ENC_NOTE]
        ),
        token: cell(
          NOT_DISCLOSED,
          "The token lives in the subchannel, written as enc_subchannel_info under a " +
            "secret-derived storage key. Unlike Deposit and Withdrawal, no note event carries a " +
            "token field.",
          [CITE.SUBCHANNEL_ENC, CITE.EV_ENC_NOTE]
        ),
        counterparty,
        timing: publicTiming("this transfer"),
        addresses: cell(
          opens === true ? CLEAR : opens === false ? NOT_DISCLOSED : UNKNOWN,
          opens === true
            ? "The recipient address is disclosed as a channel recipient (see counterparty). The " +
              "sender's address is not: no event or storage key on this path carries it."
            : opens === false
              ? "Neither address is emitted. Note ids, nullifiers and channel markers are all " +
                "derived from secrets, so they are not attributable to an address by a public " +
                "observer."
              : "Depends on whether this transfer opens a channel; see the counterparty row. " +
                "Sender's address is not disclosed either way.",
          [CITE.EV_ENC_NOTE, CITE.EV_NOTE_USED, CITE.RECIPIENT_CHANNELS]
        ),
      };
    }

    case "invoke": {
      const shadow = a.via === "shadow-account";
      // The pool deliberately does not emit calldata *because it is already public*.
      // This tool does not parse calldata, so amounts and tokens inside it are only
      // reported when the caller declared them.
      const declared = (v, name) =>
        v === undefined
          ? cell(
              UNKNOWN,
              `The ${name} is not declared on this action. ExternalContractInvoked emits only ` +
                `contract_address and selector, but the pool's own comment states calldata is ` +
                `omitted from the event because it is already visible in the public call trace. ` +
                `So if a ${name} is in the calldata it is public — this tool does not parse ` +
                `calldata and will not guess.`,
              [CITE.EV_INVOKED, CITE.CALLDATA_IN_TRACE]
            )
          : cell(
              CLEAR,
              `Declared as ${JSON.stringify(v)}. Invoke calldata is visible in the public call ` +
                `trace by the pool's own account, and any ERC20 movement the target performs ` +
                `emits its own Transfer event.`,
              [CITE.CALLDATA_IN_TRACE, CITE.EV_INVOKED]
            );
      return {
        amount: declared(a.amount, "amount"),
        token: declared(a.token, "token"),
        counterparty: cell(
          CLEAR,
          "ExternalContractInvoked emits contract_address and selector as indexed (#[key]) " +
            "fields. Which contract you called, and whether it was a plain invoke or a " +
            "compute-and-invoke, are public.",
          [CITE.EV_INVOKED]
        ),
        timing: publicTiming("this invoke"),
        addresses: shadow
          ? cell(
              CLEAR,
              "Via a shadow account: the shadow account address and its identity_commitment are " +
                "both indexed (#[key]) fields of ShadowAccountDeployed, and the shadow account is " +
                "the caller the target dapp sees. Your pool address is not emitted. Unlinkability " +
                "here is to the public only — see the auditor and discovery rows.",
              [CITE.EV_SHADOW_DEPLOYED, CITE.F03]
            )
          : cell(
              CLEAR,
              "Plain InvokeExternal: the pool contract is the caller the target sees, so the " +
                "target address and selector are public and your pool address is not emitted. " +
                "Any address inside the calldata is public via the call trace; this tool does " +
                "not parse calldata.",
              [CITE.EV_INVOKED, CITE.CALLDATA_IN_TRACE]
            ),
      };
    }

    default:
      // Unreachable for validated input; kept so an unrecognised action degrades to
      // UNKNOWN rather than to silence.
      return Object.fromEntries(
        FIELDS.map((f) => [
          f,
          cell(UNKNOWN, `Unrecognised action type ${JSON.stringify(a.type)}.`, [
            CITE.APPLY_ACTIONS,
          ]),
        ])
      );
  }
}

// ---------------------------------------------------------------------------
// Party rows
// ---------------------------------------------------------------------------

/** Other pool users run the same nodes as anyone else; they get no extra channel. */
function poolUsersRow(pub) {
  return Object.fromEntries(
    FIELDS.map((f) => {
      const c = pub[f];
      return [
        f,
        cell(
          c.disclosure,
          `Identical to the public chain observer: holding pool notes grants no read access to ` +
            `anyone else's. ${c.why}`,
          c.cites
        ),
      ];
    })
  );
}

/** The counterparty of a transfer is told everything about it; that is the point. */
function counterpartyRow(a) {
  if (a.type === "transfer") {
    const why =
      "The recipient's own viewing key decrypts the channel info and the note addressed to " +
      "them. This is the intended function of a transfer, not a leak — but it does mean the " +
      "recipient learns your address, the token and the amount.";
    return Object.fromEntries(
      FIELDS.map((f) => [f, cell(CLEAR, why, [CITE.EV_ENC_NOTE, CITE.F02])])
    );
  }
  if (a.type === "withdraw") {
    return Object.fromEntries(
      FIELDS.map((f) => [
        f,
        cell(
          CLEAR,
          "The withdrawal destination receives the tokens and can read the public Withdrawal " +
            "event. It learns amount, token, destination and timing; it does not learn your pool " +
            "address, which is encrypted to the auditor.",
          [CITE.EV_WITHDRAWAL, CITE.TRANSFER_TO]
        ),
      ])
    );
  }
  if (a.type === "invoke") {
    return Object.fromEntries(
      FIELDS.map((f) => [
        f,
        cell(
          UNKNOWN,
          "The counterparty is the target contract. What it retains depends on code this tool " +
            "has not read. For a shadow-account call it sees the shadow account as caller; for a " +
            "plain invoke it sees the pool. Beyond that, UNKNOWN.",
          [CITE.EV_INVOKED, CITE.F03]
        ),
      ])
    );
  }
  return Object.fromEntries(
    FIELDS.map((f) => [
      f,
      cell(NA, `A ${a.type} has no counterparty user.`, [CITE.APPLY_ACTIONS]),
    ])
  );
}

/**
 * The discovery operator's row is a property of the configuration, not of the action.
 * Two of the three kinds disclose the same thing to different people (standing rule 7).
 */
function discoveryRow(config) {
  const kind = config.discovery;
  if (kind === undefined || !DISCOVERY_KINDS.includes(kind)) {
    const why =
      kind === undefined
        ? "config.discovery was not declared, so this tool cannot tell whether a discovery " +
          "service is contacted at all. Absence of a declaration is not absence of disclosure."
        : `config.discovery is ${JSON.stringify(kind)}, which is not a configuration this tool ` +
          `recognises. It will not guess.`;
    return Object.fromEntries(FIELDS.map((f) => [f, cell(UNKNOWN, why, [CITE.F02])]));
  }

  if (kind === "client") {
    return Object.fromEntries(
      FIELDS.map((f) => [
        f,
        cell(
          NOT_DISCLOSED,
          "ContractDiscoveryProvider does traversal and decryption against a PoolContractInterface " +
            "in-process; no discovery service is contacted and the viewing key never leaves the " +
            "process. Residual, and not covered by this row: the RPC endpoint you traverse " +
            "through still sees the call pattern and your IP — that operator is a party this tool " +
            "does not model.",
          [CITE.CONTRACT_DISCOVERY, CITE.F02, CITE.F07]
        ),
      ])
    );
  }

  const hosted = kind === "indexer-hosted";
  const who = hosted ? "the hosted operator" : "you, as the operator you run";
  const ohttpNote =
    config.ohttp === true
      ? "OHTTP is on, which hides your IP from the gateway. It does not hide the key: the " +
        "gateway decapsulates the request in order to answer it."
      : config.ohttp === false
        ? "OHTTP is explicitly off, so the operator also learns the client IP the key belongs to."
        : "OHTTP was not declared. Note that createPrivateTransfers({ discoveryProvider: { url } }) " +
          "constructs IndexerDiscoveryProvider with no third argument, so the documented happy " +
          "path silently has OHTTP off; server-side OHTTP_ENABLED also defaults to false.";

  const base =
    `IndexerDiscoveryProvider posts the user's PRIVATE viewing key in the request body and the ` +
    `service decrypts server-side. So ${who} learns this, and not only for this transaction: the ` +
    `viewing key is immutable and unscoped, so one sync discloses the user's entire past and ` +
    `future history. ${ohttpNote}` +
    (hosted
      ? ""
      : " Self-hosting changes who the operator is; it does not remove the disclosure — for an " +
        "application holding other people's keys that is not an improvement (standing rule 7).");

  const cites = [CITE.F02, CITE.INDEXER_BODY, CITE.F01];
  if (config.ohttp === undefined) cites.push(CITE.FACTORY_NO_OHTTP);
  return Object.fromEntries(FIELDS.map((f) => [f, cell(CLEAR, base, cites)]));
}

/**
 * The proving service is not one of the four parties HANDOFF Phase F names, but the SDK
 * puts the viewing key in the proof invocation calldata and POSTs it, so leaving it out
 * would be exactly the false reassurance this tool exists to prevent.
 */
function proverRow(config) {
  const kind = config.proving;
  if (kind === undefined || !PROVING_KINDS.includes(kind)) {
    return Object.fromEntries(
      FIELDS.map((f) => [
        f,
        cell(
          UNKNOWN,
          "config.proving was not declared (or is not a value this tool recognises), so whether a " +
            "remote prover receives this transaction is not computable.",
          [CITE.PROVER_CALLDATA]
        ),
      ])
    );
  }
  if (kind === "mock") {
    return Object.fromEntries(
      FIELDS.map((f) => [
        f,
        cell(
          NOT_DISCLOSED,
          "A mock/in-process proof provider makes no remote call, so no prover receives the " +
            "invocation. This is a testing configuration; a real deployment needs a real prover.",
          [CITE.PROVER_POST]
        ),
      ])
    );
  }
  const hosted = kind === "service-hosted";
  return Object.fromEntries(
    FIELDS.map((f) => [
      f,
      cell(
        CLEAR,
        `ProofInvocationFactory compiles compile_actions calldata as ` +
          `[userAddress, user.viewingKey, ...clientActions] and ProvingService.proveTransaction ` +
          `POSTs that invocation to the proving service as starknet_proveTransaction. ` +
          `${hosted ? "The hosted prover" : "The prover you operate"} therefore receives your ` +
          `address, your PRIVATE viewing key, and every action of this transaction in plaintext. ` +
          `Like the indexer, the key is unscoped and immutable, so the disclosure is not limited ` +
          `to this transaction.` +
          (hosted
            ? ""
            : " Self-hosting changes who the operator is, not what is disclosed (standing rule 7)."),
        [CITE.PROVER_CALLDATA, CITE.PROVER_POST, CITE.F01]
      ),
    ])
  );
}

/**
 * The auditor row. Always CLEAR or DECRYPTABLE, for every field of every action, with no
 * configuration that changes it. HANDOFF Phase F: "Always yes. Say it every time."
 */
function auditorRow(a) {
  const root =
    "The auditor can decrypt everything. At registration the pool encrypts the user's private " +
    "viewing key to an auditor key read from contract storage — not from user input — with " +
    "random.is_non_zero() blocking neutralisation and both writes going through " +
    "to_write_once_action. There is no opt-out, no substitution, no rotation for the user, and " +
    "rotation by governance does not revoke the auditor who was in office when you registered.";
  const perField = {
    addresses:
      a.type === "withdraw"
        ? " Additionally and directly: Withdrawal.enc_user_addr is encrypted specifically to the " +
          "auditor, whose own doc comment says so."
        : a.type === "invoke"
          ? " Shadow accounts do not help here: identity_key derives from the viewing key, so any " +
            "holder enumerates every shadow account you have ever derived and links them to you."
          : "",
    counterparty:
      a.type === "transfer"
        ? " Note recipients are also directly available: OpenNoteCreated.enc_recipient_addr is " +
          "encrypted to the auditor."
        : "",
  };
  return Object.fromEntries(
    FIELDS.map((f) => [
      f,
      cell(
        DECRYPTABLE,
        root + (perField[f] ?? ""),
        [CITE.F01, CITE.AUDITOR_STORAGE, CITE.F06].concat(
          f === "addresses" && a.type === "withdraw" ? [CITE.EV_WITHDRAWAL] : [],
          f === "addresses" && a.type === "invoke" ? [CITE.F03] : [],
          f === "counterparty" && a.type === "transfer" ? [CITE.EV_OPEN_NOTE] : []
        )
      ),
    ])
  );
}

// ---------------------------------------------------------------------------
// Anonymity sets
// ---------------------------------------------------------------------------

/**
 * Requirement: report UNKNOWN unless actually computed. A size is emitted only when it
 * follows from the action's structure (a deposit names its depositor, so the set is 1) or
 * from counts the caller supplied under `observations`. Nothing is estimated.
 */
function anonymitySet(a, index, observations) {
  const base = { action: a.type, index };

  if (a.type === "deposit" || a.type === "register") {
    return {
      ...base,
      question:
        a.type === "deposit"
          ? "Among how many candidates could this depositor be hiding?"
          : "Among how many candidates could this registrant be hiding?",
      size: 1,
      basis:
        a.type === "deposit"
          ? "Computed, not estimated: Deposit.user_addr is an indexed event field and the ERC20 " +
            "transfer_from names the same address. The depositor is stated, so the set has one " +
            "member. A deposit is not an anonymising action."
          : "Computed, not estimated: ViewingKeySet.user_addr is an indexed event field. " +
            "Registration is a public act by a named address.",
      cites: a.type === "deposit" ? [CITE.EV_DEPOSIT, CITE.TRANSFER_FROM] : [CITE.EV_VIEWING_KEY_SET],
    };
  }

  const obs = observations ?? {};
  const question =
    a.type === "withdraw"
      ? "Among how many pool users could this withdrawer be hiding?"
      : a.type === "invoke"
        ? a.via === "shadow-account"
          ? "Among how many users of this dapp, through this anonymizer, could this shadow " +
            "account's owner be hiding?"
          : "Among how many pool users could the initiator of this invoke be hiding?"
        : "Among how many pool users could this sender be hiding?";

  // The only way to a number here is a count the caller measured. Supplying one is a
  // claim by the caller, so it is echoed back with its provenance attached.
  const supplied =
    a.type === "invoke" && a.via === "shadow-account"
      ? obs.shadowAccountsForDapp
      : obs.registeredPoolUsers;
  if (typeof supplied === "number" && Number.isFinite(supplied) && supplied > 0) {
    return {
      ...base,
      question,
      size: supplied,
      basis:
        `Taken from observations supplied by the caller (${
          a.type === "invoke" && a.via === "shadow-account"
            ? "shadowAccountsForDapp"
            : "registeredPoolUsers"
        } = ${supplied}). This tool did not measure it and cannot verify it. It is an upper bound ` +
        `on the crowd only: amount, timing and token correlation across transactions shrink it, ` +
        `and this tool performs no correlation analysis.`,
      cites:
        a.type === "invoke" && a.via === "shadow-account"
          ? [CITE.F03, CITE.EV_SHADOW_DEPLOYED]
          : [CITE.EV_VIEWING_KEY_SET],
    };
  }

  return {
    ...base,
    question,
    size: UNKNOWN,
    basis:
      a.type === "invoke" && a.via === "shadow-account"
        ? "UNKNOWN. A shadow account is unlinkable only within the crowd using the same dapp " +
          "through the same anonymizer; with few users, timing and amount correlation re-link it " +
          "trivially. Computing it needs a count of distinct shadow accounts deployed by that " +
          "anonymizer for that dapp in a comparable window — chain state this tool does not read. " +
          "Pass observations.shadowAccountsForDapp to have it reported. No number is invented here."
        : "UNKNOWN. Computing it needs the count of registered pool users holding a comparable " +
          "balance of this token at this block — chain state this tool does not read. The " +
          "registered set is publicly enumerable from ViewingKeySet events, so this is measurable; " +
          "it has not been measured. Pass observations.registeredPoolUsers to have a count " +
          "reported with its provenance. No number is invented here.",
    cites:
      a.type === "invoke" && a.via === "shadow-account"
        ? [CITE.F03]
        : [CITE.EV_VIEWING_KEY_SET, CITE.F03],
  };
}

// ---------------------------------------------------------------------------
// Notes — things true of the whole transaction rather than one cell
// ---------------------------------------------------------------------------

function notesFor(tx, actions) {
  const notes = [];
  const cfg = tx.config ?? {};

  notes.push({
    kind: "always",
    text:
      "The auditor row is DECRYPTABLE for every field of every action, under every configuration. " +
      "Escrow is mandatory, contract-enforced and user-uncontrollable, and it is live: both " +
      "mainnet and Sepolia return a non-zero auditor public key.",
    cites: [CITE.F01, CITE.F06],
  });

  if (cfg.network && NETWORKS[cfg.network]) {
    notes.push({
      kind: "deployment",
      text:
        `Auditor public key in force on ${cfg.network} as read on 2026-08-29: ` +
        `${NETWORKS[cfg.network].auditorPublicKey}. The key in force at your registration is the ` +
        `one that owns your history; governance rotation does not revoke it.`,
      cites: [CITE.F06, CITE.F01],
    });
  } else {
    notes.push({
      kind: "unknown",
      text:
        "config.network was not declared or is not recognised, so the auditor key actually in " +
        "force is UNKNOWN. Mainnet and Sepolia use different auditor keys and run different " +
        "contract classes, so behaviour verified on one does not transfer to the other.",
      cites: [CITE.F06],
    });
  }

  if (actions.some((a) => a.type === "deposit")) {
    notes.push({
      kind: "unknown",
      text:
        "This transaction contains a deposit, which requires a screening attestation covering the " +
        "depositor. The screener is a further party. Both live pools return a non-zero screener " +
        "public key, but what the screening path discloses and retains has not been examined — " +
        "UNKNOWN, and out of this tool's scope.",
      cites: [CITE.SCREENING, CITE.F06],
    });
  }

  notes.push({
    kind: "scope",
    text:
      "Scope: this is a single-transaction analysis. NOT_DISCLOSED_BY_THIS_TX means this " +
      "transaction does not place the value where that party can read it. It says nothing about " +
      "correlating this transaction with others by amount, timing or token, about off-chain side " +
      "channels, or about what a party already knew. Cross-transaction correlation is UNKNOWN here.",
    cites: [CITE.APPLY_ACTIONS],
  });

  return notes;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Normalises input and collects the reasons it could not be understood. */
function normalise(tx) {
  const problems = [];
  const raw = Array.isArray(tx?.actions) ? tx.actions : [];
  if (raw.length === 0) problems.push("No actions given: nothing to analyse.");
  const actions = raw.map((a, i) => {
    const t = typeof a?.type === "string" ? a.type : undefined;
    if (!ACTION_TYPES.includes(t)) {
      problems.push(
        `Action ${i}: type ${JSON.stringify(t)} is not one of ${ACTION_TYPES.join(", ")}. ` +
          `Its public footprint is reported as UNKNOWN.`
      );
    }
    return { ...a, type: t };
  });
  const config = { ...(tx?.config ?? {}) };
  if (config.network !== undefined && !NETWORKS[config.network]) {
    problems.push(`config.network ${JSON.stringify(config.network)} is not mainnet or sepolia.`);
  }
  return { actions, config, observations: tx?.observations, problems };
}

/**
 * @param {object} tx  { actions: [...], config: {...}, observations?: {...} }
 * @returns {object}   the disclosure set
 */
export function whatDoesThisLeak(tx) {
  const { actions, config, observations, problems } = normalise(tx);

  const disclosures = actions.map((a, index) => {
    const pub = publicFootprint(a);
    const byParty = {
      public: pub,
      "pool-users": poolUsersRow(pub),
      counterparty: counterpartyRow(a),
      discovery: discoveryRow(config),
      prover: proverRow(config),
      auditor: auditorRow(a),
    };
    return { index, action: a, byParty };
  });

  const report = {
    upstreamCommit: UPSTREAM_COMMIT,
    config,
    parties: PARTIES,
    fields: FIELDS,
    disclosures,
    anonymitySets: actions.map((a, i) => anonymitySet(a, i, observations)),
    notes: notesFor(tx ?? {}, actions),
    problems,
  };

  report.unknownCount =
    disclosures.reduce(
      (n, d) =>
        n +
        Object.values(d.byParty).reduce(
          (m, row) => m + FIELDS.filter((f) => row[f].disclosure === UNKNOWN).length,
          0
        ),
      0
    ) + report.anonymitySets.filter((s) => s.size === UNKNOWN).length;

  return report;
}

/** Snake-case alias matching the name the HANDOFF uses for this deliverable. */
export const what_does_this_leak = whatDoesThisLeak;
