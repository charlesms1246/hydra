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
import { Appeals, type Appeal } from "../../moderation/src/appeals.ts";
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
    assert.deepEqual(Object.keys(d).sort(), ["at", "blobId", "category", "id", "outcome"],
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
  assert.ok(out.lines.some((l) => l.includes("below the floor")),
    "the report no longer explains why the number a reader most wants is missing");
});

test("ROUNDING THE VOLUME WOULD NOT RESCUE IT EITHER — the general reason", () => {
  // "Band it" fails because a band above the floor is the number itself. The obvious next
  // proposal is "round it, so the residual is a RANGE rather than a value" — and it was made,
  // and it is also wrong. Kept here with the arithmetic because the argument is what survives,
  // not the conclusion.
  //
  // A range does not protect a cell whose own range is bounded. The attacker intersects the two:
  // the suppressed cell is known to lie in [0, FLOOR) simply because it was suppressed, so a
  // residual interval overlapping that range in ONE place pins it exactly.
  const FLOOR_ = FLOOR;
  const width = 5;              // round volume to a multiple of this
  const published = [7, 9];     // cells shown exactly
  const suppressed = 4;         // the banded cell's true value
  const volume = published.reduce((a, b) => a + b, 0) + suppressed;

  const bucketStart = Math.floor(volume / width) * width;
  const sum = published.reduce((a, b) => a + b, 0);
  // The residual the attacker computes: bucket minus what was published, an interval of width w.
  const lo = bucketStart - sum;
  const hi = bucketStart + width - sum;
  // Intersected with what suppression itself reveals — that the cell is below the floor.
  const candidates = [];
  for (let v = Math.max(0, lo); v < Math.min(FLOOR_, hi); v++) candidates.push(v);

  assert.deepEqual(candidates, [suppressed],
    "the counterexample no longer pins the cell — recheck it before trusting rounding");

  // And the alignment that does it is not rare: it happens whenever the bucket floor sits
  // exactly FLOOR-1 above the published sum, which for a report published on a schedule is a
  // matter of when, not whether. A WIDER bucket narrows the intersection rather than removing it.
  assert.equal(bucketStart - sum, FLOOR_ - 1, "the pinning condition is stated wrong");
  for (const w of [10, 20, 50]) {
    const start = Math.floor(volume / w) * w;
    const wide = [];
    for (let v = Math.max(0, start - sum); v < Math.min(FLOOR_, start + w - sum); v++) wide.push(v);
    assert.ok(wide.length <= FLOOR_, `a width of ${w} somehow widened the candidate set`);
  }

  // THE GENERAL STATEMENT, which is the version that survives the next proposal: any figure
  // published over the SAME EVENTS, at ANY granularity, can intersect a suppressed cell's range
  // down to a point. Report volume is therefore not published in any form — see transparency.ts.
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

test("A DECISION ID IS NOT A COUNTER, or the floor is gone via a field nobody calls a figure", () => {
  // Three commits went into making the total number of decisions underivable from any combination
  // of published cells. An appeal has to NAME the decision it contests, so the id is disclosed to
  // an appellant and travels in the artifact — and a sequential id hands over that same total in
  // one field. The report would still be perfectly banded and the number would still be public.
  const q = new Reports();
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    q.file(`pub:${i}`, "b", i);
    ids.push(q.decide(`pub:${i}`, "kept", "spam", i).id);
  }
  assert.equal(new Set(ids).size, ids.length, "decision ids collided");
  // Not a counter in any base, and not merely "not equal to i": consecutive ids must not differ by
  // a constant, which is what a prefixed or offset counter looks like.
  const gaps = new Set<number>();
  for (let i = 1; i < ids.length; i++) {
    const a = Number.parseInt(ids[i - 1], 16);
    const b = Number.parseInt(ids[i], 16);
    if (Number.isFinite(a) && Number.isFinite(b)) gaps.add(b - a);
  }
  assert.ok(gaps.size > 1, "decision ids advance by a fixed step, so they are a counter");
  // Long enough that the space cannot be walked to enumerate decisions, which would recover the
  // total by a different route.
  for (const id of ids) assert.ok(id.length >= 32, `a decision id is only ${id.length} chars`);
  // And nothing else in the record counts. `at` is a timestamp, which is disclosed on purpose.
  const d = q.decisions()[0];
  assert.deepEqual(Object.keys(d).sort(), ["at", "blobId", "category", "id", "outcome"]);
});

test("APPEAL CELLS DO NOT BRIDGE TO A SUPPRESSED DECISION CELL", () => {
  // Appeal outcomes are published on the same floor and in the same partition style, and that is
  // the exact move that failed for report volume — a second event set printed beside the first,
  // whose residual could stand in for a suppressed cell. So it is settled by the instrument rather
  // than by the argument that appeals are "not a partition of decisions".
  //
  // The structural reason it holds: appeal cells count RESOLVED APPEALS, which are not a cover of
  // the decisions and do not sum to any decision figure. The separate reason pending appeals are
  // excluded is CROSS-PERIOD and has its own test below.
  const q = new Reports();
  const shape: [string, "removed" | "kept"][] = [
    ...Array.from({ length: 7 }, () => ["impersonation", "removed"] as [string, "removed"]),
    ...Array.from({ length: 2 }, () => ["impersonation", "kept"] as [string, "kept"]),
    ...Array.from({ length: 6 }, () => ["harassment", "removed"] as [string, "removed"]),
  ];
  const ids: string[] = [];
  shape.forEach(([category, outcome], i) => {
    q.file(`pub:${i}`, "b", i);
    ids.push(q.decide(`pub:${i}`, outcome, category, i).id);
  });

  const appeals = new Appeals();
  const built: Appeal[] = [];
  // Nine resolved appeals: 6 reversed, 3 stood — the second lands under the floor and is banded.
  for (let i = 0; i < 9; i++) {
    const account = `0x${i}`;
    void appeals.accept(ids[i], account, ["sig"], i, async () => true);
    built.push({ decisionId: ids[i], account, at: i, outcome: i < 6 ? "upheld" : "denied" });
  }
  // Plus four PENDING, which must not appear anywhere: if they did, the outcome cells would sum to
  // appeals-filed and that total is a bridge by construction.
  for (let i = 9; i < 13; i++) built.push({ decisionId: ids[i], account: `0x${i}`, at: i });

  const out = report(q.decisions(), q.receivedIn(0), ALL, built);
  const known = out.figures.filter((f) => f.shown !== `fewer than ${FLOOR}`).map((f) => Number(f.shown));
  assert.ok(known.every(Number.isFinite), "a published figure is neither a number nor a band");
  // Both suppressed cells: the decision cell at 2 and the appeal cell at 3.
  const suppressed = [2, 3];

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
  const derivable = suppressed.filter((v) => reachable.has(v));
  assert.deepEqual(derivable, [],
    `publishing appeal outcomes made the suppressed cell(s) ${derivable.join(", ")} reachable`);

  // The banded cells really were banded, or this proves nothing.
  assert.equal(out.figures.filter((f) => f.shown === `fewer than ${FLOOR}`).length, 2);
  // Nothing named "pending" or "filed" is published.
  assert.ok(!out.figures.some((f) => /pending|filed/i.test(f.label)),
    "an appeal total was published, which is a bridge by construction");
  // And "upheld" is spelled out, because the bare word is read both ways and a transparency
  // report whose central term is ambiguous discloses nothing reliably.
  assert.ok(out.figures.some((f) => f.label === "appeals / decision reversed"));
});

test("A PENDING COUNT WOULD DIFFERENCE ACROSS PERIODS, which is why none is published", () => {
  // A shape this report had not met: every earlier differencing case was inside one report, and
  // this one spans two, neither of which is unsafe on its own.
  //
  // A pending appeal MUST EVENTUALLY RESOLVE. That ties one period's figure to the next period's
  // by construction — publish `pending: 12` in September, then `reversed: 8` in October with
  // `stood` banded, and 12 − 8 = 4 pins the banded cell. The floor held in both reports.
  const pending = 12;
  const reversedNextPeriod = 8;
  const stoodNextPeriod = 4;           // banded, being below the floor
  assert.ok(stoodNextPeriod < FLOOR, "the fixture no longer suppresses the cell it is about");
  assert.equal(pending - reversedNextPeriod, stoodNextPeriod,
    "the cross-period residual no longer pins the cell — recheck before publishing pending");

  // MEASURED, NOT ASSUMED, and this is the part that corrected me: within a SINGLE period,
  // publishing pending does NOT bridge. The first version of the comment in transparency.ts gave
  // that as the reason and the exhaustive test disagreed, which is the test doing its job on the
  // prose rather than the code.
  const known = [7, 6, 6];
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
  assert.ok(![2, 3].some((v) => reachable.has(v)),
    "the single-period case now bridges too, so the comment in transparency.ts is understated");

  // And the report publishes no such figure, under any label.
  const q = new Reports();
  q.file("pub:a", "b", 0);
  const d = q.decide("pub:a", "removed", "spam", 0);
  const out = report(q.decisions(), 0, ALL,
    [{ decisionId: d.id, account: "0x1", at: 0 }]);
  assert.ok(!out.figures.some((f) => /pending|outstanding|filed/i.test(f.label)),
    "a pending-appeal figure is published, and it differences against the next period");
});
