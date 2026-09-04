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
import { statement } from "../../hydra-dapp/packages/claims/src/statement.ts";
import { auditorClaims } from "../components/auditor-claims.ts";
import {
  boundaryCrossings,
  clientReachable,
  entryPoints,
  FORBIDDEN,
} from "../scripts/module-graph.ts";

const WEB = dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, "");
const ROOT = resolve(WEB, "..");
const OUT = join(WEB, "out");

/** The landing page: marketing, and no generated claims at all. */
let home = "";
/** The disclosure page: the generated statement, and the two hand-written warning lists. */
let html = "";
/** Prose a person wrote, across BOTH pages, scripts included. */
let handWritten = "";
let removedClaims = 0;

before(() => {
  const pages = { home: join(OUT, "index.html"), doc: join(OUT, "disclosures/index.html") };
  for (const [name, path] of Object.entries(pages)) {
    assert.ok(
      existsSync(path),
      `${name} is missing at ${path} — run \`npm test\`, which builds first`,
    );
  }
  home = readFileSync(pages.home, "utf8");
  html = readFileSync(pages.doc, "utf8");
  // Both pages, because the forbidden-word rule is about anything a person wrote anywhere on
  // this site. **The landing page is the more dangerous of the two**, now that the tables have
  // moved: it is entirely hand-written, it has no generated block to hide behind, and every
  // sentence on it was chosen to attract somebody.
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
  let text = `${normalise(home)}\n${normalise(html)}`;
  let removed = 0;
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
 * The landing page is marketing and carries no generated claim.
 *
 * Not a style rule — it is the reason the split is safe. Moving the tables to their own page is
 * only honest if the landing page does not then paraphrase them into something friendlier, which
 * is the exact move this whole mechanism exists to prevent. So the landing page may LINK to the
 * statement and may not quote it: no claim text, and no citation either, because a citation with
 * no claim beside it is decoration borrowing the look of evidence.
 */
test("the landing page quotes no claim and no citation", () => {
  const s = statement();
  const text = normalise(home);
  for (const claim of [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee]) {
    assert.ok(
      !text.includes(claim.says),
      `the landing page quotes a generated claim: "${claim.says.slice(0, 50)}…" — link to the `
      + "disclosure page instead",
    );
  }
  assert.ok(
    !/data-generated/.test(home),
    "a generated block reached the landing page; the tables live at /disclosures/",
  );
  // And it must actually offer the way there, or the split is just a deletion.
  assert.ok(home.includes('href="/disclosures/"'), "the landing page does not link to the disclosures");
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
  let text = `${normalise(home)}\n${normalise(html)}`;
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
  const urls = [...`${html}${home}`.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const external = urls.filter((u) => /^(https?:)?\/\//.test(u));
  const declared = new Set<string>(SITE.links.map((l) => l.href));
  for (const u of external) {
    assert.ok(declared.has(u), `${u} is fetched or linked and is not one of the declared links`);
  }
  // Preconnect and dns-prefetch are requests too, and they are easy to add without noticing.
  assert.ok(
    !/rel="(preconnect|dns-prefetch)"/i.test(html + home),
    "a connection to a third party is hinted",
  );
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
 * The check above is the one that matters today, and it passes because every component here is a
 * server component. **That is a property one `"use client"` directive destroys silently** — add
 * it to anything that imports `statement.ts` and the key-derivation module graph below is bundled
 * for the browser, with no error and nothing in the markup to suggest it.
 *
 * So this asserts the structural fact instead of the incidental one. It currently FAILS OPEN on
 * three known crossings, all of them upstream of this package and none of them reachable from a
 * browser today. The list is a tripwire, not permission: anything NEW fails.
 *
 * TWO OF THE THREE ARE ALREADY GONE. `c1962af` extracted `channel/src/constants.ts`, so quoting
 * a cover rate no longer drags in `identity/src/domains.ts` — which holds `POOL_DOMAIN`,
 * `VAULT_DOMAIN` and `derive()`, the derivation for both keys I6 names — and `coverLeadMs` moved
 * to a module importing only `node:crypto`.
 *
 * WHAT IS LEFT is one import: `statement.ts` takes `BUCKETS` from `vault-client/src/buckets.ts`
 * to say how many size bands there are. That file imports NOTHING — it is five integers and
 * three pure functions, no key material on any path — so what remains is a package-boundary
 * violation rather than a key-exposure one. When those constants move too, delete this list and
 * make the assertion absolute.
 */
const KNOWN_CROSSINGS = ["hydra-dapp/packages/vault-client/src/buckets.ts"];

test("nothing new reaches identity or vault-client", () => {
  const crossings = boundaryCrossings(ROOT, entryPoints(WEB)).map((c) => c.file);
  const added = crossings.filter((c) => !KNOWN_CROSSINGS.includes(c));
  assert.deepEqual(
    added,
    [],
    "a new path from web/ into identity or vault-client — I6 says a browser context may hold "
    + "neither the pool viewing key nor the vault content key, and this is how one gets there",
  );
  // And if a crossing is FIXED upstream, this fails too, so the list cannot rot into fiction.
  const stale = KNOWN_CROSSINGS.filter((k) => !crossings.includes(k));
  assert.deepEqual(stale, [], "a known crossing is gone — delete it from KNOWN_CROSSINGS");
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
