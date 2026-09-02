/**
 * What the NODE sees. The other operator, and until now the one with no table.
 *
 * `vault-server/src/observations.ts` covers the vault operator and is checked against a real
 * capture in both directions. `identity/src/linkage.ts` covers what the pool discloses and
 * says, in its own header, that "IP-level observation of the submitting endpoint" is **outside
 * it**. Between those two the client talks to a third party on every read and every send — the
 * JSON-RPC node in `chain.ts` — and nothing described what that party learns.
 *
 * That is the same defect this project has now found four times: a guard or a table scoped to
 * what it was written for, silently not covering the thing that arrived later. The node was
 * always there. `decisions/0029` needed one row from it and found the table missing.
 *
 * WHY IT IS A SEPARATE TABLE AND NOT MORE ROWS ON THE VAULT'S. They are different parties who
 * see different things, and a user choosing a vault is not choosing a node. Merging them would
 * publish a single list that no one operator can produce, which is the over-claiming failure
 * `operator-view.test.ts` exists to catch, pointed the other way.
 */

/** One thing the node can observe, and why the design cannot avoid it. */
export type NodeObservation = {
  /** Stable key. The capture is compared against these, so they are an interface. */
  readonly id: string;
  readonly what: string;
  readonly why: string;
};

/** A thing the node CANNOT see, and the name of the code that makes it so. */
export type NodeMechanism =
  | "whole-log-read"
  | "pointer-says-nothing"
  | "content-never-on-chain";

export type NodeGuarantee = {
  readonly id: string;
  readonly what: string;
  readonly because: readonly { readonly claim: string; readonly mechanism: NodeMechanism }[];
};

export const NODE_OBSERVABLE: readonly NodeObservation[] = [
  {
    id: "node.peer",
    what: "the address of every client that reads or publishes, and the shape of its HTTP stack",
    why: "a JSON-RPC node is somebody's HTTP server; the kernel knows the peer whether or not the operator reads it. This is the same unavoidable fact as the vault's `transport.peer`, and it lands on a DIFFERENT party — a user who runs their own vault has not thereby stopped telling a node where they are",
  },
  {
    id: "node.readRange",
    what: "which contract's event log a client reads, and from which block",
    why: "`chain.ts` `events()` asks for one contract's events from a fixed starting block, so the node learns which application this client uses and roughly when it started. There is no version of reading a contract's log without naming the contract",
  },
  {
    id: "node.readTiming",
    what: "when each read happens — and so that a read arrived immediately before a publish from the same address",
    why: "THE ROW `decisions/0029` NEEDS BEFORE ANY OF IT SHIPS. Reading the chain to tell a user how linkable sending would be means a read, then a send, from one address, seconds apart. That join is not on any other table: the vault never sees it, and `linkage.ts` scopes the submitting endpoint out. Reading on a schedule rather than on demand removes it and a warm cache removes the read entirely; neither is free, and neither is done yet",
  },
  {
    id: "node.submission",
    what: "the transaction, from the address that signed it, before it is in any block",
    why: "a transaction has to reach a node to be sequenced. Whoever it is sent to sees the sender, the calldata and the moment — earlier than the public chain shows it, and attached to an IP the chain never carries. `chain.ts` shells out to `sncast` for this, so it is that tool's endpoint rather than `rpcUrl`, which means a user can separate the two parties and by default does not",
  },
];

export const NODE_OBSERVABLE_IDS: readonly string[] = NODE_OBSERVABLE.map((o) => o.id);

export const NODE_NOT_OBSERVABLE: readonly NodeGuarantee[] = [
  {
    id: "node.wantedEvent",
    what: "which event in the log a reading client actually wanted",
    because: [
      {
        claim: "the client asks for the contract's whole log from its starting block and filters on its own machine, so the request names no pointer, no key and no sequence",
        mechanism: "whole-log-read",
      },
    ],
  },
  {
    id: "node.channel",
    what: "which conversation a published event belongs to",
    because: [
      {
        claim: "a pointer is derived from a channel secret the node does not hold, so the two felts name no conversation to anyone who cannot already open it",
        mechanism: "pointer-says-nothing",
      },
    ],
  },
  {
    id: "node.content",
    what: "what a message says",
    because: [
      {
        claim: "the message body never goes on chain at all — only a pointer and a commitment do, and the body is in the vault under a key neither party holds",
        mechanism: "content-never-on-chain",
      },
    ],
  },
];

/** The reason as prose, for the generated statement. Joined, never authored as one string. */
export const nodeWhyOf = (g: NodeGuarantee): string =>
  g.because.map((b) => b.claim).join("; ");
