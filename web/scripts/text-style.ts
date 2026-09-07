/**
 * What colour and size does this text ACTUALLY come out as — asked of a browser, per element.
 *
 * ## Why this exists, and why it is not a general renderer
 *
 * `ERRORS.md` E-WEB5 has nine instances: defects that were true of the rendered page and false of
 * nothing in the markup, every one shipped through a green suite and found by a person looking at
 * a screenshot. `check:figures` closed the geometry slice of that class. This closes a second
 * slice, and it is deliberately a slice.
 *
 * **The instance that argued for this one was a link that rendered in the browser's default blue.**
 * It is the sharpest of the nine because it was not a regression: the CSS was not broken, it had
 * never been written. The site had never had an inline prose link, so no rule existed, and **no
 * test that reads the document can fail on a rule that was never needed before.** Asking the
 * browser what colour the text is does fail on it, immediately, without knowing anything about
 * which rule was supposed to have supplied it.
 *
 * ## The palette is read, not listed
 *
 * The allowed colours are the custom properties on `:root`, resolved by the browser — so this
 * asserts *every colour on the page came from the sheet's own palette*, and it cannot drift from
 * that palette because it has no second copy of it. Adding a token is allowed by construction;
 * using a colour that is not a token is not.
 *
 * ## ⛔ WHAT THIS DOES NOT COVER — read this before trusting a green run
 *
 * A gate whose scope is stated is worth more than one that implies generality, so:
 *
 * - **Contrast.** A token used against the wrong token passes: `--g-20` text on `--g-12` is two
 *   real palette colours and unreadable. This checks provenance, not legibility.
 * - **Background, border and fill colours.** Text only.
 * - **Spacing, alignment and overlap** — `check:figures` covers overlap inside SVG figures, and
 *   nothing covers overlap in flowed HTML. Three of E-WEB5's nine are in that gap.
 * - **Anything requiring judgement**: whether a size is *appropriate*, whether emphasis lands,
 *   whether the page reads well. There is a floor here, not an opinion.
 * - **Hover, focus and any other state.** The document as loaded, at rest.
 * - **`prefers-reduced-motion`, print, forced-colors.** One media configuration.
 *
 * ## The floor is a floor, not a scale
 *
 * `MIN_PX` is the size below which text is not a design decision at any viewport — it is an
 * accident, usually an inherited size arriving where a class did not. It is **not** the site's
 * smallest intentional size and must not be raised to match one: this fails on text nobody chose,
 * and a gate that also enforced a type scale would be edited every time a size changed, which is
 * how a gate becomes something people route around.
 *
 * Run: `npm run check:text` (after a build — it reads `out/`).
 */

import { normalize, join } from "node:path";
import { existsSync } from "node:fs";

import { routes, findChrome, serve, launch, connect } from "./browser.ts";

/**
 * Two widths, not four.
 *
 * Colour does not vary with width and size rarely does, so this is about catching the rules that
 * only apply inside a media query. A phone and a desktop bracket every breakpoint the sheet has.
 */
const WIDTHS = [390, 1440];

/*
 * There is no floor constant here, and that is the point.
 *
 * ⛔ **THE FLOOR IS THE SITE'S OWN TYPE SCALE, RESOLVED AT EACH WIDTH.** The sheet declares
 * `--t-display` … `--t-label` on `:root`, several of them `clamp()`ed against the viewport, and the
 * smallest of them at a given width is the smallest size anybody chose. Text below it did not come
 * from the scale — it came from a relative unit compounding somewhere up the tree, which is
 * precisely the accident this is looking for.
 *
 * A typed number would have been a second copy of the scale, drifting the first time a token
 * changed, in a file the person changing it has no reason to open.
 */

/*
 * Vacuity floors. A selector that matches nothing reports a clean page, which is the failure this
 * whole family of gates exists to prevent — so the run asserts on what it SAW, per width, never
 * summed across widths, because a sum passes with one width blind.
 */
const MIN_ELEMENTS = 150;

/*
 * The settle ceiling. Three equal readings 150ms apart, within twenty tries — enough for hydration
 * and a first canvas paint on a loaded machine, and short enough that a genuinely unstable page
 * fails rather than hangs.
 */
const SETTLE_TRIES = 20;
const SETTLE_MS = 150;
const MIN_TOKENS = 8;
const MIN_SIZES = 4;

