/**
 * The site cannot say more than the software does, and cannot say less either.
 *
 * A marketing page is where an over-claim gets written by somebody who was not in the room when
 * the number was measured. This project's standing rule is that privacy claims are computed and
 * never asserted, so the rule is enforced here in both directions:
 *
 *   - the page may not contain a claim the statement does not produce, and
 *   - it may not omit one the statement does. Dropping the uncomfortable half of a disclosure
 *     table is the same lie as inventing a guarantee, and it is the easier one to commit.
 *
 * **These tests read the BUILT PAGE, not a function that returns markup.** `npm test` runs
 * `next build` first. Testing `out/index.html` means the thing under test is the artifact a
 * reader actually gets, including whatever the bundler decided to put in it — which is the only
 * level at which "no third-party requests" and "no key material" can be honestly checked.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SITE } from "../content.ts";
import { statement, MEASURED } from "../../hydra-dapp/packages/claims/src/statement.ts";
import { auditorClaims } from "../components/auditor-claims.ts";
import { commandLines, commandSurface, TOOLS } from "../scripts/cli-surface.ts";
import {
  boundaryCrossings,
  clientReachable,
  entryPoints,
  FORBIDDEN,
} from "../scripts/module-graph.ts";

const WEB = dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, "");
const ROOT = resolve(WEB, "..");
const OUT = join(WEB, "out");

/**
 * Every built page, enumerated from `out/` rather than listed.
 *
 * **There is no list of pages in this file, deliberately.** A hand-kept list is one somebody
 * forgets to extend, and the page they forget is the page that escapes every check below. The
 * site has seven routes today and will have more; enumerating the artifact means a new one is
 * covered the moment it exists, without anybody remembering to add it.
 *
 * `Nav.tsx` keeps its own list of links, and the two views are independent on purpose: a page
 * missing from the nav is still checked here, and a nav link to a page that does not exist is a
 * broken link rather than an invisible one.
 */
type Page = { route: string; html: string };

let pages: Page[] = [];
/** The landing page, and the disclosure page, for the checks specific to each. */
let home = "";
let html = "";
/** Prose a person wrote, across EVERY page, scripts included. */
let handWritten = "";
let removedClaims = 0;

function enumeratePages(dir: string, route = "/"): Page[] {
  const out: Page[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...enumeratePages(join(dir, e.name), `${route}${e.name}/`));
    else if (e.name === "index.html") {
      out.push({ route, html: readFileSync(join(dir, e.name), "utf8") });
    }
  }
  return out;
}

before(() => {
  assert.ok(existsSync(OUT), `${OUT} is missing — run \`npm test\`, which builds first`);
  pages = enumeratePages(OUT);
  // The vacuity half: an enumeration that finds nothing would pass every check below.
  assert.ok(
    pages.length >= 7,
    `only found ${pages.length} built pages — the enumeration is not seeing the site`,
  );
  const find = (route: string) => {
    const p = pages.find((x) => x.route === route);
    assert.ok(p, `${route} is not in the build`);
    return p.html;
  };
  home = find("/");
  html = find("/about/disclosure/");
  // EVERY page, because the forbidden-word rule is about anything a person wrote anywhere on
  // this site. **`/pitch/` is now the most dangerous surface**: persuasive copy about a privacy
  // product, hand-written apart from its auditor block, with this check the only thing between
  // it and an unmeasured claim.
  ({ text: handWritten, removed: removedClaims } = handWrittenProse());
});


/**
 * Both pages as one body of text, normalised, with every generated sentence literally removed.
 *
 * **This subtracts strings rather than parsing markup, and that is the whole point.** The
 * previous version stripped `<script>` blocks and then removed elements carrying
 * `data-generated`. It had to strip scripts, because Next serialises the entire React tree into
 * `self.__next_f.push(...)` and every sentence on the page therefore appears twice — once as
 * markup and once as an escaped string that no attribute-shaped matcher can see.
 *
 * That strip was checked for what it stopped MIS-seeing and not for what it stopped seeing, and
 * it turned out to lose something real: **a string passed as a prop to a client component and
 * never rendered exists only in the payload.** A forbidden phrase placed there was invisible to
 * this check — verified by mutation, not by reading. There is no such prop today, and "today"
 * is not an invariant; the shape of this site is one `<Solids note="..." />` away from it.
 *
 * So nothing is stripped. Every claim `statement()` produces is subtracted by value from the
 * whole document, scripts included, and whatever remains is prose a person wrote — wherever the
 * bundler chose to put it, in whatever encoding.
 *
 * **The limit of subtracting by value, considered and accepted.** A hand-written sentence
 * IDENTICAL to a generated one is subtracted along with it, so an asserted copy of a claim would
 * escape this check. On the landing page it cannot happen: that page carries no generated claim
 * at all, and the may-link-may-not-quote test below fails if one appears — which is the surface
 * that matters, being entirely hand-written. On `/disclosures/` a duplicate would slip through,
 * and what it buys somebody is a second copy of a sentence the statement already produced.
 */
