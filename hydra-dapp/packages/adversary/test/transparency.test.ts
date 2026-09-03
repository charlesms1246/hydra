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
  const out = report(q.decisions(), q.receivedIn(0), ALL);
  const text = out.lines.join(" ");
  assert.match(text, new RegExp(`fewer than ${FLOOR}`));
  assert.match(text, /INCLUDES ZERO/);
  assert.match(text, /does\s+not mean none/);
  assert.equal(out.floor, FLOOR, "the threshold is not published, so a reader must trust it");
});

test("the report says less when there is less to say, and that is it being correct", () => {
  // Launch condition: one removal, one category. Everything bands.
  const q = withDecisions(1);
  const out = report(q.decisions(), q.receivedIn(0), ALL);
  for (const f of out.figures) {
    assert.equal(f.shown, `fewer than ${FLOOR}`,
      `a launch-volume cell was published as an exact count: ${f.label} = ${f.shown}`);
  }
  // And at volume it says the numbers.
  const busy = withDecisions(40);
  const loud = report(busy.decisions(), busy.receivedIn(0), ALL);
  assert.ok(loud.figures.some((f) => f.shown === "40"), "a large cell was banded");
});

test("ENCRYPTED DELETIONS DO NOT APPEAR — they are not decisions about anyone", () => {
  // A capability deletion is somebody deleting their own object. Listing it would turn a
  // transparency mechanism into a log of private deletions.
  const q = new Reports();
  for (let i = 0; i < 9; i++) { q.file(`pub:${i}`, "b", i); q.decide(`pub:${i}`, "removed", "c", i); }
  for (let i = 0; i < 9; i++) { q.file(`enc:${i}`, "b", i); q.decide(`enc:${i}`, "removed", "c", i); }
  const out = report(q.decisions(), q.receivedIn(0), ALL);
  assert.ok(out.removedIds.every((id) => id.startsWith("pub:")),
    "an encrypted object's id was published in the transparency report");
  assert.equal(out.removedIds.length, 9);
  assert.match(out.lines.join(" "), /Deletions of encrypted objects are not listed/);
  // The counts are public-class only too, not just the id list.
  assert.ok(out.figures.some((f) => f.label.includes("removed") && f.shown === "9"));
});

test("naming a removed public id is a choice, and it is bounded to that class", () => {
  // Defensible for public content: the object was public and the on-chain commitment still stands,
  // so a removal anyone can verify against it is the mechanism this design chose. The cost is a
  // permanent index of removed content, which is why it is decided once rather than by default.
  const q = withDecisions(9);
  const out = report(q.decisions(), q.receivedIn(0), ALL);
  assert.deepEqual(out.removedIds, [...out.removedIds].sort(), "the ids leak decision order");
  // Kept objects are not named — only removals, which is what a reader can check against the chain.
  const mixed = new Reports();
  for (let i = 0; i < 9; i++) {
    mixed.file(`pub:${i}`, "b", i);
    mixed.decide(`pub:${i}`, i < 5 ? "removed" : "kept", "c", i);
  }
  assert.equal(report(mixed.decisions(), mixed.receivedIn(0), ALL).removedIds.length, 5);
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
  assert.equal(q.receivedIn(0), 6);
  // The class is derived from the id rather than stored, which is why no `class` field was needed.
  assert.ok(q.decisions().every((d) => d.blobId.startsWith("pub:")));
});

test("the period bounds what is counted", () => {
  const q = new Reports();
  for (let i = 0; i < 12; i++) { q.file(`pub:${i}`, "b", i); q.decide(`pub:${i}`, "removed", "c", i); }
  const win = report(q.decisions(), q.receivedIn(0), { from: 0, to: 6 });
  assert.equal(win.removedIds.length, 6);
  assert.ok(win.figures.some((f) => f.shown === "6"));
  assert.match(win.lines[0], /^Period /, "the period boundaries are not published");
});

test("the report itself is on the moderation table", () => {
  // It is published, so it is public by construction — but what it reveals about the service's
  // operations over time is a disclosure, and standing rule 4 does not exempt things that are
  // already public.
  assert.ok(MODERATION_OBSERVABLE_IDS.includes("report.published"),
    "the transparency report is not on the moderation disclosure table");
});

