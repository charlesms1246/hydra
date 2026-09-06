/**
 * Does the page LOOK right — checked by measuring it, not by reading it.
 *
 * ## Why this exists
 *
 * Every other guard in this lane reads the document: `test/site.test.ts` checks strings,
 * provenance markers and citation targets, and `scripts/module-graph.ts` checks imports. Four
 * defects have now shipped that were true of the **rendered geometry** and false of nothing in the
 * markup — a nav whose links had no `display: flex` and ran together, footer classes with no rules
 * at all, an ASCII mark cropped by a floor its own container declared, and three figure labels
 * printed on top of what they label. **The suite was green through every one of them**, correctly,
 * because in each case the markup said exactly what it was supposed to say.
 *
 * So this measures. It walks every `<svg viewBox>` on every route at four widths and asserts two
 * things about each `<text>`: that it stays inside its own viewBox, and that it does not intersect
 * another label or a shape it is not inside. Those two conditions are the whole class — a label
 * that leaves its box gets cut by the screen edge on a phone, and a label that intersects another
 * damages both.
 *
 * ## ⛔ THIS CHECK MUST NOT SKIP WHEN NO BROWSER IS PRESENT
 *
 * A geometry check that passes quietly on a machine with no Chrome is worse than no check, because
 * it converts *nobody is testing this* into a green tick — and the entire finding above is that
 * nobody suspected this class four times running, through green suites. **If a browser cannot be
 * found, this exits non-zero and says which paths it looked in.** Set `CHROME_PATH` to fix it.
 *
 * For the same reason it asserts on what it SAW: if it finds fewer than `MIN_FIGURES` figures or
 * `MIN_TEXTS` labels, it fails. A selector that silently matches nothing would otherwise report
 * success for the version of this file that has been broken by a refactor.
 *
 * ## No dependencies, deliberately
 *
 * It drives Chrome over the DevTools protocol using the `WebSocket` global that Node has had since
 * 22, and serves `out/` from `node:http`. The alternative was `playwright-core` as a devDependency
 * of `web/`, which is a real cost on a site whose whole argument is that it ships nothing it did
 * not have to — and a decision for the user rather than for a guard.
 *
 * Run: `npm run check:figures` (after a build — it reads `out/`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";

// The browser driver, extracted so the second rendering gate uses this one rather than a copy.
import { routes, findChrome, serve, launch, connect } from "./browser.ts";

/** Widths that matter: a phone, a small tablet, a laptop, a desktop. */
const WIDTHS = [390, 768, 1024, 1440];


/*
 * Vacuity floors, set below what the site has today (4 figures, 25 labels) so that removing one
 * drawing does not fail the build while a selector that matches nothing does. **These are counted
 * per width and maxed, never summed** — a sum over four widths passes with three of them blind.
 *
 * They are floors rather than equalities on purpose: this asserts the walk found the drawings, not
 * that the inventory is a particular number, which is a fact about the site rather than about the
 * check and would make this file something to edit every time a figure is added.
 */
const MIN_FIGURES = 3;
const MIN_TEXTS = 20;

