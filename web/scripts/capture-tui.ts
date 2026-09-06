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
  homePathNeedles,
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
    /* The same `View` the chats frame was rendered from — not a second derivation of it. */
    view: chats,
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
/*
 * ⛔ `tui-view.json` IS SERVED, SO IT IS ON THE RENDER SIDE OF BOTH LISTS.
 *
 * The live render cannot build its own `View`: only `viewOf` turns a `State` into one, and that
 * lives in `app.ts`, which reaches `identity` — the exact import the platform lane's split exists
 * to keep out of a browser. So the `View` is derived here, through the same `viewOf` that produces
 * the captured frames, and shipped as data.
 *
 * **That keeps one fixture rather than two.** A hand-written `View` literal would have been the
 * second fixture this file exists to avoid, and it would have been the one nothing asserts over.
 *
 * It is checked against **both** needle lists, unlike `FIXTURE_STATE`. The fixture is only read at
 * build time, so it may hold its own fake seed; this file goes to a reader, so the seed must not
 * be in it for the same reason it must not be in a frame. The risk is not today — it is a field
 * added to `Client` later that carries something, with nothing looking at this artifact.
 */
const view = JSON.stringify(captured.view);

const rendered = JSON.stringify(out) + view;
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

/*
 * ⛔ Any home path, from any machine, in anything served.
 *
 * `identityNeedles` below catches this operator's. This catches the shape — see
 * `homePathNeedles`. `statePath` is safe only because `HYDRA_HOME` is set at the top of this file,
 * which is a convention rather than a guarantee, and a payload generated on another machine and
 * committed would pass every by-value check here.
 *
 * `FIXTURE_HOME` is `/home/you/…` and would trip this, so it is excluded by exact match — the one
 * placeholder that is deliberately shaped like the thing being caught.
 */
const servedWithoutPlaceholder = rendered.split(FIXTURE_HOME).join("«fixture-home»");
for (const [what, value] of homePathNeedles()) {
  if (servedWithoutPlaceholder.includes(value)) {
    throw new Error(
      `something served to readers contains ${what} (${value}). Only \`${FIXTURE_HOME}\` is `
      + "allowed — set HYDRA_HOME before the renderer is imported, and check whether a new field "
      + "is interpolating a path.",
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

/*
 * ⛔ THE SHIPPED VIEW'S SHAPE IS PINNED, BECAUSE A NEEDLE LIST CANNOT SEE A FIELD IT DOES NOT KNOW.
 *
 * The checks above look for four specific strings. The risk hydra-31 named is different and worse:
 * a field added to `Client` or `View` upstream that carries something, with nothing looking at this
 * artifact. A needle list is a search for known secrets; it is silent on an unknown one.
 *
 * So the key set is asserted. A new field fails the build and somebody has to decide whether it
 * belongs in a file served to readers — which is the decision, and it should be made by a person
 * rather than by whether it happened to match a string.
 *
 * **This is not a snapshot test.** It pins names, never values: the fixture's values are meant to
 * change when the fixture does, and a test that failed on those would be one people update without
 * reading. Adding a field here is a two-line change and the comment is the reason it is worth it.
 */
const VIEW_KEYS = [
  "page", "client", "statePath", "typing", "field", "fields", "channel", "scroll",
  "transcript", "foreign", "linked", "log", "busy", "confirm", "cite", "signing", "now",
  /*
   * `help` — admitted deliberately, and this is the decision the assertion above asked for.
   *
   * It is `readonly help: boolean` in `model.ts`: whether the help overlay is up. `viewOf` copies
   * it from the reducer, `start` initialises it to `false`, and a keystroke toggles it. It carries
   * no path, no address, and no count derived from anything — in this fixture it always serialises
   * as `false`, and the live render needs it because `render()` branches on it.
   *
   * Worth recording HOW it got here: it arrived from a lane that never touched `web/`, and this
   * list is what noticed. That is the case this assertion exists for — the person adding a field
   * to the TUI has no reason to think about what the website serves.
   */
  "help",
  /*
   * `helpScroll` — the same decision, and it is a separate entry because it was a separate miss.
   *
   * `readonly helpScroll: number` in `model.ts`: how far the help overlay is scrolled. It exists
   * because help does not fit on a short terminal and is drawn over a page that may be scrolled
   * itself, so reusing `scroll` would have moved the page underneath. It is reset to 0 when help
   * opens, it is 0 in this fixture, and `helpBody` slices by it — so the live render needs it for
   * the same reason it needs `scroll`.
   *
   * **BOTH FIELDS ARRIVED IN ONE CHANGE AND ONLY ONE WAS ADMITTED.** The note above was written
   * against the field the error message named rather than against the change that caused it, so
   * the build failed twice for one edit. That is not a criticism of the reasoning — it is the
   * reason this assertion reports what it found rather than trusting anyone to enumerate: the
   * second field was invisible until the first was answered.
   *
   * Neither carries a path, an address, a name or anything derived from key material. What is in
   * this list that DOES carry a value is `statePath`, and the comment above it already says it is
   * safe by convention rather than by construction. That remains the field in this object worth
   * looking at, and it is not one of these two.
   */
  "helpScroll",
];
/*
 * ⛔ ELEVEN, NOT THE EIGHT IN THE FILE, AND THE GAP IS THE POINT.
 *
 * `Object.keys` on the derived object returns eleven; the written JSON contains eight, because
 * `JSON.stringify` drops `undefined`. `lockedAtRest`, `controlUrl` and `poolAccount` are unset in
 * this fixture and therefore invisible in the artifact — **and would ship the moment a fixture or
 * a real client set them.**
 *
 * So this list is checked against the object rather than the bytes. A check against the bytes
 * would go green on a field that is merely unset today, which is the same silence as not checking
 * at all, arriving one release later.
 */
const CLIENT_KEYS = [
  "identity", "channels", "pending", "vaultUrl", "rpcUrl", "contract", "fromBlock", "invites",
  "lockedAtRest", "controlUrl", "poolAccount",
];

for (const [what, got, want] of [
  ["View", Object.keys(captured.view as object), VIEW_KEYS],
  ["Client", Object.keys((captured.view as { client?: object }).client ?? {}), CLIENT_KEYS],
] as const) {
  const added = got.filter((k) => !want.includes(k));
  if (added.length) {
    throw new Error(
      `${what} gained ${JSON.stringify(added)}, and this object is SERVED to readers. Decide `
      + "whether the new field belongs in a public artifact, then add it to the list in "
      + "scripts/capture-tui.ts. A field nobody listed is a field nobody looked at.",
    );
  }
  // Vacuity: an empty object would pass an "added" check by having nothing to add.
  if (got.length < want.length - 4) {
    throw new Error(
      `${what} has ${got.length} keys and ${want.length} were expected — the view is not being `
      + "derived, so nothing above measured anything.",
    );
  }
}

writeFileSync(join(import.meta.dirname, "..", "tui-frames.json"), JSON.stringify(out), "utf8");
writeFileSync(join(import.meta.dirname, "..", "tui-view.json"), view, "utf8");
console.log(
  `captured ${out.chats.length} + ${out.status.length} lines from the real renderer, `
  + `and a ${view.length}-byte view for the live one.`,
);