test("NO COMBINATION OF PUBLISHED FIGURES LANDS BELOW THE FLOOR", () => {
  // A floor protects a cell in isolation and does nothing against arithmetic between figures.
  // The first version of this report printed `Decisions: 9 — removed 7, kept fewer than 5`, and
  // 9 − 7 = 2 pinned the banded cell exactly. Two partitions of the same events do it too: publish
  // by outcome AND by category and the total is derivable either way, so a single banded cell in
  // one partition is the total minus the rest.
  //
  // The requirement is that nothing published permits a combination landing below the floor, and
  // it is checkable rather than a matter of care — which is what makes this the test that fails
  // when somebody later adds a well-meaning "total" line.
  const q = new Reports();
  const shape: [string, "removed" | "kept"][] = [
    ...Array.from({ length: 7 }, () => ["impersonation", "removed"] as [string, "removed"]),
    ...Array.from({ length: 2 }, () => ["impersonation", "kept"] as [string, "kept"]),
    ...Array.from({ length: 6 }, () => ["harassment", "removed"] as [string, "removed"]),
  ];
  shape.forEach(([category, outcome], i) => {
    q.file(`pub:${i}`, "b", i);
    q.decide(`pub:${i}`, outcome, category, i);
  });

  const out = report(q.decisions(), q.receivedIn(0), ALL);
  // Every figure a reader can actually see as a number. Banded ones carry no value to combine.
  const known = out.figures.filter((f) => f.shown !== `fewer than ${FLOOR}`).map((f) => Number(f.shown));
  assert.ok(known.every((n) => Number.isFinite(n)), "a published figure is not a number or a band");
  // The true values of the cells that WERE banded. A leak is one of these being reachable.
  const suppressed = [2];

  // Every sum and difference of every subset. Small enough to enumerate exhaustively, which is
  // the right way to check a claim about arithmetic.
  const reachable = new Set<number>();
  for (let mask = 1; mask < 1 << known.length; mask++) {
    for (let signs = 0; signs < 1 << known.length; signs++) {
      let total = 0;
      for (let i = 0; i < known.length; i++) {
        if (!(mask & (1 << i))) continue;
        total += (signs & (1 << i)) ? -known[i] : known[i];
      }
      reachable.add(total);
    }
  }
  // A suppressed cell's TRUE VALUE being reachable is the leak. Any small number being reachable
  // is not — two published cells differing by one is arithmetic on public figures and reveals
  // nothing that was hidden. The first version of this asserted the looser thing and flagged
  // `7 − 6 = 1` as a breach, which would have been a guard nobody could satisfy.
  const derivable = suppressed.filter((v) => reachable.has(v));
  assert.deepEqual(derivable, [],
    `the suppressed cell(s) ${derivable.join(", ")} are reachable as a combination of the `
    + "published figures — the band is defeated by subtraction");
  // And the banded cell really was banded, or this proves nothing.
  assert.ok(out.figures.some((f) => f.label.includes("kept") && f.shown === `fewer than ${FLOOR}`));
});

test("BANDING THE REPORT VOLUME WOULD NOT RESCUE IT — the reason it stays unpublished", () => {
  // Written because the proposal is a good one and was made: publish "reports received" on the
  // same floor as the cells, and the residual becomes a range instead of a value. It does not,
  // and the reason generalises past this case: `band` suppresses only what is BELOW the floor,
  // so a figure large enough to be worth publishing is published EXACTLY and banding it is the
  // identity function. This test is the arithmetic, so nobody has to re-run the experiment.
  const cells = [7, 2, 6];            // the third is the suppressed one
  const volume = cells.reduce((a, b) => a + b, 0);
  assert.equal(band(volume), String(volume),
    "band() now hides a figure above the floor, and this whole argument needs redoing");
  assert.equal(volume - cells[0] - cells[2], cells[1],
    "the residual no longer equals the suppressed cell — recheck the fixture");

  // And the report does not publish it. Asserted on the FIGURES rather than the prose, because
  // prose is not a mechanism.
  const q = new Reports();
  q.file("pub:0", "b", 0);
  q.decide("pub:0", "removed", "impersonation", 0);
  const out = report(q.decisions(), 99, ALL);
  assert.ok(!out.figures.some((f) => /report/i.test(f.label)),
    "the report volume is published as a figure again — it is differenceable against the cells");
  // A coarser granularity is the thing that would work; it is a decision, not a default.
  assert.ok(out.lines.some((l) => l.includes("below the floor")),
    "the report no longer explains why the number a reader most wants is missing");
});

test("an empty period is published as empty, because a missing one is a signal", () => {
  // A report on a fixed schedule that slips, or a period silently skipped, says something — in the
  // same channel as a canary and with none of a canary's deliberateness. An empty report is data;
  // a missing one is ambiguity that reads as a signal nobody meant to send.
  const q = new Reports();
  const out = report(q.decisions(), q.receivedIn(0), { from: 0, to: 1000 });
  assert.match(out.lines[0], /^Period 1970-01-01 to 1970-01-01/);
  assert.match(out.lines.join(" "), /No decisions were made in this period/);
  // And the empty period still bands, so "nothing happened" and "almost nothing happened" read
  // the same — the point of banding zero.
  assert.ok(out.figures.every((f) => f.shown === `fewer than ${FLOOR}`));
});

test("the report is period-scoped, not cumulative, so two of them cannot be differenced", () => {
  // A lifetime counter published every period IS a cumulative figure: subtract period N from N+1
  // and the delta has no band on it. A series of individually-safe reports leaking what no single
  // report did is the same disease as the parent-and-children line, across time instead of space.
  const q = new Reports();
  const jan = Date.UTC(2026, 0, 15);
  const feb = Date.UTC(2026, 1, 15);
  for (let i = 0; i < 9; i++) q.file(`pub:jan${i}`, "b", jan);
  for (let i = 0; i < 6; i++) q.file(`pub:feb${i}`, "b", feb);
  assert.equal(q.receivedIn(jan), 9, "the counter is not scoped to the period");
  assert.equal(q.receivedIn(feb), 6, "the counter is cumulative across periods");
  assert.notEqual(q.receivedIn(feb), 15);
});