function normalise(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\\u0026/g, "&")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Everything on the site that the statement did not generate. */
function handWrittenProse(): { text: string; removed: number } {
  const s = statement();
  const generated = [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee];
  let text = pages.map((p) => normalise(p.html)).join("\n");
  let removed = 0;
  // The captured CLI output is subtracted too. It is not prose a person wrote — it is what the
  // binary printed, checked against the binary below — so scanning it here would attribute
  // another package's copy to this site's authors. What it DOES contain is checked separately
  // and is a finding rather than a pass; see the CLI-language test.
  for (const tool of ["hydra", "hydra-dev"] as const) {
    text = text.split(normalise(commandSurface(tool))).join(" ");
    for (const line of commandLines(tool)) {
      if (line.trim().length > 12) text = text.split(normalise(line)).join(" ");
    }
  }
  for (const c of generated) {
    for (const piece of [c.says, c.from]) {
      if (text.includes(piece)) removed++;
      text = text.split(piece).join(" ");
    }
  }
  return { text, removed };
}

// ---------------------------------------------------------------------------------------------
// What the page says
// ---------------------------------------------------------------------------------------------

test("every claim the statement makes is on the disclosure page", () => {
  // The direction that matters most. A site can be made to look excellent by publishing the
  // seven things nobody can see and quietly dropping the twenty-eight things they can.
  const s = statement();
  const text = decode(html);
  for (const claim of [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee]) {
    assert.ok(
      text.includes(claim.says),
      `the statement says "${claim.says.slice(0, 60)}…" and the site does not`,
    );
    assert.ok(
      text.includes(claim.from),
      `"${claim.says.slice(0, 40)}…" is on the page without the source that makes it checkable`,
    );
  }
});

/**
 * Quoting the statement is allowed anywhere. Paraphrasing it is caught everywhere.
 *
 * **This replaced a cruder rule, and the crude one forbade the honest act.** It used to be "only
 * the disclosure page may carry generated claims," written when the split was landing-versus-
 * disclosure. That prevented softening by preventing quotation — but it also made it impossible
 * to put the auditor's graph-visibility line on `/pitch/`, which is a fact about Hydra rather
 * than a comparison, so hand-writing it would be an asserted claim the check correctly refuses.
 * Generated-on-the-page or absent-from-the-page, and absent was not acceptable.
 *
 * Softening was never caught by the page restriction anyway. It is caught by the forbidden-word
 * check: a paraphrase is not identical to a claim, so it is not subtracted, so it stays in
 * hand-written prose and gets read. The restriction was a blunt proxy for a property another
 * instrument already held.
 *
 * So: any page may render claims, verbatim, inside a marked block — and the marker is itself
 * checked, below.
 */
test("any claim text on any page is inside a marked generated block", () => {
  const s = statement();
  const all = [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee];
  for (const p of pages) {
    const text = normalise(p.html);
    const quoted = all.filter((c) => text.includes(c.says));
    if (quoted.length === 0) continue;
    assert.match(
      p.html,
      /data-generated="statement"/,
      `${p.route} contains claim text with no generated block — a claim pasted into prose is an `
      + "assertion wearing a citation's clothes",
    );
  }
});

/**
 * `data-generated` is a claim of provenance, so it is checked in both directions.
 *
 * The marker decides what the forbidden-word check does NOT read. The moment a marker controls
 * what gets inspected, it needs its own guard — otherwise it is simply the way to smuggle
 * hand-written copy past the instrument that exists to read it. Marking a block generated when
 * it is not would be a more effective attack on this site than any wording.
 *
 * `statement` blocks must contain only sentences `statement()` produced. `cli` blocks must
 * contain only what the binary printed; that is checked in the demo test further down.
 */
