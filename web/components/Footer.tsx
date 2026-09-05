import { SITE } from "../content.ts";
import { provenance } from "../scripts/provenance.ts";
import { AsciiPanel } from "./viz/AsciiPanel.tsx";

/**
 * The footer.
 *
 * The reference's footer is mostly a company's legal furniture — terms, disclosures, a copyright
 * line, an address, a press kit. **There is no company.** So the columns hold what is true:
 * where the code is, and where the generated statement is. No canary, no contact, no entity, no
 * copyright line — each of those would imply a legal person that does not exist, and
 * `test/site.test.ts` fails if one appears.
 */
export function Footer() {
  return (
    <footer className="footer">
      {/* Where the reference puts a copyright. There is no entity to assert one, and a project
          arguing that its claims are checkable has something better for that slot: the commit this
          page was built from. See `scripts/provenance.ts`. */}
      {provenance() && (
        <span className="footer-edge" aria-hidden>
          {provenance()}
        </span>
      )}
      <div className="footer-cols">
        <div className="footer-col">
          <h2>Read</h2>
          <ul>
            <li><a href="/">Home</a></li>
            <li><a href="/pitch/">Why this exists</a></li>
            <li><a href="/demo/">See it run</a></li>
            <li><a href="/install/">Run it</a></li>
            <li><a href="/about/">About</a></li>
            <li><a href="/about/disclosure/">Disclosures</a></li>
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
      </div>

      {/* The reference sets an ASCII mark in the middle of its footer. This is the same drawing
          the rest of the site uses, small and faint — a printer's device rather than a logo. */}
      <div className="footer-mark" aria-hidden>
        <AsciiPanel cols={64} rows={26} blur={2.2} gain={1.1} />
      </div>

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
