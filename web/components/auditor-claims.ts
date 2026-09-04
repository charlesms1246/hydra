import { statement } from "../../hydra-dapp/packages/claims/src/statement.ts";
import type { Claim } from "../../hydra-dapp/packages/claims/src/statement.ts";

/**
 * Which claims the auditor section shows — selected by what they SAY, not by a hand-kept list.
 *
 * Separate from `Auditor.tsx` so the test can import it: this file has no JSX, and Node's test
 * runner strips types from `.ts` but will not parse `.tsx`. Selection is the part worth testing
 * anyway — the rendering is a `<p>`.
 *
 * A hardcoded set of ids would silently stop matching the day the auditor's disclosures are
 * renumbered, and the section would quietly shrink to nothing while still looking deliberate.
 * Matching on the word means a new auditor claim in `statement.ts` appears here without anybody
 * remembering to add it, which is the same property the rest of the page has.
 */
export function auditorClaims(): Claim[] {
  const s = statement();
  return [...s.whoCanSeeWhat, ...s.whatIsPartial, ...s.whatWeCannotSee].filter((c) =>
    /\bauditor\b/i.test(c.says),
  );
}

/**
 * The one the section leads with: what the auditor plus the storage operator can work out
 * between them, which is the communication graph. Chosen because it is the disclosure a reader
 * is least likely to have assumed and most likely to care about.
 */
export const LEADS_WITH = /name who was talking to whom/i;
