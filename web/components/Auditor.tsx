import { auditorClaims, LEADS_WITH } from "./auditor-claims.ts";

/**
 * The auditor section — the largest type on the page after the wordmark, filled from the
 * statement rather than written here.
 *
 * **Standing rule 5: the auditor line appears in every disclosure statement, always, and never
 * as a footnote.** Standing rule 3: privacy claims are generated, never asserted. Those two
 * rules normally pull against each other on a marketing page — the honest thing to say about the
 * auditor is the thing a marketing page most wants to shrink, and the way it gets shrunk is by
 * being paraphrased into hand-written copy where nobody measures it.
 *
 * Giving the loudest visual moment on the page to generated text satisfies both at once instead
 * of trading one against the other. The pool's auditor holds a root key that decrypts pool notes
 * but not message content, and can see the communication graph. That is not a caveat to bury;
 * saying it plainly is part of the pitch.
 */
export function Auditor() {
  const claims = auditorClaims();

  // A build that renders no auditor line is a build that broke standing rule 5, and it would do
  // it silently — the section would simply be empty and look like a design choice. Failing here
  // turns that into a build error, which is the only way a rule about what must always appear
  // can be enforced by anything other than somebody remembering.
  if (claims.length === 0) {
    throw new Error(
      "no auditor claim in statement(): the disclosure statement must always carry one "
      + "(standing rule 5), so either the statement lost it or the selector in "
      + "components/auditor-claims.ts stopped matching it. Do not ship the page without it.",
    );
  }

  const lead = claims.find((c) => LEADS_WITH.test(c.says)) ?? claims[0];
  const rest = claims.filter((c) => c !== lead);

  return (
    <div className="auditor" data-generated="statement">
      <p className="auditor-lead">{lead.says}</p>
      <div className="auditor-rest">
        {rest.map((c, i) => (
          <p key={c.from + i}>{c.says}</p>
        ))}
      </div>
    </div>
  );
}
