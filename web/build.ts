#!/usr/bin/env node
/**
 * The marketing site, built from the statement the product itself renders.
 *
 * `node web/build.ts` writes `web/dist/`. It has no dependencies and it emits **no JavaScript**:
 * the output is HTML and one stylesheet, and `test/site.test.ts` fails if a `<script>` ever
 * appears in it. That is I6 as a property of the artifact rather than of a `package.json` —
 * `claude-docs/docs/FRONTEND-SCAFFOLD.md` asked for a dependency check on `@hydra/identity`, and
 * a page that ships no code at all cannot hold a key by any route, including the ones nobody
 * thought to add a check for.
 *
 * THE SITE'S PRIVACY CLAIMS ARE NOT WRITTEN HERE. They come from
 * `hydra-dapp/packages/claims/src/statement.ts`, which is generated from the disclosure tables
 * and the measured schedules. A marketing page is the most likely place in any project for a
 * claim to appear that the software does not deliver, and the cheapest way to make that
 * impossible is to give the page no way to say anything the product does not.
 *
 * The scope came from the instruction: the platform's interface is the TUI, and this is
 * marketing only — no feed reader, no sandbox, no key material of any kind. That is why it is a
 * generator and not Next.js. `FRONTEND-SCAFFOLD.md` chose a framework for three surfaces, two of
 * which no longer exist.
 */

import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statement } from "../hydra-dapp/packages/claims/src/statement.ts";
import type { Claim } from "../hydra-dapp/packages/claims/src/statement.ts";
import { SITE } from "./content.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST = join(HERE, "dist");

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A generated block, marked as one in the markup.
 *
 * `data-generated` is not decoration: `test/site.test.ts` uses it to tell the two kinds of text
 * apart, so that the forbidden-words check can be strict about the prose a person wrote and
 * silent about the sentences the statement produced. A measured claim is allowed to be
 * uncomfortable; an unmeasured one is not allowed at all.
 */
const claims = (heading: string, note: string, list: readonly Claim[]): string => `
      <section data-generated="statement">
        <h2>${escape(heading)}</h2>
        <p class="note">${escape(note)}</p>
        <ul>
${list.map((c) => `          <li>${escape(c.says)}<span class="from">${escape(c.from)}</span></li>`).join("\n")}
        </ul>
      </section>`;

export function page(): string {
  const s = statement();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(SITE.name)} — ${escape(SITE.tagline)}</title>
    <meta name="description" content="${escape(SITE.tagline)}">
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <main>
      <header>
        <h1>${escape(SITE.name)}</h1>
        <p class="tagline">${escape(SITE.tagline)}</p>
      </header>

      <section>
${SITE.what.map((p) => `        <p>${escape(p)}</p>`).join("\n")}
      </section>

      <section class="warning">
        <h2>What it is not ready for</h2>
        <ul>
${SITE.notYet.map((p) => `          <li>${escape(p)}</li>`).join("\n")}
        </ul>
      </section>
${claims("What the people running this can see", "Generated from the disclosure tables. Every line cites the file that makes it true.", s.whoCanSeeWhat)}
${claims("What is protected, and how well", "Partial guarantees, with the measured number rather than a reassurance.", s.whatIsPartial)}
${claims("What they cannot see", "Each of these is asserted by a test that fails if the mechanism behind it is removed.", s.whatWeCannotSee)}

      <footer>
        <p>
${SITE.links.map((l) => `          <a href="${escape(l.href)}">${escape(l.label)}</a>`).join("\n")}
        </p>
        <p class="note">
          Every claim above is generated from the code that makes it true, by the same function
          the client renders on its own Disclosure page. Nothing here is a promise about what
          anyone will do with what they can see.
        </p>
      </footer>
    </main>
  </body>
</html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, "index.html"), page());
  copyFileSync(join(HERE, "style.css"), join(DIST, "style.css"));
  console.log(`wrote ${DIST}`);
}
