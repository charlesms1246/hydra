/**
 * Report intake, and the two ways deduplication turns into the attack it defends against.
 *
 * `decisions/0035` §2. Report-flooding is censorship rather than spam, and the defence cannot be a
 * rate limit per reporter because `uploader.identity` says there is no reporter — this service has
 * no accounts, and anything that identified one well enough to limit them would be the first
 * identity in the system.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Reports, summarise, BODIES_KEPT } from "../../vault-server/src/reports.ts";

const GENUINE = "this is my leaked medical record";
const FLOOD = "i do not like this";

test("ten thousand reports produce ONE review, so labour is bounded by the corpus", () => {
  // The structural bound, and the reason it is structural rather than economic: it costs the
  // adversary nothing to file more, and it costs the operator nothing to receive them.
  const q = new Reports();
  for (let i = 0; i < 10_000; i++) q.file("pub:a", FLOOD, i);
  assert.equal(q.pending().length, 1);
  // Reporting every object produces at most one review each — bounded by the corpus, not by
  // the adversary's effort.
  for (const id of ["pub:b", "pub:c"]) q.file(id, FLOOD, 0);
  assert.equal(q.pending().length, 3);
});

test("THE ADVERSARY DOES NOT OWN THE FRAMING: a genuine report survives a flood", () => {
  // The attack this file exists for. Collapse every report into the first one and the adversary
  // files something frivolous with an innocuous description; every genuine report arriving while
  // it is pending is absorbed into it. The object IS reviewed — so the defence looks like it
  // worked — and the reviewer reads "i do not like this" instead of what the genuine reporter
  // wrote. Review happened; the information that would have changed its outcome did not.
  //
  // MEASURED ON THE FIRST VERSION OF THIS CODE, which kept the first N bodies whatever they said:
  // ten thousand identical reports with one genuine one at position 500, and the genuine body did
  // not survive. Keeping the last N is the same attack mirrored; sampling loses it with
  // probability N/total. Distinctness is what makes a loop cost one slot instead of all of them.
  const q = new Reports();
  for (let i = 0; i < 10_000; i++) q.file("pub:a", i === 500 ? GENUINE : FLOOD, i);
  const [review] = q.pending();
  assert.ok(review.reports.some((r) => r.body === GENUINE),
    "the genuine report was absorbed into the adversary's framing");
  assert.equal(review.reports.length, 2, "a repeated body took more than one slot");
  assert.equal(review.overflow, 9_998);
});

test("a perpetual-pending loop cannot control what is in the container", () => {
  // Dedup is on PENDING reviews, and the adversary chooses when a pending review exists — file
  // again the moment each decision lands and the object is never not-pending. That is now
  // harmless rather than merely bounded: holding the container open does not decide its contents.
  const q = new Reports();
  for (let round = 0; round < 5; round++) {
    q.file("pub:a", FLOOD, round * 10);
    q.file("pub:a", `${GENUINE} ${round}`, round * 10 + 1);
    const [open] = q.pending();
    assert.ok(open.reports.some((r) => r.body.startsWith(GENUINE)),
      `round ${round}: the genuine report did not reach the reviewer`);
    q.decide("pub:a", "kept", "no-action", round * 10 + 2);
  }
  assert.equal(q.history("pub:a").length, 5);
});

test("dedup is on PENDING only, or the first frivolous report immunises the object", () => {
  // Deduplicating decided reviews would mean: report a post frivolously, have it reviewed and
  // kept, and every later genuine report of the same object is deduped away. The defence becomes
  // the attack.
  const q = new Reports();
  q.file("pub:a", FLOOD, 0);
  q.decide("pub:a", "kept", "no-action", 1);
  assert.deepEqual(q.pending(), [], "a decided review stayed open");
  q.file("pub:a", GENUINE, 2);
  assert.equal(q.pending().length, 1, "the object was immunised by its first frivolous report");
  assert.equal(q.pending()[0].reports[0].body, GENUINE);
});

test("A COUNT IS NOT A PERSON COUNT, and the sentence saying so travels with it", () => {
  // `no-accounts` is exactly why it cannot be: fifty reports may be fifty people or one adversary
  // with a loop, and nothing in this system can distinguish them. That is the design working.
  //
  // So a bare count reads as weight of numbers while carrying none, and a reviewer under time
  // pressure treats "reported 50 times" as corroboration. Same failure as `0029`'s average — a
  // number that reads as more than it means, in front of somebody who acts on the reading.
  const q = new Reports();
  for (let i = 0; i < 50; i++) q.file("pub:a", `report ${i}`, i);
  const text = summarise(q.pending()[0], q.history("pub:a")).join(" ");
  assert.match(text, /50 reports/);
  assert.match(text, /not of people/, "the count is shown without its limit");
  assert.match(text, /no accounts/, "the reason the count cannot mean people is not given");
  assert.match(text, /repetition is not corroboration/);
  // And the caveat is not somewhere else on the page — it is in the same rendering as the number.
  const lines = summarise(q.pending()[0], q.history("pub:a"));
  assert.ok(lines.findIndex((l) => /not of people/.test(l)) <= 1,
    "the caveat is far enough from the count that a hurried reader will miss it");
});

test("prior DECISIONS are shown, prior VOLUME is not presented as corroboration", () => {
  // Repetition is evidence only if the repetitions are independent, and this service is designed
  // so nobody can know whether they are. A decision is a different thing: somebody looked.
  const q = new Reports();
  q.file("pub:a", FLOOD, 0);
  q.decide("pub:a", "kept", "no-action", 1);
  q.decide("pub:a", "removed", "impersonation", 2);
  q.file("pub:a", GENUINE, 3);
  const text = summarise(q.pending()[0], q.history("pub:a")).join(" ");
  assert.match(text, /Previously decided 2 times/);
  assert.match(text, /kept \(no-action\)/);
  assert.match(text, /removed \(impersonation\)/);
  // No previous decision reads differently from none shown.
  const fresh = new Reports();
  fresh.file("pub:b", GENUINE, 0);
  assert.match(summarise(fresh.pending()[0], fresh.history("pub:b")).join(" "),
    /No previous decision/);
});

test("nothing about a reporter is stored", () => {
  // D8, and the same argument as not retaining removed content one layer over: a store that names
  // reporters is discoverable and is the most dangerous file this service would keep.
  const q = new Reports();
  q.file("pub:a", GENUINE, 7);
  q.decide("pub:a", "removed", "impersonation", 8);
  const record = JSON.stringify(q.history("pub:a"));
  for (const field of ["reporter", "peer", "ip", "email", "contact", "who"]) {
    assert.ok(!record.includes(field), `a decision record carries "${field}"`);
  }
  assert.deepEqual(Object.keys(q.history("pub:a")[0]).sort(),
    ["at", "blobId", "category", "outcome"]);
  assert.equal(BODIES_KEPT, 32);
});
