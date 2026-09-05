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
 * scroll position and is gone inside about one viewport.
 *
 * ⛔ **THE STATIC ASCII HYDRA IS GONE FROM HERE, 2026-09-05.** It was a second layer under
 * `Solids` — the whole 100x52 drawing, inlined as text, shown whenever WebGL was not running.
 *
 * It was removed on the user's instruction: *"for some reason a full render of the ascii art is in
 * all pages, this is not needed."* They are right, and the reason it read as wrong is that it was
 * the same drawing at full size behind every page, so it stopped being a backdrop and became a
 * picture the page happened to sit on.
 *
 * What replaced it is nothing. `Solids` is the backdrop; a reader without WebGL gets a black page,
 * which is the correct fallback for decoration — the alternative was a fallback louder than the
 * thing it stood in for.
 */
export function Backdrop() {
  return (
    <>
      <Solids />
    </>
  );
}
