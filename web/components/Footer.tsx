import { SITE } from "../content.ts";
import { provenance } from "../scripts/provenance.ts";
import { isPublicBuild } from "../scripts/build-mode.ts";
import { AsciiPanel } from "./viz/AsciiPanel.tsx";
import { Develop } from "./Develop.tsx";

/**
 * The footer.
 *
 * The reference's footer is mostly a company's legal furniture — terms, disclosures, a copyright
 * line, an address, a press kit. **There is no company.** So the columns hold what is true: where
 * to read, what the two tools are, and where the code is. No canary, no contact, no entity, no
 * copyright line — each of those would imply a legal person that does not exist, and
 * `test/site.test.ts` fails if one appears.
 *
 * ## Both margins, and why they carry these two facts
 *
 * The reference runs rotated mono up both edges: network metadata on one side, a copyright on the
 * other. There is no copyright to assert and no network fact worth a spine. **What belongs there
 * is the pair of facts that make this page checkable: which commit it was built from, and which
 * of the two builds produced it.** A reader who has just been told the claims are verifiable can
 * verify the artefact itself from its own margins.
 *
 * They are not decoration standing in for information. The build mode is the same fact
 * `data-build` puts on the document and the Pages check asserts; the commit is `git rev-parse`.
 * Both fail soft — see `scripts/provenance.ts` — because a footer ornament is not worth failing a
 * build over, and an absent one is honest where a placeholder would not be.
 */
export function Footer() {
  const commit = provenance();
  return (
    <footer className="footer">
      {/*
        Where the reference puts network metadata and a copyright. See the header: these are the
        two facts about the artefact a reader is looking at, one per margin.
      */}
      <span className="footer-edge footer-edge-l" aria-hidden>
        {isPublicBuild() ? "PUBLIC BUILD" : "LOCAL BUILD"}
      </span>
      {commit && (
        <span className="footer-edge footer-edge-r" aria-hidden>
          {commit}
        </span>
      )}

      <div className="footer-cols">
        <div className="footer-col">
          <h2>Read</h2>
          <ul>
            <li><a href="/">Home</a></li>
            <li><a href="/pitch/">Why this exists</a></li>
            <li><a href="/install/">Run it</a></li>
            <li><a href="/about/">About</a></li>
            <li><a href="/about/disclosure/">Disclosures</a></li>
          </ul>
        </div>

        {/*
          The two tools, named separately.

          They were reachable only through `/demo/`, one click in, which is the wrong place for
          the distinction this site spends a whole page making — the client and the devtool are
          for different people, and a reader who wants one of them should not have to open a
          routing page to find out which.
        */}
        <div className="footer-col">
          <h2>Run</h2>
          <ul>
            <li><a href="/demo/">See it run</a></li>
            <li><a href="/demo/hydra/">The client</a></li>
            <li><a href="/demo/hydra-dev/">The devtool</a></li>
          </ul>
        </div>

        <div className="footer-col">
          <h2>Source</h2>
          <ul>
            {SITE.links.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
        </div>

        {/* The reference sets an ASCII mark in its footer. This is the same drawing the rest of
            the site uses, small and faint — a printer's device rather than a logo.

            Its own column at wide widths, so it occupies the space three uneven link lists leave
            rather than sitting under them with a gap above it. `.panel-art` floors its glyph at
            6px and crops below that, so a 64-column field needs 230px before it is sliced: the
            minimum width is set accordingly and is not a taste value.

            33 rows rather than 26: `panel()` now preserves the drawing's aspect and crops rather
            than stretching, so a grid that does not match 100x52 loses the top and bottom of the
            mark. 64 x 33 is the whole of it. */}
        <div className="footer-mark" aria-hidden>
          <Develop>
            <AsciiPanel cols={64} rows={33} blur={2.2} gain={1.1} />
          </Develop>
        </div>
      </div>

      {/*
        The three legal routes, in the note band rather than as a fourth column.

        They are not a fourth peer of Read / Run / Source — nobody browses a site by its licence —
        and the column grid above is tuned to three lists plus the mark, so a fourth would have
        landed in the mark's own cell. A rule under the columns is where this furniture goes on
        every site that has it, and here it costs one new selector rather than a regrid.
      */}
      <nav className="footer-legal" aria-label="Legal">
        <a href="/legal/license/">License</a>
        <a href="/legal/privacy/">Privacy</a>
        <a href="/legal/terms/">Terms of use</a>
      </nav>

      <div className="footer-note">
        <span className="footer-tick" aria-hidden>
          INFO
        </span>
        <p>
          The claims on the disclosure page are generated from the code that makes them true, by
          the same function the client renders on its own Disclosure screen. Nothing here is a
          promise about what anyone will do with what they can see.
        </p>
      </div>
    </footer>
  );
}
