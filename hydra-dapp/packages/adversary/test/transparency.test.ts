/**
 * The transparency report — `decisions/0035` §6.
 *
 * The thing this file is really about: **at launch volumes a transparency report is a disclosure
 * mechanism, not a transparency one.** A new service with a small public corpus publishes cells of
 * size one and two by default, and a reader with the public timeline can work out which post a
 * count of one refers to. The report is most dangerous exactly when it is least informative.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Reports } from "../../moderation/src/reports.ts";
import { report, band, FLOOR } from "../../moderation/src/transparency.ts";
import { MODERATION_OBSERVABLE_IDS } from "../../moderation/src/observations.ts";

const ALL = { from: 0, to: 1_000_000 };

/** n decided public objects, all removed under one category. */
const withDecisions = (n: number, outcome: "removed" | "kept" = "removed") => {
  const q = new Reports();
  for (let i = 0; i < n; i++) {
    q.file(`pub:${i}`, `body ${i}`, i);
    q.decide(`pub:${i}`, outcome, "impersonation", i);
  }
  return q;
};

test("BANDING INCLUDES ZERO, or the suppression announces what it hides", () => {
  // The subtlety, and the obvious implementation gets it wrong. Report true zeros as "0" and small
  // counts as "fewer than 5", and "fewer than 5" now means AT LEAST ONE — so banding a cell
  // announces the cell is non-empty, which is exactly what suppression was for.
  //
  // The band is 0..FLOOR-1 inclusive, so an empty category and a rare one read identically.
  assert.equal(band(0), `fewer than ${FLOOR}`);
  assert.equal(band(1), `fewer than ${FLOOR}`);
  assert.equal(band(FLOOR - 1), `fewer than ${FLOOR}`);
  assert.equal(band(FLOOR), String(FLOOR));
  assert.notEqual(band(0), "0", "a true zero is distinguishable from a banded small count");
});

test("a banded cell is stated NOT to mean none", () => {
  // `decisions/0029`'s unknown-is-not-zero in a third costume: a reader who assumes a suppressed
  // cell is empty has been misled by the safety mechanism. So the number and its limit arrive
  // together, in the report itself rather than in a policy document.
  const q = withDecisions(2);
  const out = report(q.decisions(), q.received(), ALL);
  const text = out.lines.join(" ");
  assert.match(text, new RegExp(`fewer than ${FLOOR}`));
  assert.match(text, /INCLUDES ZERO/);
  assert.match(text, /does\s+not mean none/);
  assert.equal(out.floor, FLOOR, "the threshold is not published, so a reader must trust it");
});

test("the report says less when there is less to say, and that is it being correct", () => {
  // Launch condition: one removal, one category. Everything bands.
  const q = withDecisions(1);
  const out = report(q.decisions(), q.received(), ALL);
  for (const line of out.lines.filter((l) => /^(Reports|Decisions|Category)/.test(l))) {
    assert.match(line, new RegExp(`fewer than ${FLOOR}`),
      `a launch-volume cell was published as an exact count: ${line}`);
  }
  // And at volume it says the numbers.
  const busy = withDecisions(40);
  assert.match(report(busy.decisions(), busy.received(), ALL).lines[0], /Reports received: 40/);
});

test("ENCRYPTED DELETIONS DO NOT APPEAR — they are not decisions about anyone", () => {
  // A capability deletion is somebody deleting their own object. Listing it would turn a
  // transparency mechanism into a log of private deletions.
  const q = new Reports();
  for (let i = 0; i < 9; i++) { q.file(`pub:${i}`, "b", i); q.decide(`pub:${i}`, "removed", "c", i); }
  for (let i = 0; i < 9; i++) { q.file(`enc:${i}`, "b", i); q.decide(`enc:${i}`, "removed", "c", i); }
  const out = report(q.decisions(), q.received(), ALL);
  assert.ok(out.removedIds.every((id) => id.startsWith("pub:")),
    "an encrypted object's id was published in the transparency report");
  assert.equal(out.removedIds.length, 9);
  assert.match(out.lines.join(" "), /Deletions of encrypted objects are not listed/);
  // The decision COUNT is public-class only too, not just the id list.
  assert.match(out.lines[1], /Decisions: 9/);
});

test("naming a removed public id is a choice, and it is bounded to that class", () => {
  // Defensible for public content: the object was public and the on-chain commitment still stands,
  // so a removal anyone can verify against it is the mechanism this design chose. The cost is a
  // permanent index of removed content, which is why it is decided once rather than by default.
  const q = withDecisions(9);
  const out = report(q.decisions(), q.received(), ALL);
  assert.deepEqual(out.removedIds, [...out.removedIds].sort(), "the ids leak decision order");
  // Kept objects are not named — only removals, which is what a reader can check against the chain.
  const mixed = new Reports();
  for (let i = 0; i < 9; i++) {
    mixed.file(`pub:${i}`, "b", i);
    mixed.decide(`pub:${i}`, i < 5 ? "removed" : "kept", "c", i);
  }
  assert.equal(report(mixed.decisions(), mixed.received(), ALL).removedIds.length, 5);
});

test("the report is generated from the record, and the record kept enough", () => {
  // The gate that had to be checked BEFORE the generator was written: does an honest report need a
  // field the decision record does not keep? It needed two — reports received, which is discarded
  // when a review is decided, and appeals, which had no record at all.
  //
  // Resolved with AGGREGATE COUNTERS rather than by widening the record, so D8's minimum stands:
  // a count of reports carries nothing about who filed them or which item they concerned.
  const q = withDecisions(6);
  for (const d of q.decisions()) {
    assert.deepEqual(Object.keys(d).sort(), ["at", "blobId", "category", "outcome"],
      "the decision record grew a field to serve the report");
  }
  assert.equal(q.received(), 6);
  // The class is derived from the id rather than stored, which is why no `class` field was needed.
  assert.ok(q.decisions().every((d) => d.blobId.startsWith("pub:")));
});

test("the period bounds what is counted", () => {
  const q = new Reports();
  for (let i = 0; i < 12; i++) { q.file(`pub:${i}`, "b", i); q.decide(`pub:${i}`, "removed", "c", i); }
  assert.match(report(q.decisions(), q.received(), { from: 0, to: 6 }).lines[1], /Decisions: 6/);
  assert.equal(report(q.decisions(), q.received(), { from: 0, to: 6 }).removedIds.length, 6);
});

test("the report itself is on the moderation table", () => {
  // It is published, so it is public by construction — but what it reveals about the service's
  // operations over time is a disclosure, and standing rule 4 does not exempt things that are
  // already public.
  assert.ok(MODERATION_OBSERVABLE_IDS.includes("report.published"),
    "the transparency report is not on the moderation disclosure table");
});