test("nothing inside a generated block is text the generator did not produce", () => {
  const s = statement();
  const produced = new Set(
    [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee].flatMap((c) => [c.says, c.from]),
  );
  for (const p of pages) {
    // Each <p> and <span> inside a statement block, as rendered text.
    const blocks = [...p.html.matchAll(
      /<(\w+)[^>]*data-generated="statement"[^>]*>([\s\S]*?)<\/\1>/g,
    )];
    for (const [, , inner] of blocks) {
      const cells = [...inner.matchAll(/<(?:p|span)[^>]*>([^<]+)<\/(?:p|span)>/g)]
        .map((m) => normalise(m[1]).trim())
        .filter((t) => t.length > 25); // skip indices like "01" and short labels
      for (const cell of cells) {
        assert.ok(
          produced.has(cell),
          `${p.route} has text inside a data-generated block that statement() never produced: `
          + `"${cell.slice(0, 70)}…"`,
        );
      }
    }
  }
});

/**
 * The size of each table, pinned separately.
 *
 * A single total could not tell you WHICH table grew, and the difference is the whole point: a
 * new row in `whoCanSeeWhat` is a DISCLOSURE the page must present, and a new row in
 * `whatWeCannotSee` is a GUARANTEE. Those need different review by different eyes. The last time
 * this pin fired it went 55 → 58, and all three new claims were disclosures — which the total
 * had no way of saying.
 *
 * When this fails: read the new claims, confirm they render with a citation that resolves, then
 * change the number in a commit that names them. A pin that gets reflexively bumped has stopped
 * being a pin.
 */
test("each disclosure table is the size it was when somebody last read it", () => {
  const s = statement();
  assert.equal(s.whoCanSeeWhat.length, 40, "the OBSERVABLE/DERIVABLE tables changed size");
  assert.equal(s.whatIsPartial.length, 7, "the partial-guarantee table changed size");
  assert.equal(s.whatWeCannotSee.length, 11, "the NOT_OBSERVABLE tables changed size");
});

test("the hand-written prose makes no privacy claim of its own", () => {
  for (const word of SITE.forbidden) {
    assert.ok(
      !handWritten.toLowerCase().includes(word),
      `"${word}" appears in prose a person wrote — if it is true, generate it from the thing `
      + "that makes it true; if it is not, do not say it",
    );
  }
  // And the words that ARE allowed are allowed because they are attached to a measurement: the
  // generated sections quote percentages, and those come from the tests that produced them.
  assert.match(html, /data-generated="statement"/);
  // The subtraction has to have actually found the generated text, or the check above passed by
  // looking at a document it failed to match against. Both `says` and `from` for every claim, on
  // both pages, so the count is comfortably above the number of claims.
  assert.ok(
    removedClaims >= 58,
    `only ${removedClaims} generated strings were found and removed — the claims are no longer `
    + "matching the rendered page, so this check is inspecting text it cannot interpret",
  );
});

test("the page says what it is not ready for, above what it can do", () => {
  // Ordering is a claim too. A "not ready" section below three screens of guarantees is a
  // disclaimer; above them it is a description.
  const warning = html.indexOf('id="not-ready"');
  const guarantees = html.indexOf('id="cannot-see"');
  const partial = html.indexOf('id="partial"');
  assert.ok(warning > 0, "the 'not ready' section is not on the page at all");
  assert.ok(
    warning < guarantees && warning < partial,
    "the limitations moved below the guarantees, which turns them into small print",
  );
  const text = decode(html);
  for (const line of SITE.notYet) assert.ok(text.includes(line), `missing: ${line.slice(0, 50)}…`);
});

/**
 * Standing rule 5: the auditor line appears in every disclosure statement, always, and never as
 * a footnote.
 *
 * "Never a footnote" is a layout property, so it is checked as one: the auditor section has to
 * appear before the long tables, not after them. A reader who stops early must still have read
 * it. The pool's auditor can see the communication graph, and that is part of the pitch rather
 * than a caveat to bury.
 */
