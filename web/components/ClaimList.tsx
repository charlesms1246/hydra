import type { Claim } from "../../hydra-dapp/packages/claims/src/statement.ts";

/**
 * The generated claims, in the reference's content-list layout.
 *
 *   [ mono index ] [ serif sentence ] [ mono citation ]
 *
 * That layout is not borrowed by analogy — it is already the shape of a `Claim`. The reference
 * uses it for articles with a category tag hanging off the right; here the tag is the file that
 * makes the sentence true, which is the only reason this page is worth believing.
 *
 * **`data-generated="statement"` is a test contract, not markup decoration.** `test/site.test.ts`
 * removes every element carrying it before running the forbidden-word check, so that the check
 * is strict about prose a person wrote and silent about sentences the statement produced. A
 * measured claim is allowed to be uncomfortable; an unmeasured one is not allowed at all. If you
 * remove this attribute the check starts failing on the generated text, which is the failure
 * mode it was designed to have.
 *
 * **The citation is not a link.** Some `from` paths are repository-relative and there is no
 * public URL that is guaranteed to resolve for all of them. A page that never offers a click it
 * cannot honour is better than one that offers a 404 — particularly this page, whose entire
 * argument is that what it says can be checked.
 */
export function ClaimList({ claims }: { claims: readonly Claim[] }) {
  return (
    <ul className="claims" data-generated="statement">
      {claims.map((c, i) => (
        <li className={c.complete ? "claim" : "claim partial"} key={c.from + i}>
          <span className="claim-index" aria-hidden>
            {String(i + 1).padStart(2, "0")}
          </span>
          <span className="claim-says">{c.says}</span>
          <span className="claim-from">{c.from}</span>
        </li>
      ))}
    </ul>
  );
}
