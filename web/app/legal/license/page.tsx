import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SITE } from "../../../content.ts";
import { Nav } from "../../../components/Nav.tsx";
import { Reveal } from "../../../components/Reveal.tsx";
import { Section } from "../../../components/Section.tsx";
import { Footer } from "../../../components/Footer.tsx";
import { Close } from "../../../components/Close.tsx";

/**
 * What governs the code, and what the code is built out of.
 *
 * ⛔ **A licence page is the genre where this site's own rule breaks most easily.** Everywhere
 * else the rule is that a claim is generated from the thing that makes it true; a legal page is
 * where somebody types the name of a licence from memory and it is wrong for two years because
 * nobody reads it. So neither fact on this page is typed: the licence name is read from `LICENSE`
 * and the dependency list from `package.json`, both at build time.
 *
 * The manifest moved here from the install page's section 03. It was correct there — an install
 * page is a supply-chain surface — but it answers a licensing question, which is: whose work is
 * in this, and under what terms. The install page keeps the commands.
 */
export const metadata: Metadata = {
  title: `License — ${SITE.name}`,
  description: "The licence this code is under, read from the licence file, and the packages this site is built from, read from the manifest.",
};

/**
 * The licence's own title, read from `LICENSE`.
 *
 * Two lines rather than the file: the name and the version are the fact, and the rest is the
 * licence itself, which is in the repository and is the authority. **The `copyright` guard is not
 * defensive noise** — line four of the GPL is the FSF's own notice, and pulling it onto a page
 * would trip `test/site.test.ts`'s check that nothing here implies a legal person. It is a real
 * hazard one `slice` away rather than an imagined one.
 */
function licenceTitle(): string[] {
  const path = join(process.cwd(), "..", "LICENSE");
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (lines.length < 2 || lines.some((l) => /copyright/i.test(l))) {
    throw new Error(
      `${path} does not start with a licence title — this page prints its first two lines and `
      + "must not print a holder's notice. Read the file and fix the slice.",
    );
  }
  return lines;
}

function dependencies(): { runtime: string[]; types: string[] } {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const all = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  const names = Object.keys(all).sort();
  return {
    runtime: names.filter((n) => !n.startsWith("@types/")).map((n) => `${n}@${all[n]}`),
    types: names.filter((n) => n.startsWith("@types/")).map((n) => `${n}@${all[n]}`),
  };
}

export default function License() {
  const [name, version] = licenceTitle();
  const deps = dependencies();
  return (
    <>
      <Nav current="legal" />

      <main className="page">
        <header className="doc-head">
          <Reveal>
            <h1>License</h1>
            <p className="tagline">
              Read from the licence file in the repository, not typed here.
            </p>
          </Reveal>
        </header>

        <Section n="01" id="licence" title="WHAT THE CODE IS UNDER">
          <Reveal>
            <p className="statement-lead col-7" data-generated="license">
              {name}, {version.replace(/^Version /, "version ")}.
            </p>
            <p className="col-7">
              The text is <code>LICENSE</code> at the root of the repository. It is the authority;
              this page only names it, and names it by reading it, so the two cannot come apart.
            </p>
          </Reveal>
        </Section>

        <Section n="02" id="supply-chain" title="WHAT STANDS BEHIND THIS SITE">
          <Reveal>
            <p className="statement-lead col-7">{SITE.install.supplyChain}</p>
          </Reveal>
          <Reveal>
            <ul className="deps" data-generated="manifest">
              {deps.runtime.map((d) => (
                <li key={d}><code>{d}</code></li>
              ))}
              {deps.types.map((d) => (
                <li key={d} className="dep-types"><code>{d}</code></li>
              ))}
            </ul>
          </Reveal>
          <Reveal>
            <p className="col-7">
              Each carries its own terms, which travel with the package rather than with this
              page. The list is read from <code>web/package.json</code> when the site is built, so
              adding a package changes this page and forgetting to is not possible.
            </p>
          </Reveal>
        </Section>
      </main>

      <Close
        line="The licence is the file. This page is only a way of finding it."
        primary={{ href: "/install/", label: "Run it" }}
        secondary={{ href: "/legal/terms/", label: "Terms of use" }}
      />

      <Footer />
    </>
  );
}
