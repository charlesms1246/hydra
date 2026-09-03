/**
 * What the MODERATION surface discloses — a third table, for the same reason there is a second.
 *
 * `vault-server/src/observations.ts` is what the vault's own record shows, and it is checked
 * against a capture of exactly that. `cli/src/node-view.ts` is the JSON-RPC node's. This is
 * moderation's, and it is separate for two reasons that both matter.
 *
 * **The vault cannot produce these.** A table is only honest if something captures what that
 * surface does, and the vault's capture has no reports and no appeals in it. Documenting them
 * there would be the over-claiming failure `operator-view.test.ts` exists to catch.
 *
 * **And moderation has identities where the vault must not.** `uploader.identity` says the vault
 * has no accounts and `inbox.sender` says it authenticates nobody — guarantees now held by
 * two-world tests. An appeal is checked by verifying a signature from a publishing account, which
 * is authentication of an identity. Putting that code in `vault-server` made both guards fire, and
 * they were right to: the dependency direction is part of the guarantee. So moderation is its own
 * package, and the vault stays a thing that stores bytes for nobody in particular.
 */

/** One thing the operator learns from running moderation, and why it is unavoidable. */
export type ModerationObservation = {
  readonly id: string;
  readonly what: string;
  readonly why: string;
};

export const MODERATION_OBSERVABLE: readonly ModerationObservation[] = [
  {
    id: "report.filed",
    what: "that some object was reported, when, and the text of up to a bounded number of distinct reports about it",
    why: "a report has to reach a human to be acted on, so the operator reads it. What is deliberately absent is any identity for the reporter — there is none to record, because the service has no accounts and adding one to rate-limit reporting would be the first identity in the system. So the operator learns that an object was reported and cannot learn by how many people: a count of reports is not a count of people, and the review surface says so beside the number rather than elsewhere",
  },
  {
    id: "decision.recorded",
    what: "the blob id, outcome, category and date of every moderation decision",
    why: "an appeal has to be able to name the decision it contests and a transparency report has to be generated from something, so the decision is a record. It is the minimum that makes both possible. NO REPORTER IDENTITY IS IN IT, deliberately: a store that names reporters is discoverable and is the most dangerous file this service would keep — the same argument as not retaining removed content to allow a reversal, one layer over",
  },
  {
    id: "appeal.filed",
    what: "that an appeal was filed, when, and that whoever filed it can sign for the account that published the object",
    why: "an appeal is checked by verifying a signature from the publishing account, so accepting one necessarily means learning that somebody controlling that account contested this decision at this time. THE SHARPEST PART IS THE DELIVERY, NOT THE PROOF. Before an appeal the operator knows account X published post P, which is public and already disclosed. If the appeal arrives over a connection they terminate they additionally hold an IP, an SNI and a TLS session correlated to a Starknet account — it converts a chain identity into a network observation, at the moment the appellant is under pressure and least likely to weigh it. So the artifact is DETACHED and self-authenticating: it can be relayed, posted or handed to somebody else, and the operator verifies the artifact rather than the connection. Delivering it directly is a choice with a cost, and the client says so before sending",
  },
];

export const MODERATION_OBSERVABLE_IDS: readonly string[] =
  MODERATION_OBSERVABLE.map((o) => o.id);
