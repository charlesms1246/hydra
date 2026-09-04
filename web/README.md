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

## Fonts

Four faces, all self-hosted from `public/fonts/`.

| face | role | licence | in the repo? |
|---|---|---|---|
| Geist (variable 100–900) | UI, section titles | OFL-1.1 | yes |
| Geist Mono (variable) | labels, citations, ticks | OFL-1.1 | yes |
| Instrument Serif (400) | all prose | OFL-1.1 | yes |
| NON Natural Grotesk (400) | the wordmark, nothing else | **personal use** | **no** |

**NON Natural Grotesk is not in the repository and must not be committed.** It is licensed to
the author for personal use, which covers building this site and does not cover redistribution —
and committing a font to a repository is redistribution regardless of what the site does with it.
It is in `.gitignore`, and `scripts/preflight.ts` fails the build with the path and this
explanation if it is absent, rather than silently falling back to Geist and shipping a wordmark
nobody chose.

To build: put your licensed copy at `public/fonts/NON-Natural-Grotesk-Regular.woff2`.

> **Open before this ships to anyone:** the personal-use licence needs transferring to whatever
> entity ends up publishing this. Tracked as a deployment blocker.

## Install commands are verified in a clone, not here

`content.ts`'s install steps were once "verified by running them" — on this machine, where
`hydra-dapp/packages/channel/node_modules` already existed. A fresh clone fails immediately on a
missing `@scure/starknet`, so every reader's first command would have errored while the page
said it worked.

**If you change an install command, run it in `git clone`d copy in `/tmp`, not here.** The thing
you test has to be the thing a reader gets. Note also that neither `hydra-dapp/packages/cli` nor
`devtool` declares any dependencies — an `npm install` in either is a no-op, and the real one
belongs in `channel`, a package the reader never stands in.

## Publishing: `npm run build:public`, never `npm run build`

**The gitignore protects this repository and does nothing for the deployed artifact.** `next
build` copies everything in `public/` into `out/`, so **publishing `out/` redistributes the
personal-use wordmark face and the trademarked mark exactly as committing them would.** The guard
everybody had was pointed one step to the left of the exposure.

So there are two builds:

| | `npm run build` | `npm run build:public` |
|---|---|---|
| for | local work, recording, development | anything served from a URL |
| wordmark | NON Natural Grotesk | Geist Light |
| mark | `public/hydra.svg` | `>|<`, the reference's own glyph |
| preflight fails when | the assets are **missing** | the assets are **present** |

That asymmetry is the point: each mode refuses the mistake available to it. The full build's
failure would be a wordmark silently set in a face nobody chose; the public build's would be a
licensing exposure that is invisible, because the page looks correct either way.

`test/site.test.ts` asserts a `HYDRA_PUBLIC=1` build carries neither asset, and that the
substitution actually happened rather than the build having quietly broken.

**To publish:** move the two restricted files out of the tree, run `npm run build:public`, serve
`out/`. It is a plain directory tree — `trailingSlash: true` means any static host serves it,
GitHub Pages included.

## The mark

`public/hydra.svg`, and `app/icon.svg` which is the same file recoloured to the accent. Used in
the nav bar and as the favicon **of the local build only** — `npm run build:public` substitutes
`>|<`, the reference's own glyph, and preflight refuses to make a public build while the file is
present.

**It is Marvel's HYDRA insignia.** A third party's trademark rather than a licence anybody here
holds, so it is gitignored and never served from a public build.

**This is not a deployment blocker, and it used to say it was.** That wording predated
`build:public`: publication is now handled, mechanically, by a guard that fails rather than by
somebody remembering. What is actually unresolved is different and smaller — *this project has no
mark of its own.*

**And that hold has no lift condition, which this file should say rather than imply otherwise.**
The font's blocker can be discharged: transfer the personal-use licence. This one cannot. The mark
cannot be licensed at any price, so the only path is replacement, and **nobody has been asked to
draw one.** Writing it as "tracked alongside the font licence" implied a future in which it
resolves the same way, and there is no such future without somebody deciding to commission a mark.

The user has chosen to keep it for now and that decision is not being re-litigated here. The point
of the paragraph is that **a blocking condition with no satisfiable lift is a deletion wearing
caution's clothes** — durable, because nobody argues with caution — and this file should not
present one as though it were on a track.

## Design

The visual language comes from `~/projects/Gestalt/web_design/`, itself a reskin of the Dragonfly
Capital site. It is a *document* aesthetic — registration marks, numbered sections, hairline
rules, and a monospace metadata column on every row — and that is why it fits: this project's
whole argument is that every claim names the file that makes it true, and `Claim.from` is already
that column.

Which also means the design **borrows the authority of an audited document**, and only earns it
if the citations are real. Two tests cover that: every cited path must resolve to a file, and
every cited path must be tracked by git — a citation into a gitignored directory resolves for
whoever wrote it and for no reader, which is the design lying in the most expensive way available
to it.

Citations are deliberately **not links**. A page that never offers a click it cannot honour beats
one that offers 404s.

Three colours: black, white, one accent (red). Everything else is a hueless lightness ramp.
States are distinguished by weight, fill, glyph or position, never by a fourth colour.

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

`art.txt` is **copied** from `devtool/`, while `statement.ts` is **imported** from `hydra-dapp/`.
That asymmetry is deliberate: the statement's coupling *is* the guarantee, so a build that breaks
when the claims change is the mechanism working. A drawing is decoration, and reaching across a
package boundary for one would only let a change to a picture break this build.

## Why `--webpack`

`statement.ts` and its imports carry explicit `.ts` extensions — what Node 24 wants and what a
bundler does not resolve by default. `next.config.ts` sets `resolve.extensionAlias`, which is a
webpack option; Turbopack has no equivalent, so both `dev` and `build` pass `--webpack`.
