import type { Metadata } from "next";

import { SITE } from "../../../content.ts";
import { Nav } from "../../../components/Nav.tsx";
import { Section } from "../../../components/Section.tsx";
import { CommandSurface } from "../../../components/CommandSurface.tsx";
import { Terminal } from "../../../components/Terminal.tsx";
import { LiveTerminal } from "../../../components/LiveTerminal.tsx";
import { liveView } from "../../../components/live-view.ts";
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
      <Nav current="demo" />

      <main className="page">
        {/* Two columns, and the terminal is the wide one because it is the thing being shown.
            The figure stays put while the prose scrolls, so the only thing that follows the
            reader down the page is the footer.

            THE SPLIT IS PART OF THE DEMONSTRATION, not decoration. `LiveTerminal` measures the
            box it is given and re-renders at the columns that fit, so putting it in a 60% column
            is not a smaller picture of the full-width frame — it is the interface drawing itself
            differently, which is the claim the whole live render exists to make. */}
        <div className="demo-split">
          <div className="demo-split-prose">
            <header className="doc-head">
              <h1>hydra</h1>
              <p className="tagline">A scriptable command line, and a terminal interface over the same code.</p>
            </header>

            <Section n="01" id="commands" title="EVERY COMMAND">
              <CommandSurface tool="hydra" />
            </Section>
          </div>

          <aside className="demo-split-figure" aria-label="What it looks like">
            {/* The captured frame is the child, so it is what the markup carries and what a
                reader without JavaScript keeps. `LiveTerminal` replaces it only once it has
                measured the reader's width — see that file for why re-rendering beats scaling. */}
            <LiveTerminal view={liveView()}>
              <Terminal frame="chats" />
            </LiveTerminal>
          </aside>
        </div>
      </main>

      <Footer />
    </>
  );
}
