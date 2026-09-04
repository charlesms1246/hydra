import { Fragment } from "react";
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
/** The file a claim's citation leads with — the grouping key, taken from generated data. */
const sourceOf = (from: string) => from.replace(/\s*\([^)]*\)/g, "").split(",")[0].trim();

/**
 * The claim's own id, from the parenthesised half of its citation.
 *
 * **This is what goes in the left column, instead of a serial number.** Sixteen consecutive claims
 * open with "Whoever runs the storage server can see", so a reader scanning the left edge of the
 * table gets `01 02 03…`, which tells them nothing, and then eleven identical words before the
 * content starts. `blob.expiry`, `upload.burst`, `read.hit`, `transport.peer` is an index of what
 * each row is *about* — the differentiator, at the place the eye lands first.
 *
 * It is generated data, and short enough that the provenance check reads it as a label rather than
 * as prose. Claims without an id keep the number.
 */
const idOf = (from: string) => /\(([^),]+)\)/.exec(from)?.[1] ?? null;

export function ClaimList({ claims }: { claims: readonly Claim[] }) {
  /*
   * Split into runs by source file, and emit each run as its own generated block with the band
   * OUTSIDE it.
   *
   * The band's text is derived from a citation — a prefix of `from`, not a value `statement()`
   * produced — so putting it inside a `data-generated` block made the provenance check fail, and
   * correctly: that check exists so a marked block cannot carry text the generator did not write,
   * and a substring of a citation is exactly the kind of near-miss it should refuse.
   *
   * The fix is not to widen the check. It is to put the band where it belongs — **the claims are
   * generated, the apparatus around them is not**, and the markup now says so.
   */
  const groups: { source: string; items: { c: Claim; n: number }[] }[] = [];
  claims.forEach((c, i) => {
    const source = sourceOf(c.from);
    const last = groups[groups.length - 1];
    if (last && last.source === source) last.items.push({ c, n: i + 1 });
    else groups.push({ source, items: [{ c, n: i + 1 }] });
  });

  return (
    <div className="claims">
      {groups.map((g, gi) => (
        <Fragment key={g.source + gi}>
          <p className="claim-band" aria-hidden>
            <span>{g.source}</span>
          </p>
          <ul className="claim-run" data-generated="statement">
            {g.items.map(({ c, n }) => (
              <li className={c.complete ? "claim" : "claim partial"} key={c.from + n}>
                <span className="claim-index" aria-hidden>
                  {idOf(c.from) ?? String(n).padStart(2, "0")}
                </span>
                <span className="claim-says">{c.says}</span>
                <span className="claim-from">{c.from}</span>
              </li>
            ))}
          </ul>
        </Fragment>
      ))}
    </div>
  );
}