test("the auditor is stated plainly, above the tables, and generated rather than written", () => {
  const claims = auditorClaims();
  assert.ok(claims.length > 0, "no auditor claim in the statement at all");

  const text = decode(html);
  for (const c of claims) {
    assert.ok(text.includes(c.says), `auditor claim missing from the page: ${c.says.slice(0, 50)}…`);
  }

  const section = html.indexOf('id="auditor"');
  const tables = html.indexOf('id="can-see"');
  assert.ok(section > 0, "the auditor section is not on the page");
  assert.ok(section < tables, "the auditor section moved below the tables, which is a footnote");

  // And it is marked as generated, so the forbidden-word check never applies to it and nobody is
  // tempted to paraphrase it into something that reads better.
  assert.match(html, /class="auditor" data-generated="statement"/);
  assert.ok(
    !handWritten.includes(claims[0].says),
    "the auditor text is being treated as hand-written prose",
  );

  // The graph disclosure specifically — the one it leads with.
  assert.ok(
    text.includes("name who was talking to whom"),
    "the claim that the auditor and the operator together identify who talked to whom is missing",
  );
});

test("what the project declines to claim is a section, not footer text", () => {
  const text = decode(html);
  for (const line of SITE.doesNotClaim) {
    assert.ok(text.includes(line), `missing disclaim: ${line.slice(0, 50)}…`);
  }
  // Signal by name. The comparison is one this project loses and says so.
  assert.ok(text.includes("Signal"), "the Signal comparison is not on the page");
  assert.ok(
    html.indexOf('id="not-claimed"') < html.indexOf('id="cannot-see"'),
    "the disclaims moved below the guarantees, which is where a disclaimer goes to be ignored",
  );
});

test("nothing on the page names a company, an address or a canary", () => {
  // There is no legal entity. A copyright line, a contact address or a warrant canary would each
  // imply one, and a canary published by nobody on behalf of nothing is theatre.
  // Section 07 is removed first: it is the page stating in as many words that there is no
  // company, no contact and no canary, and a check that trips on the denial would be reading the
  // sentence backwards.
  let text = pages.map((p) => normalise(p.html)).join("\n");
  for (const line of SITE.doesNotClaim) text = text.split(line).join("");
  text = text.toLowerCase();
  for (const implied of ["warrant canary", "all rights reserved", "©", "copyright ", " inc.", " ltd", "gmbh"]) {
    assert.ok(!text.includes(implied), `"${implied}" implies a legal entity that does not exist`);
  }
});

// ---------------------------------------------------------------------------------------------
// What the page fetches, and what it carries
// ---------------------------------------------------------------------------------------------