/** The measurement, evaluated in the page. */
const PROBE = `(() => {
  /*
   * ⛔ NOT READY IS NOT A FAILURE, AND IT MUST NOT LOOK LIKE ONE.
   *
   * Runtime.evaluate lands the instant after Page.navigate, when the old document has gone and
   * the new one has not been committed: documentElement is null and appendChild threw. The first
   * repair made that a hard error, which turned an ordinary navigation into a red build one run
   * in three. It is a state to wait through, not to report — so it is a value, and everything
   * that is genuinely an error still throws and is still fatal.
   */
  if (!document.documentElement || document.readyState !== "complete") return { ready: false };

  const root = document.documentElement;

  // The palette and the type scale, resolved BY THE BROWSER from the sheet's own custom
  // properties. Reading the declared text ("#6e6e6e", "clamp(...)") would compare a hex string or
  // an unevaluated function against a computed value; letting the browser resolve a probe element
  // gives both sides in one syntax, and resolves the clamps against the viewport actually in use.
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  root.appendChild(probe);

  const tokens = new Map();
  const sizes = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (!rule.selectorText || !rule.selectorText.split(",").some((s) => s.trim() === ":root")) continue;
      for (const name of rule.style) {
        if (!name.startsWith("--")) continue;
        probe.style.color = "";
        probe.style.color = "var(" + name + ")";
        if (probe.style.color) tokens.set(getComputedStyle(probe).color, name);
        probe.style.fontSize = "";
        probe.style.fontSize = "var(" + name + ")";
        if (probe.style.fontSize) sizes.push(parseFloat(getComputedStyle(probe).fontSize));
      }
    }
  }
  probe.remove();
  const floor = sizes.length ? Math.min(...sizes) : 0;

  const violations = [];
  let seen = 0;

  for (const el of document.querySelectorAll("body *")) {
    /*
     * ⛔ TWO POPULATIONS ARE EXCLUDED, AND NEITHER IS A CONVENIENCE.
     *
     * SVG <text> is sized in USER UNITS and scaled by the viewBox, so its computed font-size is
     * not a rendered size and comparing it to a px floor is meaningless — that domain belongs to
     * check:figures, which measures the same elements in the geometry that actually applies.
     *
     * ASCII art is a PICTURE made of characters. The WebGL field renders every cell as its own
     * <span style="color:rgb(...)">, so a colour check over it reports tens of thousands of
     * non-palette colours per page — all correct, none prose. Excluding it drops no coverage of
     * anything a reader reads, and including it would produce a gate too noisy to keep, which is
     * the failure mode that ends with a check deleted rather than fixed.
     *
     * ⛔ **THE EXCLUSION IS aria-hidden, NOT A CLASS LIST**, and that is deliberate: the site
     * already declares what is decoration, for a reason that has nothing to do with this check.
     * Reusing that declaration means a new drawing is excluded on the day it is written, and text
     * a reader is meant to read cannot be excluded from here without also hiding it from a screen
     * reader — a change nobody makes by accident to quiet a gate.
     */
    if (el.closest('svg, pre, [aria-hidden="true"]')) continue;

    // Only elements that themselves print text: a wrapper inherits a colour it never shows, and
    // reporting it would name the wrong element in the failure message.
    const prints = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!prints) continue;
    if (!el.getClientRects().length) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.opacity === "0") continue;
    seen++;

    const where = el.tagName.toLowerCase()
      + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "");
    const text = el.textContent.trim().slice(0, 40);

    if (!tokens.has(s.color)) {
      violations.push(where + " — colour " + s.color + " is not a token on :root — \\"" + text + "\\"");
    }
    const px = parseFloat(s.fontSize);
    if (floor && px < floor) {
      violations.push(where + " — " + px + "px is under the scale's smallest (" + floor + "px) — \\"" + text + "\\"");
    }
  }
  return { ready: true, violations: [...new Set(violations)], seen, tokens: tokens.size, sizes: sizes.length, floor };
})()`;

const root = normalize(join(import.meta.dirname, "..", "out"));
if (!existsSync(join(root, "index.html"))) {
  console.error("::error::no out/ — run `npm run build` first; this measures the built site.");
  process.exit(1);
}
const ROUTES = routes(root).sort();
if (ROUTES.length < 9) {
  console.error(`::error::only ${ROUTES.length} routes in out/ — the walk is not seeing the site.`);
  process.exit(1);
}

const exe = findChrome();
const site = await serve(root);
const chrome = await launch(exe);
const cdp = await connect(chrome.ws);
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);


type Reading = {
  ready: boolean;
  violations: string[]; seen: number; tokens: number; sizes: number; floor: number;
};

