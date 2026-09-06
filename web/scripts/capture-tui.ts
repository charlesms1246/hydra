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
 * `tsc` follows imports, so checking this file drags every module `view.ts` reaches into the web
 * lane's typecheck — forty-three files belonging to `hydra-dapp`. That made `npm run typecheck`
 * here go red for **type errors in another lane's tree**, which is a gate failing for a reason
 * nobody in this lane can fix and everybody in this lane learns to ignore.
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

/*
 * ⛔ SET BEFORE THE IMPORT, WHICH IS WHY THE IMPORTS BELOW ARE DYNAMIC.
 *
 * `cli/src/state.ts` evaluates `STATE_DIR = process.env.HYDRA_HOME ?? join(homedir(), …)` at module
 * load, and the status pane prints that path. Static imports are hoisted, so assigning the variable
 * beside them would run too late and the frame would carry **the build machine's home directory
 * onto a public page** — which is what the first capture did, and what the check below now catches
 * rather than trusting this to be remembered.
 */
process.env.HYDRA_HOME = "/home/you/.hydra-msg";

const { render } = await import("../../hydra-dapp/packages/tui/src/view.ts");
const { start } = await import("../../hydra-dapp/packages/tui/src/app.ts");
type Model = Parameters<typeof render>[0];

/**
 * Nothing here is real, and nothing here resembles a real value closely enough to be quoted.
 *
 * ⛔ The seed is DISTINCT from every other fixture value on purpose. It was `"0".repeat(64)` and
 * the contract was all zeros too, so the leak check below matched the contract and refused to
 * write — a true firing of a correct guard against a fixture I had made collide with itself. A
 * canary that can be triggered by something other than the thing it watches for teaches people to
 * widen it.
 */
const SEED = "5e5e".repeat(16);

const fixtureState = {
  vaultUrl: "http://127.0.0.1:8080",
  rpcUrl: "http://127.0.0.1:5050",
  contract: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  fromBlock: 1,
  accountsFile: "/tmp/accounts.json",
  account: "demo",
  network: "devnet",
  blockMs: 1000,
  seedHex: SEED,
  prekeys: { epoch: 0, privates: {} },
  invites: [],
  /* Every field the State type declares. `pending` is the upload queue; an empty one is the
     state a screenshot should show, because a queue mid-flush is a moment rather than the tool. */
  pending: [],
  channels: {
    ana: {
      peer: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      role: "initiator",
      readTo: 0,
      messages: [],
    },
    bo: { peer: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", role: "responder", readTo: 0, messages: [] },
  },
} as unknown as Parameters<typeof start>[0];

function frames() {
  const base: Model = start(fixtureState, 0);
  const chats: Model = { ...base, page: "chats", channel: 0, typing: false };
  const status: Model = { ...base, page: "status", typing: false };
  return {
    /* 20 rows: a common terminal height, and the fixture has three lines of thread — at 26
       the pane is mostly empty and reads as a bug rather than as a quiet conversation. */
    chats: render(chats, { cols: 96, rows: 20 }),
    status: render(status, { cols: 96, rows: 16 }),
  };
}

/**
 * ANSI to spans.
 *
 * The renderer emits SGR codes — `screen.ts` `CODES`, only the ones the product actually uses.
 * They are translated to tone names here rather than to colours, so the site's palette decides
 * what "warn" looks like and the terminal's does not leak in.
 */
const TONE: Record<string, string> = {
  "1": "bold", "2": "dim", "7": "inverse",
  "31": "red", "32": "green", "33": "yellow", "34": "blue",
  "35": "magenta", "36": "cyan", "90": "gray",
};

type Span = { t: string; c: string[] };

function spans(line: string): Span[] {
  const out: Span[] = [];
  let tones: string[] = [];
  let i = 0;
  while (i < line.length) {
    const esc = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
    if (esc) {
      const codes = esc[1].split(";").filter(Boolean);
      tones = codes.length === 0 || codes.includes("0")
        ? []
        : codes.map((c) => TONE[c]).filter(Boolean);
      i += esc[0].length;
      continue;
    }
    const next = line.indexOf("\x1b", i);
    const end = next === -1 ? line.length : next;
    const text = line.slice(i, end);
    if (text) out.push({ t: text, c: tones });
    i = end;
  }
  return out;
}

const captured = frames();

const out = {
  chats: captured.chats.map(spans),
  status: captured.status.map(spans),
};

/*
 * ⛔ THE CHECKS BELOW READ `out` — THE THING WRITTEN — NOT `captured`.
 *
 * They used to read the intermediate. Today the two cannot disagree, because `spans` only splits
 * a string; the day it gains a transform, a check on the intermediate is measuring something that
 * is no longer shipped, and it keeps passing while doing it. **Assert on the artifact.**
 */
const flat = JSON.stringify(out);

/*
 * ⛔ The output must not carry the fixture's secrets. This is cheap and it is the assertion that
 * makes the whole approach safe: a renderer that started printing state would otherwise put it on
 * a marketing page, and nothing downstream reads terminal output looking for a seed.
 */
for (const secret of [SEED, SEED.slice(0, 16)]) {
  if (flat.includes(secret)) {
    throw new Error(
      "the rendered terminal frame contains fixture key material. The renderer is printing state "
      + "it should not, and this script is the last thing between that and a public page.",
    );
  }
}

/*
 * ⛔ And nothing about the machine that built it.
 *
 * The status pane prints the state file's path. The first capture put `/home/<the author>/…` into
 * a public asset — not key material, but a real person's username on a marketing page, published
 * by a project whose subject is what leaks without anyone deciding to leak it.
 */
for (const [what, value] of [["home directory", homedir()], ["username", process.env.USER ?? ""]]) {
  if (value && value.length > 2 && flat.includes(value)) {
    throw new Error(
      `the rendered terminal frame contains this machine's ${what} (${value}). Set HYDRA_HOME `
      + "before the renderer is imported — see the top of this file.",
    );
  }
}

writeFileSync(join(import.meta.dirname, "..", "tui-frames.json"), JSON.stringify(out), "utf8");
console.log(
  `captured ${out.chats.length} + ${out.status.length} lines from the real renderer.`,
);