/**


/** The measurement, evaluated in the page. Returns violations and what it saw. */
const PROBE = `(() => {
  const figures = [...document.querySelectorAll("svg[viewBox]")];
  const violations = [];
  let texts = 0;

  const box = (el) => { const b = el.getBBox(); return { l: b.x, r: b.x + b.width, t: b.y, b: b.y + b.height }; };
  const contains = (outer, inner) =>
    outer.l <= inner.l && outer.r >= inner.r && outer.t <= inner.t && outer.b >= inner.b;

  for (const svg of figures) {
    const [vx, vy, vw, vh] = svg.getAttribute("viewBox").split(/\\s+/).map(Number);
    const labels = [...svg.querySelectorAll("text")];
    const shapes = [...svg.querySelectorAll("rect,circle,ellipse,line,polygon")];

    for (const t of labels) {
      texts++;
      const a = box(t);
      const name = t.textContent.trim().slice(0, 30);

      /*
       * EXCLUSION 1 — the trailing letter-space.
       *
       * \`.fig-tick\` sets \`letter-spacing\`, and CSS puts that space AFTER every character
       * including the last, so a text's bbox is one letter-space wider than its ink. An
       * end-anchored label sitting flush against the box edge therefore reports a fractional
       * overshoot that cannot be seen. The tolerance is exactly that space, read from the element
       * rather than guessed, so it stays correct if the tracking changes.
       */
      // ⛔ ABSOLUTE. Letter-spacing can be NEGATIVE — tightened display type — and a negative
      // tolerance narrows the box instead of widening it, so a label sitting exactly on the left
      // edge is reported as escaping. Caught on the disclosure map's counts, tracked at -0.02em.
      const slack = Math.abs(parseFloat(getComputedStyle(t).letterSpacing) || 0);

      if (a.r > vx + vw + slack || a.l < vx - slack || a.b > vy + vh + slack || a.t < vy - slack) {
        violations.push(
          \`label leaves its viewBox: "\${name}" occupies \${a.l.toFixed(0)}-\${a.r.toFixed(0)} x \` +
          \`\${a.t.toFixed(0)}-\${a.b.toFixed(0)} in viewBox \${vx} \${vy} \${vw} \${vh}\`,
        );
      }

      for (const other of [...labels, ...shapes]) {
        if (other === t) continue;
        const c = box(other);

        /*
         * EXCLUSION 2 — a label inside the shape that frames it.
         *
         * \`MESSAGE\` is centred inside its own stroked rect, which is the drawing working. The
         * rule is containment rather than a list of strings: a label wholly inside an unfilled
         * shape is framed by it. (A label inside a FILLED shape can still be invisible against
         * it — that is a contrast defect and this check does not claim to find it.)
         */
        if (contains(c, a) && (other.getAttribute("fill") ?? "none") === "none") continue;

        /*
         * EXCLUSION 3 — connector paths are excluded entirely, and this is the check's weakest
         * edge, stated rather than hidden. A \`<path>\`'s bbox is its extent, not its ink: the
         * elbow joining the message to its two legs spans most of the drawing while being three
         * hairlines. Intersecting a bbox says nothing. A label genuinely printed over a connector
         * would not be caught here.
         */
        if (other.tagName.toLowerCase() === "path") continue;

        const ox = Math.min(a.r, c.r) - Math.max(a.l, c.l);
        const oy = Math.min(a.b, c.b) - Math.max(a.t, c.t);
        if (ox > 1 && oy > 1) {
          const what = other.textContent ? \`label "\${other.textContent.trim().slice(0, 24)}"\` : \`<\${other.tagName}>\`;
          violations.push(\`label overprints: "\${name}" x \${what} — \${ox.toFixed(0)}x\${oy.toFixed(0)} units\`);
        }
      }
    }
  }
  return { violations: [...new Set(violations)], figures: figures.length, texts };
})()`;


/* ------------------------------------------------------------------------------------------- */

const root = normalize(join(import.meta.dirname, "..", "out"));
if (!existsSync(join(root, "index.html"))) {
  console.error(`::error::${root}/index.html is missing — build before measuring.`);
  process.exit(1);
}

/* After `root`, because it reads the built directory rather than a list. */
const ROUTES = routes(root).sort();
if (ROUTES.length < 9) {
  console.error(`::error::only ${ROUTES.length} routes found in out/ — the walk is not seeing the site.`);
  process.exit(1);
}

const exe = findChrome();
const site = await serve(root);
const chrome = await launch(exe);
const cdp = await connect(chrome.ws);

const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

let failures = 0;
let sawFigures = 0;
let sawTexts = 0;

for (const width of WIDTHS) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width, height: 900, deviceScaleFactor: 1, mobile: false,
  }, sessionId);

  // Counted per width and then maxed, not summed across the whole walk: the floors below are
  // about the SITE having its drawings, and a sum over four widths would pass with three of them
  // measuring nothing.
  let widthFigures = 0;
  let widthTexts = 0;

  for (const route of ROUTES) {
    await cdp.send("Page.navigate", { url: site.origin + route }, sessionId);
    // The figures are static markup; one paint is enough. The ASCII background is irrelevant here
    // and is the slow thing on the page, so this does not wait for it.
    await new Promise((r) => setTimeout(r, 350));
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: PROBE, returnByValue: true, awaitPromise: false,
    }, sessionId);

    const out = result.value as { violations: string[]; figures: number; texts: number };
    widthFigures += out.figures;
    widthTexts += out.texts;
    if (out.violations.length) {
      failures += out.violations.length;
      console.error(`\n${width}px ${route}`);
      for (const v of out.violations) console.error(`  ::error::${v}`);
    }
  }

  sawFigures = Math.max(sawFigures, widthFigures);
  sawTexts = Math.max(sawTexts, widthTexts);
}


/*
 * ⛔ The vacuity assertions. A run that measured nothing must not read as a run that found nothing
 * wrong — that is the failure this whole file exists to answer, one level up.
 */
