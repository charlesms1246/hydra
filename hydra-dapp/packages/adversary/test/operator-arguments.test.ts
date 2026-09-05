/**
 * What the moderator's tool does with an argument that is wrong.
 *
 * **A TRANSPARENCY REPORT IS AN OUTWARD ARTIFACT**, so a period that silently means a different
 * year is the one defect on this surface that reaches the public. `monthOf` validated the SHAPE —
 * `/^\d{4}-\d{2}$/` — and `Date.UTC` rolled the value:
 *
 *     report 2026-00  ->  2025-12-01   the previous year
 *     report 2026-13  ->  2027-01-01   the next year
 *     report 2026-99  ->  2034-03-01   eight years out
 *     report 0000-01  ->  1900-01-01   `Date.UTC` maps years 0-99 into 1900-1999
 *
 * and then printed "No decisions were made in this period", which is a sentence that gets
 * published. A script looping over months with an off-by-one gets a plausible report for the
 * wrong year.
 *
 * **Driven as real processes**, because half of this finding was about what a moderator SEES: the
 * messages were already good and were being buried in a Node stack trace, since this surface had
 * no top-level error handler at all while the user client has had one since it existed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);
const MAIN = join(import.meta.dirname, "..", "..", "operator", "src", "main.ts");

async function operator(...argv: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run("node", [MAIN, ...argv], { encoding: "utf8" });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** A queue path that does not exist, so nothing here can touch a real one. */
const NOWHERE = ["--queue", join(import.meta.dirname, "no-such-queue.json")];

test("A PERIOD THAT IS NOT A REAL MONTH IS REFUSED, not silently rolled into another year",
  async () => {
    for (const [spec, would] of [
      ["2026-00", "2025-12"], ["2026-13", "2027-01"], ["2026-99", "2034-03"], ["0000-01", "1900-01"],
    ] as const) {
      const r = await operator("report", spec, ...NOWHERE);
      assert.notEqual(r.code, 0, `\`report ${spec}\` succeeded and reported on ${would}`);
      assert.match(r.out, /is not a real month/,
        `\`report ${spec}\` did not say the period was wrong:\n${r.out}`);
      // NAMES WHAT IT WOULD HAVE COVERED, which is the part that tells a moderator they were about
      // to publish a report for another year rather than merely that they mistyped.
      assert.ok(r.out.includes(would),
        `the refusal does not say it would have covered ${would}, so a moderator cannot tell a `
        + `typo from an off-by-one in a loop:\n${r.out}`);
    }
  });

test("AND A REAL ONE IS NOT", async () => {
  // The other half: rejecting every month would also pass the assertions above.
  const r = await operator("report", "2026-09", ...NOWHERE);
  assert.equal(r.code, 0, `a valid period was refused:\n${r.out}`);
  assert.ok(!/is not a real month/.test(r.out));
});

test("AN ARGUMENT ERROR IS A SENTENCE, not a Node stack trace", async () => {
  // The messages on this surface were already good and were being printed under eleven lines of
  // internals with absolute paths. `die()` is what the user client has always had.
  for (const argv of [["report", "2026-13"], ["show"]]) {
    const r = await operator(...argv, ...NOWHERE);
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes("at ModuleJob"),
      `\`operator ${argv[0]}\` printed a stack trace at a moderator:\n${r.out}`);
    assert.ok(!r.out.includes("Node.js v"),
      `\`operator ${argv[0]}\` crashed rather than exited:\n${r.out}`);
    assert.ok(!/^\s*\^/m.test(r.out),
      `\`operator ${argv[0]}\` printed a source excerpt and a caret:\n${r.out}`);
  }
});

test("`show` WITH NO ID NAMES THE MISSING ARGUMENT, not the search it did not run", async () => {
  // It reported `No open review for undefined.` — a description of a lookup nobody asked for.
  const r = await operator("show", ...NOWHERE);
  assert.ok(!r.out.includes("undefined"),
    `the refusal shows a JavaScript value to a moderator:\n${r.out}`);
  assert.match(r.out, /needs the id of a review/);
  assert.match(r.out, /operator queue/, "the refusal names no way to find the id");
});

test("A FLAG WITH NO VALUE IS REFUSED, not treated as a flag nobody passed", async () => {
  // **`--generate-invites` WITH NO NUMBER SILENTLY STARTED A SERVER.** `Number(undefined)` is
  // `NaN`, `NaN > 0` is false, so an operator who asked for invite codes got a running vault with
  // zero invites and no message at all. `cli.ts` fixed this shape for the user client and wrote
  // down why; neither non-user binary inherited it, which is the I8 split's quiet cost.
  const r = await operator("report", "--queue");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /--queue needs a value/);
  assert.ok(!r.out.includes("at ModuleJob"), `and it is a sentence, not a stack:\n${r.out}`);
});

test("THE VAULT SERVER REFUSES IT TOO, and mints codes when given one", async () => {
  // The binary where it mattered most: the failure was silent AND produced a running service.
  const VAULT = join(import.meta.dirname, "..", "..", "vault-server", "src", "main.ts");
  const bare = await (async () => {
    try {
      const { stdout, stderr } = await run("node", [VAULT, "--generate-invites"],
        { encoding: "utf8", timeout: 10_000 });
      return { code: 0, out: `${stdout}${stderr}` };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  })();
  assert.notEqual(bare.code, 0,
    `\`--generate-invites\` with no value started a server instead of minting codes:\n${bare.out}`);
  assert.match(bare.out, /needs a value/);
  assert.ok(!/vault on http/.test(bare.out),
    `asking for invite codes started a service:\n${bare.out}`);

  // And the flag still works, so the refusal has not eaten the feature.
  const { stdout } = await run("node", [VAULT, "--generate-invites", "3"], { encoding: "utf8" });
  assert.equal(stdout.trim().split("\n").length, 3, "three codes were not minted");
  assert.match(stdout.trim().split("\n")[0]!, /^[0-9a-f]{32}$/, "a code is not 128 bits of hex");
});
