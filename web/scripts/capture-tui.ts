/**
 * Render the real terminal interface at build time and write the frame out as data.
 *
 * ⛔ **THIS IS THE ACTUAL RENDERER, NOT A DRAWING OF IT.** It imports `render()` from
 * `packages/tui/src/view.ts` — the same pure function `main.ts` calls once per frame — with a
 * fixture model, and captures exactly the string a terminal would receive. The box characters, the
 * pane titles, the column arithmetic, the truncation, the colours: all of it is the product's,
 * because it is the product's code producing them.
 *
 * ## ⛔ WHY THIS IS A SEPARATE SCRIPT AND NOT AN IMPORT IN A COMPONENT
 *
 * `view.ts` reaches `identity/src/domains.ts` and three `vault-client` modules — measured, four
 * forbidden modules across a graph of forty-three. **I6 says no key-handling code may enter a
 * browser context**, and `scripts/module-graph.ts` fails the build if any page can reach one. So a
 * component cannot import this, and the earlier version of this page did not: it hand-drew a box
 * with the right glyphs, which is a picture of the interface rather than the interface.
 *
 * A build-time Node script is the third option and the correct one. It runs on the build machine,
 * imports whatever it needs there, and emits **text**. Nothing it touched is bundled, and the site
 * reads a JSON file. That is the same shape as `CommandSurface`, which captures the CLI's real
 * help output rather than describing it.
 *
 * ## ⛔ EXCLUDED FROM `web/`'s TYPECHECK, AND THIS IS NOT A LOOPHOLE
 *
 * `tsc` follows imports, so checking this file drags what it imports into the web lane's
 * typecheck. That made `npm run typecheck` here go red for **type errors in another lane's tree**,
 * which is a gate failing for a reason nobody in this lane can fix and everybody in this lane
 * learns to ignore.
 *
 * ⛔ **Re-measured after the platform lane's split, and the blocker moved.** `view.ts` now reaches
 * ten files and none of them are forbidden — it used to be forty-three and four. But this script
 * also imports `app.ts` for `start` and `viewOf`, and that still reaches
 * `client/src/public.ts` and `handshake/src/inbox.ts`, both of which have type errors today. So
 * the exclusion stays, and the reason is now **`app.ts`, not `view.ts`** — which is the thing to
 * re-check next time, rather than re-deriving the whole argument.
 *
 * Those files are typechecked by `hydra-dapp`'s own `npm run typecheck`. Excluding them here drops
 * no coverage; it stops duplicating another lane's coverage inside this one and inheriting its
 * red. **What is lost is type checking of THIS file**, which is the real cost and is stated rather
 * than hidden: it is a build script with no runtime consumers, its output is validated by the
 * assertions below, and `npm run build` runs it — so it fails loudly rather than silently.
 *
 * ## The fixture is obviously a fixture
 *
 * Every value in the model below is fake and visibly so. A plausible-looking fingerprint in a
 * marketing asset is a string somebody eventually quotes as real. Before writing, the script
 * asserts the output contains **the fixture seed, a sixteen-character prefix of it, this machine's
 * home directory and its username** — named exactly, because a comment claiming a wider check than
 * the loop performs is worse than no comment. If the fixture grows another key-shaped field, add
 * it to the loop in the same commit.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { spans } from "./ansi.ts";
import {
  FIXTURE_HOME,
  FIXTURE_STATE,
  identityNeedles,
  renderOnlyNeedles,
} from "./tui-fixture.ts";

/*
 * ⛔ SET BEFORE THE IMPORT, WHICH IS WHY THE IMPORTS BELOW ARE DYNAMIC.
 *
 * `cli/src/state.ts` evaluates `STATE_DIR = process.env.HYDRA_HOME ?? join(homedir(), …)` at module
 * load, and the status pane prints that path. Static imports are hoisted, so assigning the variable
 * beside them would run too late and the frame would carry **the build machine's home directory
 * onto a public page** — which is what the first capture did, and what the check below now catches
 * rather than trusting this to be remembered.
 */
process.env.HYDRA_HOME = FIXTURE_HOME;

const { render } = await import("../../hydra-dapp/packages/tui/src/view.ts");
const { start, viewOf } = await import("../../hydra-dapp/packages/tui/src/app.ts");
type View = Parameters<typeof render>[0];

const fixtureState = FIXTURE_STATE as unknown as Parameters<typeof start>[0];

function frames() {
  /* `render()` takes a `View`, not a `Model` — `viewOf` derives the fields it reads, including
     `linked`, which `start()` does not set. A `Model` passed straight in throws on `l.known`. */
  const base = start(fixtureState, 0);
  const chats: View = viewOf({ ...base, page: "chats", channel: 0, typing: false });
  const status: View = viewOf({ ...base, page: "status", typing: false });
  return {
    /* 20 rows: a common terminal height, and the fixture has three lines of thread — at 26
       the pane is mostly empty and reads as a bug rather than as a quiet conversation. */
    chats: render(chats, { cols: 96, rows: 20 }),
    status: render(status, { cols: 96, rows: 16 }),
  };
}

const captured = frames();

const out = {
  chats: captured.chats.map(spans),
  status: captured.status.map(spans),
};

/*
 * ⛔ ONE LOOP, ONE NEEDLE LIST, AND IT COVERS BOTH RENDERS.
 *
 * It reads `out` — the thing written — rather than the intermediate it was derived from. Today the
 * two cannot disagree, because `spans` only splits a string; the day it gains a transform, a check
 * on the intermediate measures something no longer shipped and keeps passing while it does.
 *
 * **And it reads `FIXTURE_STATE`, because a live render never passes through here.** That path
 * runs in the browser with no build step between its fixture and a reader, and it draws from the
 * same object — so this is the only gate either render has, asserted on behalf of both. Two
 * fixtures would leave the static frame guarded and the live one not, which is one generator and
 * two artifacts with a check on one.
 *
 * The needle list is imported rather than written here, so the two paths cannot come to disagree
 * about what counts as a leak — and the docstring above no longer has to describe the loop, since
 * the loop is the list.
 */
const rendered = JSON.stringify(out);
const fixture = JSON.stringify(FIXTURE_STATE);

/* The seed is the fixture's own field. What matters is that it never reaches a rendered frame. */
for (const [what, value] of renderOnlyNeedles()) {
  if (rendered.includes(value)) {
    throw new Error(
      `the rendered terminal frame contains ${what}. The renderer is printing state it should `
      + "not, and this script is the last thing between that and a public page.",
    );
  }
}

/* The machine's identity must be in neither — see `identityNeedles` for why the fixture counts. */
for (const [what, value] of identityNeedles(homedir(), process.env.USER ?? "")) {
  if (rendered.includes(value) || fixture.includes(value)) {
    throw new Error(
      `the terminal frame or its fixture contains this machine's ${what} (${value}). Set `
      + "HYDRA_HOME before the renderer is imported — see the top of this file.",
    );
  }
}

writeFileSync(join(import.meta.dirname, "..", "tui-frames.json"), JSON.stringify(out), "utf8");
console.log(
  `captured ${out.chats.length} + ${out.status.length} lines from the real renderer.`,
);