if (sawFigures < MIN_FIGURES || sawTexts < MIN_TEXTS) {
  console.error(
    `::error::measured ${sawFigures} figures and ${sawTexts} labels, expected at least ` +
    `${MIN_FIGURES} and ${MIN_TEXTS}. Either the selectors stopped matching or the drawings are ` +
    `gone; either way this run proves nothing.`,
  );
  process.exit(1);
}

/* ---------------------------------------------------------------------------------------------
 * The deck: does every slide's argument fit its slide?
 *
 * ⛔ **A slide is the one layout where content that does not fit is content nobody reads**, and it
 * fails looking deliberate. When this was written the deck overflowed on **22 of 84** viewport
 * sizes, and on slide 06 the two things below the fold were the closing sentence the copy spec
 * moved there for being the strongest on the site, and the only link out of the deck.
 *
 * It is checked over a grid of widths AND heights because the first pass measured five sizes and
 * reported zero. The bug was there the whole time: a slide is height-constrained, so a viewport
 * sweep that varies only width cannot see the defect at all. That is the same understatement as
 * measuring one page width and concluding the columns were aligned.
 *
 * Below the size at which the deck unwinds into a vertical page there is nothing to check, and
 * this asserts it really did unwind rather than skipping quietly.
 * ------------------------------------------------------------------------------------------ */

const DECK_WIDTHS = [360, 390, 414, 600, 768, 834, 1024, 1280, 1440, 1920];
const DECK_HEIGHTS = [560, 640, 700, 768, 800, 900, 1024];

let deckChecked = 0;

for (const width of DECK_WIDTHS) {
  for (const height of DECK_HEIGHTS) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    await cdp.send("Page.navigate", { url: `${site.origin}/pitch/` }, sessionId);

    /*
     * ⛔ Wait for the slides to EXIST, not for a duration.
     *
     * A fixed 260ms produced two phantom failures — "found 0 slides" at one viewport out of
     * seventy, on a page whose markup demonstrably has six. That is worse than a slow gate: a
     * check that fails at random teaches people to re-run it, and a check people re-run is a
     * check they eventually stop believing. Poll for the condition instead.
     */
    for (let tries = 0; tries < 40; tries++) {
      const { result: ready } = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelectorAll("[data-slide]").length`,
        returnByValue: true,
      }, sessionId);
      if ((ready.value as number) >= 6) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Layout settles after the elements exist; the measurement is of boxes, not of presence.
    await new Promise((r) => setTimeout(r, 120));

    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const slides = [...document.querySelectorAll("[data-slide]")];
        const deck = document.querySelector("[data-deck]");
        // Unwound into a vertical page: the slides are a page's sections and may be any height.
        const unwound = deck && getComputedStyle(deck).display === "block";
        return {
          slides: slides.length,
          unwound,
          over: unwound ? [] : slides
            .map((s) => ({ label: s.getAttribute("aria-label"), by: s.scrollHeight - s.clientHeight }))
            .filter((o) => o.by > 2),
        };
      })()`,
      returnByValue: true,
    }, sessionId);

    const out = result.value as {
      slides: number; unwound: boolean; over: { label: string; by: number }[];
    };

    // Vacuity: a run that found no slides proves nothing about whether they fit.
    if (out.slides < 6) {
      console.error(
        `::error::${width}x${height}: found ${out.slides} slides, expected at least 6 — the ` +
        "selector stopped matching or the deck is gone; either way this check is not looking at " +
        "the deck.",
      );
      failures++;
      continue;
    }

    deckChecked++;
    for (const o of out.over) {
      failures++;
      console.error(
        `::error::${width}x${height}: slide "${o.label}" overflows its own box by ${o.by}px. A ` +
        "reader reaches the tail only by scrolling vertically inside a slide that just taught " +
        "them movement is horizontal.",
      );
    }
  }
}

/* ---------------------------------------------------------------------------------------------
 * I7 point 4: the attribution basis must not clip at any width.
 *
 * ⛔ **The anchored basis carries a 66-character Starknet address**, and that is the string shape
 * that pushed the TUI's equivalent qualification past column 110, where it appeared at no width at
 * all. An attribution claim that loses its qualification reads as a **stronger** check than the
 * code performed, which is worse than showing nothing.
 *
 * The messages are live data from a local API, so no built page contains one. This injects a
 * synthetic basis of the worst realistic shape into the real markup and measures it — the CSS
 * under test is the CSS that ships, and the address is an unbroken 66-character token, which is
 * the case a naive `overflow: hidden` or `white-space: nowrap` fails.
 * ------------------------------------------------------------------------------------------ */

