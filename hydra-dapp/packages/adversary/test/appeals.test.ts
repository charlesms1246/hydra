/**
 * Appealing a removal — `decisions/0035` §5.
 *
 * The instrument is a signature from the account that published, which is the only identity this
 * system has and exists only because publishing is on chain. What this file checks is the part
 * that is replayable if it is wrong, and the part that is a deanonymisation vector if it is
 * delivered carelessly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Challenges, appealStatement, appealDigest, CHALLENGE_TTL_MS,
} from "../../moderation/src/appeals.ts";
import { MODERATION_OBSERVABLE, MODERATION_OBSERVABLE_IDS }
  from "../../moderation/src/observations.ts";
import { Reports } from "../../moderation/src/reports.ts";

const yes = async () => true;
const no = async () => false;

test("the signature is bound to the DECISION, so it cannot be moved to another", () => {
  // A signature over a bare challenge appeals whatever the holder points it at. Binding is what
  // makes an appeal about one decision.
  const q = new Challenges();
  const a = q.issue("decision-1", 0, "aa".repeat(16));
  const b = q.issue("decision-2", 0, "aa".repeat(16));
  assert.notEqual(appealDigest(a), appealDigest(b),
    "two decisions with the same nonce produce the same statement — the binding is missing");
  assert.match(appealStatement(a).toString("utf8"), /^hydra\/moderation\/appeal\/v1 decision-1/);
});

test("and to a NONCE, so the same decision cannot be appealed twice with one signature", () => {
  const q = new Challenges();
  const first = q.issue("decision-1", 0);
  const second = q.issue("decision-1", 0);
  assert.notEqual(first.nonce, second.nonce, "two challenges shared a nonce");
  assert.notEqual(appealDigest(first), appealDigest(second));
});

test("the domain string is fixed and first, so an appeal is not some other signature", () => {
  // Two signatures by one key over overlapping fields is how a signature for one purpose becomes
  // a signature for another. `anchorStatement` and `prekeyStatement` both begin with their own
  // domain for the same reason.
  const q = new Challenges();
  const c = q.issue("d", 0);
  assert.ok(appealStatement(c).subarray(0, 27).toString("utf8")
    .startsWith("hydra/moderation/appeal/v1 "));
});

test("A CHALLENGE IS SINGLE USE, and is consumed even when the signature fails", async () => {
  // Consumed on failure too, or it is an oracle: an attacker grinds signatures against a
  // challenge that survives every wrong answer.
  const q = new Challenges();
  const c = q.issue("d", 0);
  assert.deepEqual(await q.accept(c.nonce, "0xacct", ["sig"], 1, no),
    { accepted: false, reason: "the signature did not verify" });
  assert.deepEqual(await q.accept(c.nonce, "0xacct", ["sig"], 2, yes),
    { accepted: false, reason: "no such challenge, or it has been used" });
  assert.deepEqual(q.outstanding(), [], "a consumed challenge is still outstanding");
});

test("and it expires, so an unused one is not a standing capability", async () => {
  // Single-use alone would let a challenge sit forever — an ability to appeal at a moment of the
  // holder's choosing, which is a different thing from an ability to appeal.
  const q = new Challenges();
  const c = q.issue("d", 0);
  const r = await q.accept(c.nonce, "0xacct", ["sig"], CHALLENGE_TTL_MS + 1, yes);
  assert.deepEqual(r, { accepted: false, reason: "the challenge has expired" });
});

test("a valid appeal is accepted once", async () => {
  const q = new Challenges();
  const c = q.issue("decision-9", 100);
  const seen: string[] = [];
  const check = async (account: string, digest: string) => {
    seen.push(`${account}:${digest}`);
    return digest === appealDigest(c);
  };
  assert.deepEqual(await q.accept(c.nonce, "0xpublisher", ["r", "s"], 200, check), { accepted: true });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^0xpublisher:/);
});

test("THE APPEAL IS DETACHED, so proving authorship need not disclose a network path", () => {
  // The strongest deanonymisation step in the pipeline, and the reason the artifact is shaped this
  // way. Before an appeal the operator knows account X published post P — public, already
  // disclosed. If it arrives over a connection they terminate they also hold an IP, an SNI and a
  // TLS session correlated to a Starknet account.
  //
  // A signature over a statement is self-authenticating: nothing about verifying it requires the
  // verifier to have received it from the signer. So this asserts the shape rather than a
  // behaviour — the digest is a pure function of the challenge, so a third party can carry it.
  const q = new Challenges();
  const c = q.issue("decision-1", 0);
  assert.equal(appealDigest(c), appealDigest({ ...c }),
    "the digest depends on something other than the challenge, so it cannot be relayed");
  // And the row says so, which is where a user finds out before they choose how to send it.
  const row = MODERATION_OBSERVABLE.find((o) => o.id === "appeal.filed")!;
  assert.match(row.why, /DETACHED/);
  assert.match(row.why, /IP, an SNI and a TLS session/);
  assert.match(row.why, /before sending/);
});

test("the moderation table names every surface moderation actually has", () => {
  // A third table, because the vault cannot produce these rows and documenting them on its table
  // would be the over-claiming failure `operator-view.test.ts` exists to catch.
  assert.deepEqual([...MODERATION_OBSERVABLE_IDS].sort(),
    ["appeal.filed", "decision.recorded", "report.filed"]);
  for (const o of MODERATION_OBSERVABLE) {
    assert.ok(o.what.length > 20, `${o.id} has no description`);
    assert.ok(o.why.length > 60, `${o.id} has no reason`);
  }
  // And `decision.recorded` describes the record that actually exists.
  const q = new Reports();
  q.file("pub:a", "body", 0);
  const d = q.decide("pub:a", "removed", "impersonation", 1);
  assert.deepEqual(Object.keys(d).sort(), ["at", "blobId", "category", "outcome"]);
  const row = MODERATION_OBSERVABLE.find((o) => o.id === "decision.recorded")!;
  for (const field of ["blob id", "outcome", "category", "date"]) {
    assert.ok(row.what.toLowerCase().includes(field), `the row does not mention ${field}`);
  }
});
