/**
 * Can a reader of THIS distribution open the thing a citation names?
 *
 * Resolved here INDEPENDENTLY of `facts.mjs:isHeldCite`, on purpose. Both the leak suite and
 * the linter suite assert that every citation is openable or is marked held, and a guard that
 * asked the very function it guards would agree with itself no matter what either of them did.
 * The duplication is the check.
 *
 * Two roots, because a citation resolves against wherever the reader is standing: in a checkout
 * `findings/` and `README.md` sit at the repository root; in an installed package the README is
 * at the package root and there is no repository above it.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..", "..", "..");        // devtool/, the published package root
const REPO = join(PKG, "..");                    // the checkout, when this is one

/** A citation may name lines — `README.md:140-141`. The file is what has to exist. */
const filePart = (c) => String(c).replace(/:[\d,\-]+$/, "");

export function openableHere(cite) {
  const c = String(cite);
  // `upstream:` names starkware-libs/starknet-privacy at UPSTREAM_COMMIT — a public repository,
  // openable by anyone with a browser, whether or not they cloned it.
  if (c.startsWith("upstream:")) return true;
  const f = filePart(c);
  return existsSync(join(PKG, f)) || existsSync(join(REPO, f));
}
