import type { Metadata } from "next";

import { SITE } from "../../../content.ts";
import { Nav } from "../../../components/Nav.tsx";
import { Section } from "../../../components/Section.tsx";
import { CommandSurface } from "../../../components/CommandSurface.tsx";
import { Footer } from "../../../components/Footer.tsx";

/**
 * `hydra-dev` — the devtool.
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
  title: `hydra-dev — ${SITE.name}`,
  description: "A local STRK20 privacy stack, and tooling that computes what a transaction discloses.",
};

export default function Page() {
  return (
    <>
      <Nav current="demo" />

      <main className="page">
        <header className="doc-head">
          <h1>hydra-dev</h1>
          <p className="tagline">A local STRK20 privacy stack, and tooling that computes what a transaction discloses.</p>
        </header>

        {/* THERE IS NO TERMINAL BLOCK HERE, AND ITS ABSENCE IS THE HONEST STATE.
            This rendered `<Terminal frame="status" />` — a frame captured from `hydra-dapp`'s
            TUI, whose nav reads `HYDRA  Chats (1)  Connect (2) …`. That is the PLATFORM client's
            interface standing in for the devtool's, on a site whose argument is that its terminal
            blocks are output the tool actually produced.

            The devtool has a real TUI at `devtool/packages/tui` (Ink), and it CAN be captured:
            it renders headlessly to a coloured, SGR-only frame with no devnet, using the harness
            in that package's `test/render.mjs`. What stops a capture today is that every page
            carries a status bar with live local state — an indexer lag that increments every
            second, and a real pool address off the operator's machine. A capture would be neither
            reproducible nor safe to publish, and the fix is a fixture seam in that package's
            `app.mjs`, which is not this lane's file.

            So the block is gone rather than wrong. A missing figure is a gap; the other product's
            figure is a false claim. */}
        <Section n="01" id="commands" title="EVERY COMMAND">
          <CommandSurface tool="hydra-dev" />
        </Section>
      </main>

      <Footer />
    </>
  );
}