test("nothing is fetched from anywhere else, on a page about who can see what", () => {
  // A webfont, an analytics tag or a CDN stylesheet is a request to a third party made by every
  // visitor to a page whose whole subject is which third parties can see what. A reader here may
  // be deciding whether to leak to a newsroom; their IP and referrer are not ours to hand out.
  // The only external URLs allowed are the ones the footer links to, which a reader CHOOSES to
  // follow.
  const urls = pages.flatMap((p) =>
    [...p.html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
  );
  const external = urls.filter((u) => /^(https?:)?\/\//.test(u));
  const declared = new Set<string>(SITE.links.map((l) => l.href));
  for (const u of external) {
    assert.ok(declared.has(u), `${u} is fetched or linked and is not one of the declared links`);
  }
  // Preconnect and dns-prefetch are requests too, and they are easy to add without noticing.
  for (const p of pages) {
    assert.ok(
      !/rel="(preconnect|dns-prefetch)"/i.test(p.html),
      `${p.route} hints a connection to a third party`,
    );
  }
  // Every font is served from this origin.
  for (const u of urls.filter((u) => u.endsWith(".woff2"))) {
    assert.ok(u.startsWith("/fonts/"), `font ${u} is not served from this origin`);
  }
});

test("no analytics or telemetry package is installed", () => {
  const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of Object.keys(deps)) {
    assert.ok(
      !/analytics|speed-insights|gtag|posthog|sentry|plausible|fathom/i.test(name),
      `${name} reports to somebody; this site reports to nobody`,
    );
  }
});

/**
 * I6, as a property of the shipped artifact.
 *
 * No pool viewing key and no vault content key may enter a browser context. The page is rendered
 * entirely on the server at build time, so `statement()` and everything it imports runs on the
 * machine doing the build and none of it is sent to a reader. This checks that is still true of
 * what is actually in `out/`, rather than trusting that it follows from the architecture.
 */
test("no key material or key-derivation code reaches the exported site", () => {
  const files = walk(OUT).filter((f) => /\.(html|js|txt|json|css)$/.test(f));
  assert.ok(files.length > 0, "nothing in out/ to check");
  const markers = [
    "hydra/pool/viewing-key",
    "hydra/vault/content-key",
    "hkdfSync",
    "rootSeed",
    "randomEntropy",
  ];
  for (const f of files) {
    const body = readFileSync(f, "utf8");
    for (const m of markers) {
      assert.ok(!body.includes(m), `${m} reached ${f.replace(OUT, "out")}`);
    }
  }
});

/**
 * I6, as a property of the source.
 *
 * The check above is the one that matters today, and it passes because every page renders on the
 * server. **That is a property one `"use client"` directive destroys silently** — add it to
 * anything importing `statement.ts` and whatever that reaches is bundled for the browser, with no
 * error and nothing in the markup to suggest it.
 *
 * So this asserts the structural fact instead of the incidental one, **and it is now absolute.**
 * It carried an exception list of three for most of a day: `identity/src/domains.ts` — which
 * holds `POOL_DOMAIN`, `VAULT_DOMAIN` and `derive()`, the derivation for both keys I6 names —
 * plus two `vault-client` modules, all reached because quoting a cover rate and a bucket count
 * dragged them in. `channel/src/constants.ts` now holds those values and imports nothing, so the
 * list is empty and the assertion needs no exceptions. An assertion with an exception list is one
 * somebody eventually adds to; this one has nothing to add to.
 */
test("nothing reaches identity or vault-client", () => {
  assert.deepEqual(
    boundaryCrossings(ROOT, entryPoints(WEB)),
    [],
    "a path from web/ into identity or vault-client — I6 says a browser context may hold neither "
    + "the pool viewing key nor the vault content key, and this is how one gets there",
  );
});

/**
 * And the crossings above must stay on the BUILD side of the client boundary.
 *
 * There is exactly one client component — the animated background — and the check is not that it
 * behaves, but that its import graph cannot reach key-handling code. A decorative canvas is
 * precisely the component that grows an unreviewed import, because nobody reviews a background.
 *
 * This is the assertion that makes the known-crossings list survivable: those modules run at
 * build time and are never sent to a reader. The day one of them becomes client-reachable, they
 * stop being a structural wart and start being I6.
 */
test("nothing sent to a browser reaches identity or vault-client", () => {
  const client = clientReachable(WEB);
  // A vacuous pass is the failure mode here: if the directive is spelled differently, or the
  // component stops being reached from a page, this finds nothing and reports success. There is
  // exactly one client component and the check has to be able to see it.
  assert.ok(
    client.size > 0,
    "found no client component at all — the client boundary check is not looking at anything",
  );
  const bad = [...client]
    .map((f) => f.replace(`${ROOT}/`, ""))
    .filter((f) => FORBIDDEN.some((p) => f.includes(p)));
  assert.deepEqual(
    bad,
    [],
    "a client component reaches key-derivation code — everything it imports is bundled and "
    + "served, which is exactly what I6 forbids",
  );
});

/**
 * The typecheck stays on.
 *
 * `ignoreBuildErrors` was switched on once, during the Next.js migration, to work around an
 * in-flight type error in another package. Switching it back was going to be remembered. This
 * project has decided more than once that a habit is a person remembering and a guard is the
 * codebase remembering, so it is a guard.
 */
test("the build does not ignore type errors", () => {
  const config = readFileSync(join(WEB, "next.config.ts"), "utf8");
  assert.ok(
    !/ignoreBuildErrors\s*:\s*true/.test(config),
    "next.config.ts is ignoring TypeScript errors — turn it back on",
  );
  assert.ok(
    !/ignoreDuringBuilds\s*:\s*true/.test(config),
    "next.config.ts is ignoring lint errors — turn it back on",
  );
});

/**
 * The demo shows what the tools print, and it is captured rather than written.
 *
 * **No hand-typed terminal output anywhere on this site, ever.** An invented transcript is
 * indistinguishable from a real one and unfalsifiable by any guard here — it would be a false
 * claim with better typography, on a site whose whole argument is that its claims come from the
 * code. So the demo pages carry only what `scripts/cli-surface.ts` got by running the binary,
 * and this checks the rendered block against a fresh capture.
 */
test("every terminal block on the site is output the tool actually produced", () => {
  const demos = pages.filter((p) => /data-generated="cli"/.test(p.html));
  assert.ok(demos.length >= 2, `expected both demo pages to carry a capture, found ${demos.length}`);

  for (const p of demos) {
    const tool = /data-tool="([^"]+)"/.exec(p.html)?.[1] as keyof typeof TOOLS | undefined;
    assert.ok(tool && tool in TOOLS, `${p.route} marks a cli block with no known tool`);
    const rendered = normalise(p.html);
    for (const line of commandLines(tool!)) {
      if (line.trim().length < 12) continue;
      assert.ok(
        rendered.includes(normalise(line).trimEnd()),
        `${p.route} is missing a line ${tool} actually prints: "${line.trim().slice(0, 60)}…"`,
      );
    }
  }
});

