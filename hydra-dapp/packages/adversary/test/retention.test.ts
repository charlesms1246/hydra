/**
 * D8 — kept decisions expire, removals are retained, and appeals are untouched.
 *
 * The objection that looked fatal and dissolved: expiring decisions seemed to require inventing an
 * appeal deadline, since an appeal names the decision it contests. That holds for REMOVALS — and
 * removals are not what expires. **Nobody can appeal a keep.** The appellant is the author; an
 * author whose content stayed up has nothing to contest; and a reporter cannot appeal at all,
 * because the mechanism is a signature from the publishing account and a reporter does not hold
 * one. So the artifact keeps its no-expiry property and recourse is not narrowed by a day.
 *
 * What expires is the accused-but-innocent file: a permanent record that somebody was reported and
 * cleared, which is the most harmful thing here to retain and the least useful to anyone but a
 * process demanding it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Reports } from "../../moderation/src/reports.ts";
import { report } from "../../moderation/src/transparency.ts";

const SEP = Date.UTC(2026, 8, 15);
const OCT = Date.UTC(2026, 9, 15);
const NOV = Date.UTC(2026, 10, 2);
const DEC = Date.UTC(2026, 11, 2);
const period = (y: number, m: number) => ({ from: Date.UTC(y, m, 1), to: Date.UTC(y, m + 1, 1) });

function seeded() {
  const q = new Reports();
  q.file("pub:kept", "a report", SEP);
  q.decide("pub:kept", "kept", "harassment", SEP);
  q.file("pub:gone", "another", SEP);
  q.decide("pub:gone", "removed", "impersonation", SEP);
  return q;
}

test("EXPIRY NEVER PRECEDES PUBLICATION of the period the decision falls in", () => {
  // The hard constraint, and it is a test rather than a comment because breaking it makes the
  // period's report ungeneratable and every past report unreproducible.
  const q = seeded();
  // Years pass. Nothing is published, so nothing expires — the age of a decision is not the clock.
  for (const t of [OCT, NOV, DEC, Date.UTC(2030, 0, 1)]) {
    assert.equal(q.expire(t), 0, `a decision expired at ${new Date(t).toISOString()} unpublished`);
  }
  assert.equal(q.decisions().length, 2);
  // The report for that period is still generatable, which is what the constraint protects.
  const out = report(q.decisions(), 0, period(2026, 8));
  assert.ok(out.figures.some((f) => f.label === "harassment / kept"));
});

test("A KEPT DECISION GOES ONE PERIOD AFTER ITS OWN IS PUBLISHED — and a removal never does", () => {
  const q = seeded();
  q.markPublished(Reports.periodKey(SEP));

  // Published, but September's successor has not closed yet. Too early.
  assert.equal(q.expire(OCT), 0, "a kept decision expired before one further period had closed");
  // November: October has closed. Now it goes.
  assert.equal(q.expire(NOV), 1);
  const left = q.decisions();
  assert.equal(left.length, 1);
  assert.equal(left[0].outcome, "removed",
    "the wrong class expired — removals are retained and keeps are not");

  // And it stays gone rather than being counted again.
  assert.equal(q.expire(DEC), 0);
});

test("THE PUBLISHED REPORT STAYS REPRODUCIBLE after the expiry it triggered", () => {
  // The point of requiring publication first. A report generated in November for September must
  // still be generatable in December, with the same figures, after the kept cell aged out.
  const q = seeded();
  const sept = period(2026, 8);
  const before = report(q.decisions(), 0, sept);
  q.markPublished(Reports.periodKey(SEP));
  q.expire(NOV);
  const after = report(q.decisions(), 0, sept);

  // The removed cell and the named id survive exactly.
  assert.deepEqual(after.removedIds, before.removedIds);
  assert.ok(after.figures.some((f) => f.label === "impersonation / removed"));
  // The kept cell is gone from the record — which is the intended loss, and it is why publication
  // has to come first: the published report is the durable artifact for that cell, banded.
  assert.ok(before.figures.some((f) => f.label === "harassment / kept"));
  assert.ok(!after.figures.some((f) => f.label === "harassment / kept"));
  assert.ok(before.lines.some((l) => l.includes("harassment / kept: fewer than")),
    "the published report never carried the cell it is supposed to preserve");
});

test("an appeal against a retained removal survives, because keeps are what expire", async () => {
  // The property that made the objection dissolve, asserted rather than argued: the appeal path
  // only ever runs against the class that stays, so its no-expiry artifact is unaffected.
  const q = seeded();
  const removal = q.decisions().find((d) => d.outcome === "removed")!;
  assert.deepEqual(await q.appeals.accept(removal.id, "0xauthor", ["sig"], SEP, async () => true),
    { accepted: true });

  q.markPublished(Reports.periodKey(SEP));
  q.expire(Date.UTC(2031, 0, 1));

  assert.ok(q.decisions().some((d) => d.id === removal.id),
    "the decision an appeal names was expired out from under it");
  assert.equal(q.appeals.filed().length, 1);
});

test("the store survives a restart with its published periods intact", () => {
  // Expiry that forgets what was published would restart every clock at zero, so the periods have
  // to persist with the decisions. Version 3 of the snapshot; older files migrate.
  const q = seeded();
  q.markPublished(Reports.periodKey(SEP));
  const back = Reports.restore(JSON.parse(JSON.stringify(q.snapshot())));
  assert.deepEqual(back.published(), [Reports.periodKey(SEP)]);
  assert.equal(back.expire(NOV), 1, "the expiry clock reset across a restart");

  // And a version-1 file still loads, with no published periods and nothing expired.
  const v1 = { version: 1, open: [], decided: q.decisions(), received: [] };
  const old = Reports.restore(v1 as never);
  assert.deepEqual(old.published(), []);
  assert.equal(old.expire(Date.UTC(2031, 0, 1)), 0);
});
