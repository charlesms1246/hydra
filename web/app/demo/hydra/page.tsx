import type { Metadata } from "next";

import { SITE } from "../../../content.ts";
import { PageFrame } from "../../../components/PageFrame.tsx";
import { Nav } from "../../../components/Nav.tsx";
import { Section } from "../../../components/Section.tsx";
import { CommandSurface } from "../../../components/CommandSurface.tsx";
import { Footer } from "../../../components/Footer.tsx";

/**
 * `hydra` — the platform client.
 *
 * The command surface below is captured by running the real binary during `npm run build`, so
 * it cannot describe commands the tool does not have. See `scripts/cli-surface.ts` for why that
 * matters: a recording of output the product no longer prints is exactly as wrong as a stale
 * claim, and it is in a format the forbidden-word check cannot read.
 *
 * What is NOT here is a session transcript. Anything past the command list needs a running
 * devnet, so it has to be captured by hand rather than generated, and a hand-captured transcript
 * is the thing that goes stale silently. It is deliberately absent until it can be pinned to the
 * commit it was recorded from.
 */
export const metadata: Metadata = {
  title: `hydra — ${SITE.name}`,
  description: "A scriptable command line, and a terminal interface over the same code.",
};

export default function Page() {
  return (
    <>
      <PageFrame word={SITE.name.toUpperCase()} />
      <Nav current="demo" />

      <main className="page">
        <header className="doc-head">
          <h1>hydra</h1>
          <p className="tagline">A scriptable command line, and a terminal interface over the same code.</p>
        </header>

        <Section n="01" id="commands" title="EVERY COMMAND">
          <p className="capture-note">
            Captured from the binary when this page was built. It is what the tool prints today,
            not a description of it.
          </p>
          <CommandSurface tool="hydra" />
        </Section>
      </main>

      <Footer />
    </>
  );
}
