import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SITE } from "../../content.ts";
import { PageFrame } from "../../components/PageFrame.tsx";
import { Nav } from "../../components/Nav.tsx";
import { Section } from "../../components/Section.tsx";
import { Footer } from "../../components/Footer.tsx";

/**
 * How to actually run this, which today means from a checkout.
 *
 * **There is no published package and this page does not pretend there is.**
 * `@hydra-platform/cli` is `private: true` at version `0.0.0`; `hydra-devtool` is publishable and
 * unpublished. An install page describing a package nobody can fetch is the most concrete false
 * claim available to a site, and the one a reader tests first — within about ten seconds, at a
 * shell prompt, and the answer is a 404. So the commands here are the ones that work, and the
 * `bin: hydra` name appears as a note about the future rather than as an instruction.
 *
 * If that reads badly, that is information about readiness rather than a copy problem.
 *
 * The readiness warnings are ON this page rather than linked from it. Somebody here is closer to
 * running this than a reader anywhere else on the site, which makes it the right place for them.
 */
export const metadata: Metadata = {
  title: `Install — ${SITE.name}`,
  description: SITE.install.lede,
};

/**
 * The site's own dependency tree, read from `package.json` at build time.
 *
 * Typed out by hand it would describe the tree as it was when somebody last remembered. An
 * install page is a supply-chain surface — it is where somebody gets a command they will paste
 * into a terminal — so what stands behind it is generated from the manifest, like everything
 * else on this site that can be.
 */
function dependencies(): { runtime: string[]; types: string[] } {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const all = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  const names = Object.keys(all).sort();
  return {
    runtime: names.filter((n) => !n.startsWith("@types/")).map((n) => `${n}@${all[n]}`),
    types: names.filter((n) => n.startsWith("@types/")).map((n) => `${n}@${all[n]}`),
  };
}

export default function Install() {
  const deps = dependencies();
  return (
    <>
      <PageFrame word={SITE.name.toUpperCase()} />
      <Nav current="install" />

      <main className="page">
        <header className="doc-head">
          <h1>Run it</h1>
          <p className="tagline">{SITE.install.lede}</p>
        </header>

        <Section n="01" id="steps" title="FROM A CHECKOUT">
          <ol className="steps">
            {SITE.install.steps.map((s) => (
              <li key={s.label}>
                <span className="step-label" aria-hidden>{s.label}</span>
                <h3>{s.title}</h3>
                <pre className="terminal">
                  <code>{s.commands.map((c) => `$ ${c}`).join("\n")}</code>
                </pre>
                <p>{s.note}</p>
              </li>
            ))}
          </ol>
        </Section>

        <Section n="02" id="warnings" title="BEFORE YOU RUN IT">
          <ul className="warnings">
            {SITE.install.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p className="cta">
            <a href="/about/disclosure/">What every party can see &rarr;</a>
          </p>
        </Section>

        <Section n="03" id="supply-chain" title="WHAT STANDS BEHIND THIS PAGE">
          <div className="prose">
            <p>{SITE.install.supplyChain}</p>
          </div>
          <ul className="deps" data-generated="manifest">
            {deps.runtime.map((d) => (
              <li key={d}><code>{d}</code></li>
            ))}
            {deps.types.map((d) => (
              <li key={d} className="dep-types"><code>{d}</code></li>
            ))}
          </ul>
        </Section>
      </main>

      <Footer />
    </>
  );
}