const WORST_BASIS =
  "signed \u2014 their key is published at " +
  "0x06ea776549f898490b11aca1d49af58498d6a5246f3847ad4fa163f97ffcb0c6";

let basisChecked = 0;

for (const width of [360, 390, 768, 1024, 1440]) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width, height: 900, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await cdp.send("Page.navigate", { url: `${site.origin}/session/` }, sessionId);
  await new Promise((r) => setTimeout(r, 260));

  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      // **ANCHORED ON A \`data-\` ATTRIBUTE, NOT A CLASS, AND THAT IS THE POINT.** This used to
      // read \`.session\`. The page was restructured into a dashboard, the class went with the
      // old layout, and this gate then found no host and certified NOTHING on any route — the
      // failure was loud, but it measured nothing for as long as it took somebody to notice.
      // \`components/Session.tsx\` sets this attribute and says why; a class earns its way into a
      // refactor's crosshairs and an attribute named for its only job does not.
      const host = document.querySelector("[data-basis-host]");
      if (!host) return { ok: false, why: "no [data-basis-host] on the page — see components/Session.tsx" };
      const probe = document.createElement("ol");
      probe.className = "session-messages";
      probe.innerHTML =
        '<li class="msg"><p class="msg-text">x</p>' +
        '<p class="msg-basis"><span class="msg-mark">M</span>' +
        '<span class="msg-basis-text">' + ${JSON.stringify(WORST_BASIS)} + '</span></p></li>';
      host.appendChild(probe);
      const span = probe.querySelector(".msg-basis-text");
      const line = probe.querySelector(".msg-basis");
      const cs = getComputedStyle(span);
      const r = span.getBoundingClientRect();
      const lr = line.getBoundingClientRect();
      const out = {
        ok: true,
        rendered: span.textContent.length,
        // Wider than its own line box means it is spilling rather than wrapping.
        pastLine: Math.round(r.right - lr.right),
        pastViewport: Math.round(r.right - window.innerWidth),
        clipping: cs.textOverflow === "ellipsis" || cs.whiteSpace === "nowrap" ||
                  cs.overflow === "hidden",
        lines: Math.round(r.height / parseFloat(cs.lineHeight || "16")),
      };
      probe.remove();
      return out;
    })()`,
    returnByValue: true,
  }, sessionId);

  const b = result.value as {
    ok: boolean; why?: string; rendered: number; pastLine: number;
    pastViewport: number; clipping: boolean; lines: number;
  };

  if (!b.ok) {
    console.error(`::error::${width}px: cannot check the attribution basis — ${b.why}`);
    failures++;
    continue;
  }
  // Vacuity: the probe must have rendered the whole string, or it is measuring nothing.
  if (b.rendered !== WORST_BASIS.length) {
    console.error(
      `::error::${width}px: the basis probe rendered ${b.rendered} of ${WORST_BASIS.length} ` +
      "characters — the measurement is not of the string it claims to be.",
    );
    failures++;
    continue;
  }
  basisChecked++;
  if (b.clipping || b.pastLine > 1 || b.pastViewport > 1) {
    failures++;
    console.error(
      `::error::${width}px: the attribution basis is clipped or overflowing ` +
      `(past its line by ${b.pastLine}px, past the viewport by ${b.pastViewport}px, ` +
      `clipping styles: ${b.clipping}). The qualification is what separates a signature under a ` +
      "published key from one under a key nobody can look up; losing it reads as the stronger " +
      "claim.",
    );
  }
}

cdp.close();
await chrome.kill();
site.close();

if (basisChecked < 5) {
  console.error(`::error::the attribution basis was measured at only ${basisChecked} widths.`);
  failures++;
}

if (deckChecked < DECK_WIDTHS.length * DECK_HEIGHTS.length * 0.5) {
  console.error(
    `::error::only ${deckChecked} viewport(s) actually measured a laid-out deck. Too many ` +
    "unwound or found no slides for this check to mean anything.",
  );
  failures++;
}

if (failures) {
  console.error(`\n${failures} geometry violation(s) across ${WIDTHS.length} widths.`);
  process.exit(1);
}

console.log(
  `figure geometry clean: ${sawFigures} figures, ${sawTexts} labels, ` +
  `${ROUTES.length} routes x ${WIDTHS.length} widths; deck clean across ${deckChecked} of ` +
  `${DECK_WIDTHS.length * DECK_HEIGHTS.length} viewport sizes. Rendered in ${exe.split("/").pop()}.`,
);