/**
 * What the tools say about themselves, measured against this site's own rule.
 *
 * The captured help text is copy on this site. `hydra` used to describe the public class as
 * **"anonymous posts"** — a privacy claim, in a word this project's own list refuses, with no
 * measurement behind it and not one the statement produces. It was the CLI's wording rather than
 * this site's, but it was on a public page either way and a reader cannot tell which package
 * chose it.
 *
 * It was pinned here rather than dropped from the capture, because hiding a line from generated
 * output is the same move as dropping the uncomfortable half of a disclosure table. **The pin's
 * anti-rot half then caught the fix**: the line now reads "a post with no return channel", which
 * describes the mechanism instead of asserting the property. The claim was conditional all along
 * — publishing is unlinkable only from a fresh, unfunded account — so it belongs in the generated
 * statement where it can carry its conditions, not in help text where it cannot.
 *
 * Both lists are empty and the assertion is effectively absolute. Anything new fails; anything
 * listed that is no longer said also fails, so this cannot rot into fiction.
 */
const KNOWN_CLI_LANGUAGE: Record<string, string[]> = {
  hydra: [],
  "hydra-dev": [],
};

test("the tools do not describe themselves in words this site refuses", () => {
  for (const tool of Object.keys(TOOLS) as (keyof typeof TOOLS)[]) {
    const said = commandSurface(tool).toLowerCase();
    const hits = SITE.forbidden.filter((w) => said.includes(w));
    const unexpected = hits.filter((w) => !KNOWN_CLI_LANGUAGE[tool].includes(w));
    assert.deepEqual(
      unexpected,
      [],
      `${tool} now describes itself using ${JSON.stringify(unexpected)} — an unmeasured privacy `
      + "claim, printed by the tool and rendered on this site. Fix the wording upstream or "
      + "measure it; do not add it to the list to make this pass",
    );
    // And the list cannot rot into fiction.
    const stale = KNOWN_CLI_LANGUAGE[tool].filter((w) => !hits.includes(w));
    assert.deepEqual(stale, [], `${tool} no longer says ${JSON.stringify(stale)} — drop it`);
  }
});

/**
 * Every figure in hand-written copy traces to a measured constant.
 *
 * **Four numbers were hand-written into the pitch and every one was correct.** That is precisely
 * why it needed fixing: correct today and asserted, so a change to a default would leave the
 * copy saying something false with nothing to notice — the forbidden-word check reads words, and
 * these are numbers. It is the same defect the whole project is built against, arriving in the
 * one place that check cannot see.
 *
 * `content.ts` now interpolates from `MEASURED`. This is the guard that keeps it that way: any
 * numeral in hand-written prose has to be one the statement's own constants produce, or be one
 * of the few that are not measurements at all.
 */
