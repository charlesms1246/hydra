/**
 * A decided report keeps no body, anywhere in the file.
 *
 * ## THIS TEST EXISTS BECAUSE A COMMENT SAID IT ALREADY DID
 *
 * `moderation/src/reports.ts` carried a sentence claiming that a file named store.test.ts checks
 * that no decided object has a body anywhere in the file. **No such file has ever existed in this
 * repository, and nothing asserted the property.** Found by hydra-d2, who
 * drove it rather than trusting either the comment or its absence: file a report, decide it,
 * snapshot, search the JSON for the reporter's text. Present before, absent after. **The code did
 * what the comment said and nothing held it there.**
 *
 * That is the worst shape this defect takes. An unguarded property is a gap; an unguarded property
 * **carrying a sentence that tells the next reader it is guarded** is a gap that repels the person
 * best placed to close it. The reader who would have written this test is exactly the reader that
 * sentence sends away.
 *
 * ## WHY THIS PROPERTY AND NOT A WEAKER ONE
 *
 * `DECISIONS-NEEDED.md` D8's stated default is that a decision carries `blobId, outcome, category,
 * at` and nothing else — **no reporter identity, ever.** A report body is reporter-supplied text:
 * it is the field most likely to name a person, quote a message, or describe a situation only one
 * party could know. A store that retains it after the human is done reading is the most dangerous
 * file this service would keep, and a retention rule that holds by accident is not a rule.
 *
 * **ASSERTED OVER THE SERIALISED BYTES, NOT THE OBJECT GRAPH.** A `decided` entry with no `body`
 * FIELD would satisfy a shape check while the same text sat in `open`, in `received`, or in a
 * field added next year. The file is what an operator's disk holds and what a subpoena would
 * reach, so the file is what is searched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Reports, BODIES_KEPT } from "../../moderation/src/reports.ts";

const SEP = Date.UTC(2026, 8, 1);

/** Distinctive enough that finding it anywhere in the JSON is unambiguous. */
const BODY = "reporter-supplied-text-6f2a1c";

test("A DECIDED REPORT'S BODY IS ABSENT FROM THE SERIALISED FILE", () => {
  const q = new Reports();
  q.file("pub:one", BODY, SEP);

  // The precondition, and it is what makes the assertion below mean anything: while the review is
  // OPEN the body IS in the file, because a human still has to read it. Without this the test
  // would pass against a store that never retained the body at all, which is a different product.
  const open = JSON.stringify(q.snapshot());
  assert.ok(open.includes(BODY),
    "the body is not in the file even while the review is open — this test cannot detect its "
    + "removal, because there is nothing to remove");

  q.decide("pub:one", "kept", "harassment", SEP);

  const after = JSON.stringify(q.snapshot());
  assert.ok(!after.includes(BODY),
    "a decided report still carries the reporter's text in the file. D8's default is `blobId, "
    + "outcome, category, at` and nothing else — a body is retained exactly as long as a human "
    + "needs to read it, and not one invocation longer");
});

test("AND ACROSS A RESTART, SO THE PROPERTY IS THE FILE'S AND NOT THE PROCESS'S", () => {
  // A store that dropped the body only in memory would pass the test above and write it to disk on
  // the next snapshot. `restore` is the path an operator tool actually takes when reopened.
  const q = new Reports();
  q.file("pub:two", BODY, SEP);
  q.decide("pub:two", "removed", "impersonation", SEP);

  const back = Reports.restore(JSON.parse(JSON.stringify(q.snapshot())));
  assert.ok(!JSON.stringify(back.snapshot()).includes(BODY),
    "the body came back through a restore, so the drop was the process's and not the file's");
});

test("A DECISION THAT IS STILL OPEN KEEPS ITS BODIES, up to the cap", () => {
  // The other half, and it is the half that makes the retention a DECISION rather than an absence:
  // an operator cannot review what they cannot read. `BODIES_KEPT` bounds it so a flood cannot
  // make the file grow without limit, which is a different concern with the same field.
  const q = new Reports();
  for (let i = 0; i < BODIES_KEPT + 5; i++) q.file("pub:three", `${BODY}-${i}`, SEP + i);
  const review = q.pending().find((r) => r.blobId === "pub:three");
  assert.ok(review, "the open review vanished, so nothing here measures retention");
  assert.ok(review.reports.length <= BODIES_KEPT,
    `an open review kept ${review.reports.length} bodies, past the ${BODIES_KEPT} cap`);
  assert.ok(review.reports.length > 0, "an open review kept no body, so it cannot be reviewed");
});
