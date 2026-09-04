import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Solids } from "./Solids.tsx";

/**
 * The backdrop, on every page.
 *
 * Rendered from `app/layout.tsx` rather than from each page, so a new route gets it without
 * anybody remembering — the same reasoning as enumerating pages from `out/` rather than listing
 * them.
 *
 * **It is on the disclosure page too, and the exit fade is why that is safe.** A field of lit
 * glyphs behind fifty-eight rows of citations would be unreadable, but `Solids.tsx` fades against
 * scroll position and is gone inside about one viewport — so on a long document it is a texture
 * at the masthead and absent by the first claim. The legibility problem solves itself from the
 * same value that drives the motion.
 *
 * Two layers, and the bottom one needs no script: `art.txt` is the project's own ASCII hydra, the
 * drawing the TUI shows on its Disclosure screen, inlined here as text. `Solids` hides it once
 * WebGL is actually running. A reader on a filtered network, without WebGL, or asking for reduced
 * motion keeps the static drawing and every word of the page.
 */
function asciiField(): string {
  return readFileSync(join(process.cwd(), "art.txt"), "utf8").replace(/\n$/, "");
}

export function Backdrop() {
  return (
    <>
      <pre className="field" aria-hidden>
        {asciiField()}
      </pre>
      <Solids />
    </>
  );
}