/**
 * Measure the page ONCE IT HAS STOPPED CHANGING, and prove that it has.
 *
 * ⛔ **THE FIRST VERSION SLEPT 120ms AND SAMPLED WHATEVER HAD RENDERED.** `out/` is static, so the
 * corpus should be identical every run — and it was not: 606 elements, then 607, then 606, and one
 * run in four threw `Cannot read properties of null (reading 'appendChild')` because the document
 * had no `documentElement` yet. `/demo/hydra/` hydrates a live terminal and `Solids` paints a
 * canvas; the gate was reading a page mid-hydration.
 *
 * ⛔ **THE CRASH WAS NEVER THE PROBLEM. THE QUIET RUN WAS.** A pass over 606 elements instead of
 * 607 reports clean **about a smaller site**, says nothing about the difference, and the element it
 * missed is disproportionately likely to be from the client-rendered subtree — the newest and
 * least-covered markup here. **A gate whose corpus varies run to run reports clean about a
 * different thing each time.** That is the vacuity failure with a race for a cause instead of a
 * person.
 *
 * So: the same probe is run until it returns the same population size three times running, and
 * **the reading that is used is one of those three** — the stability is established on the
 * measurement itself rather than on a proxy for it, which is the only way the two cannot disagree.
 * If it never settles, that is a failure and not a longer sleep: a page still mutating after the
 * ceiling is a page this gate cannot make a true statement about.
 */
async function settled(route: string, width: number): Promise<Reading> {
  let previous = -1;
  let same = 0;
  let last: Reading | undefined;

  for (let attempt = 0; attempt < SETTLE_TRIES; attempt++) {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate",
      { expression: PROBE, returnByValue: true, awaitPromise: false }, sessionId);

    /*
     * An exception here is a HARD FAILURE and must read as one. The first version checked
     * `result.subtype` and exited with a bare description, which is easy to mistake for a
     * measurement. A probe that threw measured nothing.
     */
    if (exceptionDetails || result.subtype === "error") {
      console.error(`::error::the probe threw on ${route} at ${width}px — nothing was measured:`);
      console.error(`  ${exceptionDetails?.exception?.description ?? result.description}`);
      process.exit(1);
    }

    const reading = result.value as Reading;
    if (!reading.ready) {
      // The document is not there yet. Not a reading, so it cannot count towards stability.
      same = 0;
      previous = -1;
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      continue;
    }
    last = reading;
    same = last.seen === previous ? same + 1 : 0;
    previous = last.seen;
    if (same >= 2 && last.seen > 0) return last;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }

  console.error(`::error::${route} at ${width}px never settled (last read: ${last?.seen ?? "none"}): `
    + `${SETTLE_TRIES} reads over ${(SETTLE_TRIES * SETTLE_MS) / 1000}s and the element count kept `
    + "moving. This is not a reason to wait longer — a page still mutating is a page this check "
    + "cannot make a true statement about, and passing over whichever elements happened to exist "
    + "is how it would report clean about a smaller site.");
  process.exit(1);
}

const failures: string[] = [];
let sawMost = 0;
let sawTokens = 0;
let sawSizes = 0;
const floors = new Set<number>();

for (const width of WIDTHS) {
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  let seenHere = 0;
  for (const route of ROUTES) {
    await cdp.send("Page.navigate", { url: `${site.origin}${route}` }, sessionId);
    const out = await settled(route, width);
    seenHere += out.seen;
    sawTokens = Math.max(sawTokens, out.tokens);
    sawSizes = Math.max(sawSizes, out.sizes);
    floors.add(out.floor);
    for (const v of out.violations) failures.push(`${route} @${width}  ${v}`);
  }
  sawMost = Math.max(sawMost, seenHere);
  if (seenHere < MIN_ELEMENTS) {
    failures.push(`only ${seenHere} text elements at ${width}px — the walk is not seeing the site`);
  }
}

if (sawTokens < MIN_TOKENS) {
  failures.push(`only ${sawTokens} colour tokens resolved — the palette read is not working`);
}
if (sawSizes < MIN_SIZES) {
  failures.push(`only ${sawSizes} size tokens resolved — the type scale read is not working`);
}

await cdp.send("Target.closeTarget", { targetId });
cdp.close();
await chrome.kill();
site.close();

if (failures.length) {
  console.error(`::error::${failures.length} text-style violation(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `text style clean: ${sawMost} text elements, ${sawTokens} palette tokens, `
  + `floor ${[...floors].sort((a, b) => a - b).join("/")}px from the scale, `
  + `${ROUTES.length} routes x ${WIDTHS.length} widths. Rendered in chrome.`,
);
