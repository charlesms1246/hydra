# `web/` — the marketing site

Two static pages, exported to `out/`. `npm run build` writes them; `npm test` builds first and
then checks the artifact.

```
/               landing. What this is, why it is different, what to know before using it.
/disclosures/   the generated statement: what every party can see, with the file that proves it.
```

## The one rule

**Privacy claims are generated, never asserted.** Every claim on `/disclosures/` comes from
`hydra-dapp/packages/claims/src/statement.ts` — the same function the client renders on its own
Disclosure screen — and none of it is written here. `content.ts` holds what a generator cannot
know: what the thing is for, who it is not for yet, what it declines to claim, where the code is.

`test/site.test.ts` enforces this in both directions. The page may not contain a claim the
statement does not produce, and it may not omit one the statement does — dropping the
uncomfortable half of a disclosure table is the same lie as inventing a guarantee, and it is the
easier one to commit.

The landing page carries **no** generated claim and no citation. That is what makes the split
between the two pages honest rather than a quiet demotion: it may link to the statement, and it
may not paraphrase it into something friendlier.

## Constraints that are checked, not remembered

| | |
|---|---|
| **No third-party requests** | No `next/font/google`, no analytics, no CDN, no preconnect, no embeds. Every font is served from this origin. A reader here may be deciding whether to leak to a newsroom; their IP and referrer are not ours to hand out. |
| **No path to `identity` or `vault-client`** | I6: no pool viewing key and no vault content key in a browser context. `scripts/module-graph.ts` walks the import graph; the build fails on a new crossing and the suite fails if a **client** component ever reaches one. |
| **The page works without script** | The animated background is the only client component. Without it — filtered network, no WebGL, reduced-motion — the static ASCII drawing behind it stays and every word of both pages is still there. |
| **No legal entity implied** | No company name, address, contact, copyright line or warrant canary. There is no legal entity; a canary published by nobody on behalf of nothing would be theatre. |
| **The typecheck stays on** | A test asserts `ignoreBuildErrors` is not set. It was switched on once during the Next.js migration and switching it back was going to be remembered; now it is a guard instead. |

Telemetry is off for this project — `npx next telemetry disable`, already run. Do not re-enable it.

## What is not checked

**There is no automated rendering check.** Every test here reads the built HTML, so a CSS
regression that made a page unreadable would pass all twenty of them with every string present
and correctly placed in the markup. Layout was verified by looking at it, on one machine, at one
window size.

That is an absence rather than a stub, and it is recorded rather than fixed on purpose: closing
it means a headless browser in the dependency tree of a site whose argument includes how little
it depends on. If it ever gets closed, close it with something that does not ship.

Everything else runs against reality — the real `statement()`, the real binaries spawned at build
time, the real `out/` directory, real `git ls-files`. No fixture, no golden file, no stub.

## Layout

```
app/page.tsx              landing
app/disclosures/page.tsx  the statement
app/globals.css           the entire design system, no framework
components/               PageFrame, Nav, Section, ClaimList, Auditor, Footer, Solids
content.ts                every hand-written word on the site
scripts/module-graph.ts   the import-graph walker behind the I6 checks
scripts/preflight.ts      build-time gates, with messages that say what to do
art.txt                   the TUI's hydra, copied — see the note in app/page.tsx
```