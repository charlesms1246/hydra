/**
 * Appealing a decision — `decisions/0035` §5, to the no-nonce shape of `decisions/0037`.
 *
 * The instrument is a signature from the account that published, which is the only identity this
 * system has and exists only because publishing is on chain. What this file checks is the part that
 * is replayable if it is wrong, and the part that is a deanonymisation vector if it is delivered
 * carelessly.
 *
 * THE NONCE IS GONE AND MOST OF THIS FILE CHANGED WITH IT. The previous version had the operator
 * mint a challenge and hand it to the appellant, which reintroduced the exact disclosure the
 * detached artifact exists to remove — fetching it is a connection the appellant makes, correlated
 * to the decision they are contesting. The tests that checked the nonce's own properties are not
 * replaced by weaker ones; they are replaced by tests of the two properties the nonce was carrying,
 * both of which are carried by something else now.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Appeals, appealStatement, appealDigest } from "../../moderation/src/appeals.ts";
import { MODERATION_OBSERVABLE, MODERATION_OBSERVABLE_IDS }
  from "../../moderation/src/observations.ts";
import { Reports } from "../../moderation/src/reports.ts";

const yes = async () => true;
const no = async () => false;
const ACCOUNT = "0x04a2b3";

test("the signature is bound to the DECISION, so it cannot be moved to another", () => {
  // The nonce's first job, and the one it never needed to do: binding carries it. A signature over
  // a bare statement appeals whatever the holder points it at.
  assert.notEqual(appealDigest("decision-a"), appealDigest("decision-b"),
    "two decisions produce the same statement, so the binding is missing");
  // Deterministic, which is what makes the artifact relayable at all.
  assert.equal(appealDigest("decision-a"), appealDigest("decision-a"));
});

test("THE SAME DECISION CANNOT BE APPEALED TWICE, which is what the nonce used to do", async () => {
  // The nonce's second job, now carried by the record the operator has to keep anyway — appeal
  // outcomes go in the transparency report, so one appeal per (decision, account) is not extra
  // machinery, it is the machinery that was already required.
  const a = new Appeals();
  assert.deepEqual(await a.accept("d1", ACCOUNT, ["sig"], 0, yes), { accepted: true });
  const again = await a.accept("d1", ACCOUNT, ["sig"], 1, yes);
  assert.equal(again.accepted, false);
  assert.match(String(again.reason), /already appealed/);
  assert.equal(a.filed().length, 1, "a replayed artifact created a second appeal");
  // A DIFFERENT account may still appeal the same decision. The key is the pair, not the decision:
  // several accounts can be affected by one removal and each has its own standing.
  assert.deepEqual(await a.accept("d1", "0x0999", ["sig"], 2, yes), { accepted: true });
  // And the same account may appeal a different decision.
  assert.deepEqual(await a.accept("d2", ACCOUNT, ["sig"], 3, yes), { accepted: true });
  assert.equal(a.filed().length, 3);
});

test("FRESHNESS COMES FROM THE DECISION ID EXISTING, not from a nonce", () => {
  // The property that makes the nonce redundant rather than merely inconvenient: a decision id is
  // minted when the decision is made, so a signature over it cannot predate what it contests. That
  // is the only time-ordering an appeal needs — there is no scenario where an appeal must be
  // provably recent, only one where it must be provably about this decision.
  const q = new Reports();
  q.file("pub:x", "a report", 0);
  const decided = q.decide("pub:x", "removed", "impersonation", 10);
  assert.ok(decided.id.length >= 32, "a decision id short enough to guess is a forgeable statement");
  // Two decisions about the same object at the same instant still differ, so an appeal against one
  // is not an appeal against the other.
  q.file("pub:x", "another report", 11);
  const second = q.decide("pub:x", "kept", "impersonation", 10);
  assert.notEqual(decided.id, second.id);
  assert.notEqual(appealDigest(decided.id), appealDigest(second.id));
});

test("the domain string is fixed and first, so an appeal is not some other signature", () => {
  // Two signatures by one key over overlapping fields is how a signature for one purpose becomes a
  // signature for another. The account signing here also signs Starknet transactions.
  const s = appealStatement("d1");
  assert.ok(s.subarray(0, 27).toString().startsWith("hydra/moderation/appeal/v1 "));
  assert.ok(s.includes("d1"));
});

test("A FAILED SIGNATURE CONSUMES NOTHING — burning an appeal is a denial of service", async () => {
  // REVERSED DELIBERATELY. The previous version consumed the challenge before verifying, to stop an
  // attacker grinding signatures against a live one. That defence had the SECRET CHALLENGE as its
  // premise, and there is no challenge to grind now — so consuming on failure buys nothing and
  // costs the appellant their one attempt at contesting a decision, at the moment they have no
  // other recourse. Anyone who knows a decision id could do it.
  const a = new Appeals();
  for (let i = 0; i < 5; i++) {
    const junk = await a.accept("d1", ACCOUNT, ["not a signature"], i, no);
    assert.equal(junk.accepted, false);
    assert.match(String(junk.reason), /did not verify/);
  }
  assert.equal(a.filed().length, 0, "a failed appeal was recorded, so an attempt names an account");
  // The real appellant still gets through afterwards.
  assert.deepEqual(await a.accept("d1", ACCOUNT, ["real"], 9, yes), { accepted: true });
});

test("an unverified attempt leaves no trace that anybody appealed", async () => {
  // A store of attempted-but-unproven appeals would name accounts that never signed for one — and
  // anyone can submit an unproven attempt naming any account, so such a store is attacker-writable.
  const a = new Appeals();
  await a.accept("d1", "0xvictim", ["forged"], 0, no);
  assert.deepEqual(a.filed(), []);
  assert.deepEqual(a.outstanding(), []);
});

test("an appeal waits until it is resolved, and then reports its outcome", async () => {
  const a = new Appeals();
  await a.accept("d1", ACCOUNT, ["sig"], 5, yes);
  assert.equal(a.outstanding().length, 1);
  const resolved = a.resolve("d1", ACCOUNT, "upheld");
  assert.equal(resolved.outcome, "upheld");
  assert.equal(resolved.at, 5, "resolving an appeal moved when it was filed");
  assert.deepEqual(a.outstanding(), []);
  assert.equal(a.filed().length, 1, "resolving created a second record");
  assert.throws(() => a.resolve("d1", "0xnobody", "denied"), /no appeal from/);
});

test("THE APPEAL IS DETACHED, so proving authorship need not disclose a network path", () => {
  // The strongest deanonymisation step in the pipeline, and the reason the artifact is shaped this
  // way. Before an appeal the operator knows account X published post P — public, already
  // disclosed. If it arrives over a connection they terminate they also hold an IP, an SNI and a
  // TLS session correlated to a Starknet account.
  //
  // The digest is a pure function of the decision id, so nothing about verifying it requires the
  // verifier to have received it from the signer, and NOTHING HAD TO BE FETCHED TO MAKE IT. That
  // second clause is the one the nonce broke: a relayable artifact you must appear in person to
  // collect is not relayable.
  assert.equal(appealDigest("decision-1"), appealDigest("decision-1"));
  const constructedOffline = appealDigest("decision-1");
  assert.equal(constructedOffline.length, 64);
  // The whole module exposes no way to obtain a challenge, because there is none to obtain.
  assert.equal(typeof (Appeals as unknown as { issue?: unknown }).issue, "undefined");

  // And the row says so, which is where a user finds out before they choose how to send it.
  const row = MODERATION_OBSERVABLE.find((o) => o.id === "appeal.filed")!;
  assert.match(row.why, /DETACHED/);
  assert.match(row.why, /IP, an SNI and a TLS session/);
  assert.match(row.why, /before sending/);
});

test("the moderation table names every surface moderation actually has", () => {
  // A third table, because the vault cannot produce these rows and documenting them on its table
  // would be the over-claiming failure `operator-view.test.ts` exists to catch.
  //
  // `report.connection` was added when intake was BUILT, and this guard is what noticed the
  // difference. `report.filed` says a reporter identity is "deliberately absent" — true of the
  // record and not of the socket, and a table describing what is KEPT rather than what is SEEN
  // under-claims, which is the dangerous direction.
  assert.deepEqual([...MODERATION_OBSERVABLE_IDS].sort(),
    ["appeal.filed", "decision.recorded", "report.connection", "report.filed", "report.published"]);
  for (const o of MODERATION_OBSERVABLE) {
    assert.ok(o.what.length > 20, `${o.id} has no description`);
    assert.ok(o.why.length > 60, `${o.id} has no reason`);
  }
  // And `decision.recorded` describes the record that actually exists.
  const q = new Reports();
  q.file("pub:a", "body", 0);
  const d = q.decide("pub:a", "removed", "impersonation", 1);
  assert.deepEqual(Object.keys(d).sort(), ["at", "blobId", "category", "id", "outcome"]);
  const row = MODERATION_OBSERVABLE.find((o) => o.id === "decision.recorded")!;
  for (const field of ["blob id", "outcome", "category", "date"]) {
    assert.ok(row.what.toLowerCase().includes(field), `the row does not mention ${field}`);
  }
  // The identifier is on the table too, with the reason it is not a counter.
  assert.match(row.what, /opaque identifier/);
  assert.match(row.why, /NEVER A COUNTER/);
  // And the connection row says the two things that make it honest: what is visible, and that
  // relaying is a real but PARTIAL mitigation — a reporter who submits from their own connection
  // still tells the operator they were the one who looked.
  const conn = MODERATION_OBSERVABLE.find((o) => o.id === "report.connection")!;
  assert.match(conn.what, /network address/);
  assert.match(conn.why, /relayed/);
  assert.match(conn.why, /cannot be mitigated/);
});
