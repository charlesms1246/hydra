/**
 * The one sentence in the transparency report that means "none", and it could be false.
 *
 * **DRIVEN ON A FRESH QUEUE, BEFORE THE FIX:**
 *
 *     decide enc:private removed spam      -> Recorded. Decision id 571c5e4d…
 *     decide oops-typo removed harassment  -> Recorded. Decision id 7d55f5b8…
 *     report 2026-09                       -> "No decisions were made in this period."
 *
 * Two recorded removals, one categorised `harassment`, and the accountability artifact denied
 * both.
 *
 * **WHY THIS OUTRANKED EVERYTHING ELSE, and the report makes the argument itself.** Its own
 * preamble is scrupulous that a banded figure *"INCLUDES ZERO. It does not mean none."* Every
 * other cell in the document degrades to "we are not telling you". **The one sentence that flatly
 * means none is the one that could be a lie** — and it is the sentence an operator publishes in a
 * month they believe was quiet.
 *
 * Three things were wrong at once. `decide` validated nothing, so any string recorded. The report
 * counted only `pub:` ids. And nothing reconciled what was decided against what was accounted for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const MAIN = join(import.meta.dirname, "..", "..", "operator", "src", "main.ts");

async function operator(queue: string, ...argv: string[]) {
  try {
    const { stdout, stderr } = await run("node", [MAIN, ...argv, "--queue", queue],
      { encoding: "utf8" });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function withQueue<T>(fn: (queue: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "hydra-mod-"));
  return fn(join(dir, "queue.json")).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const PERIOD = new Date().toISOString().slice(0, 7);

test("THE REPORT NEVER DENIES A DECISION THAT WAS MADE", () => withQueue(async (queue) => {
  // The exact reproduction. Both ids are ones `decide` now refuses, so they are written straight
  // into the queue file — a queue from before that fix, which is the case the report must survive.
  const { writeFileSync } = await import("node:fs");
  const at = Date.now();
  // The real on-disk shape, taken from a queue this tool wrote rather than invented — the first
  // version guessed at it, and `load` failed with "s.open is not iterable" before the report ran.
  // A fixture that cannot be loaded tests nothing, and it failed loudly, which is the good case.
  writeFileSync(queue, JSON.stringify({
    version: 4, open: [], received: [], appeals: [], published: [], compelled: [],
    decided: [
      { id: "a".repeat(32), blobId: "enc:private", outcome: "removed", category: "spam", at },
      { id: "b".repeat(32), blobId: "oops-typo", outcome: "removed", category: "harassment", at },
    ],
  }));

  const r = await operator(queue, "report", PERIOD);
  assert.equal(r.code, 0, r.out);
  assert.ok(!/No decisions were made in this period/.test(r.out),
    `the report denies two decisions that are on file in the same queue it read:\n${r.out}`);
  // AND IT SAYS THEY EXIST rather than merely not denying them.
  assert.match(r.out, /cannot account for/,
    `the report neither denies the decisions nor accounts for them, which is silence rather than `
    + `a correction:\n${r.out}`);
}));

test("AND IT STILL SAYS SO WHEN THERE GENUINELY WERE NONE", () => withQueue(async (queue) => {
  // The other half. A report that never claims "none" would also pass the test above, and the
  // sentence is worth keeping — a period with nothing in it should say so plainly.
  const r = await operator(queue, "report", PERIOD);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /No decisions were made in this period/);
}));

test("A DECISION IS ABOUT A PUBLIC OBJECT, and the other two are refused at the door",
  () => withQueue(async (queue) => {
    // `enc:` because this tool cannot read an encrypted object, so it cannot judge one — that is
    // the whole of the class split, and compelled removal is a different command with its own
    // authority. Anything with no class at all is a typo.
    for (const bad of ["oops-typo", "enc:private", "not-even-a-blob-id", ""]) {
      const r = await operator(queue, "decide", bad, "removed", "spam");
      assert.notEqual(r.code, 0, `\`decide ${JSON.stringify(bad)}\` was recorded`);
      assert.match(r.out, /begins "pub:"/,
        `the refusal does not say what a decision's id must look like:\n${r.out}`);
    }
    const good = await operator(queue, "decide", "pub:abc", "removed", "spam");
    assert.equal(good.code, 0, `a public id was refused:\n${good.out}`);
    assert.match(good.out, /Recorded/);
  }));

test("AND A PUBLIC DECISION IS COUNTED, not merely accounted for", () => withQueue(async (queue) => {
  // The reconciliation must not have turned every decision into the "cannot account for" row.
  await operator(queue, "decide", "pub:abc", "removed", "spam");
  const r = await operator(queue, "report", PERIOD);
  assert.match(r.out, /spam \/ removed/, `an ordinary public decision is not itemised:\n${r.out}`);
  assert.ok(!/cannot account for/.test(r.out),
    `a decision the report CAN account for was put in the fault row:\n${r.out}`);
}));

test("ONE OBJECT CANNOT PUBLISH TWO CONTRADICTORY CELLS", () => withQueue(async (queue) => {
  // **`decide pub:one removed csam` then `decide pub:one kept other`** published BOTH cells and
  // named `pub:one` in the permanent removals index although the final decision was to keep it —
  // while the command printed "Nothing to take down", which reads as the keep having taken effect.
  //
  // Written straight into the queue, because `decide` refuses the second one now. This is the
  // queue of an operator who did it before that fix: the report must not publish the contradiction
  // it inherited.
  const { writeFileSync } = await import("node:fs");
  const at = Date.now();
  writeFileSync(queue, JSON.stringify({
    version: 4, open: [], received: [], appeals: [], published: [], compelled: [],
    decided: [
      { id: "c".repeat(32), blobId: "pub:one", outcome: "removed", category: "csam", at },
      { id: "d".repeat(32), blobId: "pub:one", outcome: "kept", category: "other", at: at + 1000 },
    ],
  }));

  const r = await operator(queue, "report", PERIOD);
  assert.equal(r.code, 0, r.out);
  assert.ok(!/csam \/ removed/.test(r.out),
    `the report publishes a removal that was superseded by a keep:\n${r.out}`);
  assert.match(r.out, /other \/ kept/, "the effective decision is not published");
  // THE INDEX IS PERMANENT, so naming a kept object in it is the half that cannot be walked back.
  assert.ok(!/pub:one/.test(r.out),
    `an object whose final decision was KEPT is named in the permanent removals index:\n${r.out}`);
}));

test("A SECOND DECISION IS REFUSED, and the refusal names the first", () => withQueue(async (queue) => {
  // The operator had nothing to warn them: the first `decide` resolves the review out of the
  // queue, so `show` then answers `No open review` and the prior decision is on no surface at the
  // moment the second is made. `summarise` already prints "No previous decision about this
  // object" for an undecided one — the field existed and became unreachable when it mattered.
  assert.equal((await operator(queue, "decide", "pub:one", "removed", "csam")).code, 0);
  const second = await operator(queue, "decide", "pub:one", "kept", "other");
  assert.notEqual(second.code, 0, "a second decision about the same object was recorded");
  assert.match(second.out, /already been decided/);
  assert.match(second.out, /removed \(csam\)/,
    `the refusal does not say what the earlier decision was, so the operator cannot tell whether `
    + `they are repeating themselves or contradicting themselves:\n${second.out}`);
  assert.match(second.out, /appeal/, "the refusal names no way forward");
}));
