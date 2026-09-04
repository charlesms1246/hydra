import { SITE } from "../content.ts";

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
      <div className="footer-cols">
        <div className="footer-col">
          <h2>Read</h2>
          <ul>
            <li><a href="/">Home</a></li>
            <li><a href="/disclosures/">Disclosures</a></li>
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