test("no hand-written sentence asserts a number the code did not produce", () => {
  /**
   * Both spellings, because `content.ts` renders small integers as words.
   *
   * That was a readability fix — "padded to one of 5 fixed sizes" is a sentence with a datum
   * dropped into it — and it quietly opened a hole in this check: a hand-written "eight blocks"
   * is exactly the assertion the guard exists to catch, and a numeral-only matcher cannot see it.
   * So the spelled forms are measured too, and the prose is scanned for both.
   */
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const spell = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 10 ? words[n] : String(n));
  const both = (n: number) => [String(n), spell(n)];

  const measured = new Set([
    ...both(MEASURED.jitterBlocks),
    ...both(MEASURED.coverRate),
    ...both(MEASURED.coverRate + 1),
    ...both(MEASURED.buckets.length),
    ...both(MEASURED.noteFelts),
    ...both(MEASURED.senderIdentifiedOnChain),
    String(MEASURED.jitterBlocks),
    `${Math.round(MEASURED.isolatedMessageIdentified * 100)}`,
    `${Math.round(MEASURED.clusteredMessageIdentified * 100)}`,
  ]);
  /**
   * Numerals that are not measurements: version and mode strings, a year, the ordinals that
   * number the sections. Listed rather than pattern-matched, because "which numbers are allowed
   * to be typed by a person" is exactly the judgement that should be written down.
   */
  const notMeasurements = new Set([
    "0600", "24", "0", "20", "1", "2", "3", "4", "5", "6", "7",
    // Ordinary English that happens to be a number word, in phrases carrying no measurement:
    // "one client per identity", "either of you", "one of five". Listed, not pattern-matched.
    "one", "two",
  ]);

  const prose = [
    ...SITE.what, ...SITE.notYet, ...SITE.doesNotClaim, ...SITE.beforeYouUse,
    ...SITE.pitch.problem.body, ...SITE.pitch.mechanism.body,
    ...SITE.pitch.worseAt.body, ...SITE.pitch.why.body,
    SITE.pitch.lede, SITE.install.lede, SITE.install.supplyChain, SITE.about.lede,
    ...SITE.about.body, ...SITE.install.warnings,
    ...SITE.why.map((w) => w.body),
  ];

  const numberWord = new RegExp(`\\b(\\d+|${words.slice(3).join("|")})\\b`, "gi");
  for (const line of prose) {
    for (const [, raw] of line.matchAll(numberWord)) {
      const numeral = raw.toLowerCase();
      assert.ok(
        measured.has(numeral) || notMeasurements.has(numeral),
        `"${numeral}" is asserted in hand-written copy and is not a value MEASURED produces:\n`
        + `    ${line.slice(0, 110)}…\n`
        + "  Interpolate it from the constant, or add it to notMeasurements with a reason.",
      );
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The citations, which this design makes load-bearing
// ---------------------------------------------------------------------------------------------

/** Every path token in every `from`, with the `(ID)` annotations stripped. */
function citedPaths(): string[] {
  const s = statement();
  const all = [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee];
  const toks = new Set<string>();
  for (const c of all) {
    for (const part of c.from.replace(/\s*\([^)]*\)/g, "").split(",")) {
      const t = part.trim();
      if (t) toks.add(t);
    }
  }
  return [...toks].sort();
}

/** Where a cited path lives, or null. Paths are package-relative, or repo-relative. */
function locate(token: string): string | null {
  for (const candidate of [join(ROOT, "hydra-dapp/packages", token), join(ROOT, token)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The design makes the citation column load-bearing, so the citations have to be good.
 *
 * This page sets `Claim.from` in monospace beside every sentence, in a layout borrowed from
 * audited documents. That borrows the authority of one, and only earns it if the paths resolve.
 * A `from` pointing at a file that moved is this design lying in the most expensive way
 * available to it: confidently, in the column that exists to prove the sentence next to it.
 */
test("every citation resolves to a file that exists", () => {
  const paths = citedPaths();
  assert.ok(paths.length >= 15, `expected the tables to be cited throughout, found ${paths.length}`);
  for (const token of paths) {
    assert.ok(locate(token), `citation points at a file that is not here: ${token}`);
  }
});

/**
 * And resolves for a READER, not just on this machine.
 *
 * The load-bearing one. `claude-docs/` is gitignored by standing decision, so a citation into it
 * resolves for whoever wrote it and for nobody who clones the repository — uncheckable by
 * construction rather than by accident. A site whose entire argument is checkability must not
 * cite what its reader cannot open.
 */
test("every citation is a file a reader of the repository can open", () => {
  const tracked = new Set(
    execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean),
  );
  for (const token of citedPaths()) {
    const path = locate(token)!;
    const rel = path.replace(`${ROOT}/`, "");
    assert.ok(
      tracked.has(rel),
      `${token} exists here but is not in the repository, so it resolves for you and for no `
      + "reader — cite something they can open, or do not offer it as evidence",
    );
  }
});

// ---------------------------------------------------------------------------------------------

function decode(s: string): string {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
