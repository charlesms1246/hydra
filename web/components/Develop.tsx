"use client";

import { useEffect, useRef } from "react";

import { InDeck } from "./DeckContext.tsx";
import { useContext } from "react";

/**
 * Makes an ASCII field **develop** as it rises through the viewport — sparse and dim on entry,
 * fully resolved around centre screen.
 *
 * ⛔ **This is a reveal, not a fade, and the difference is the whole point.** The glyph
 * population changes: bright cells arrive first and the faint ones fill in behind them, so the
 * image assembles character by character. Ramping the opacity of the whole panel reads as a video
 * dissolve; this reads as something being computed, which is what the rest of the site is arguing
 * the project does.
 *
 * ## Why it writes one custom property and nothing else
 *
 * The field is generated at build time — `panel()` runs in Node and the glyphs ship as static
 * markup, several hundred spans per field. **Re-rendering that per frame is not affordable and
 * re-computing the dither in the browser would ship the generator to the client**, which is the
 * whole reason it does not run there.
 *
 * So each run already carries its grey step; this writes a single `--lvl` on the wrapper and CSS
 * does the rest — see `.panel-art span` in `globals.css`. One property write per frame, no React
 * state, no layout, and the work is a compositor opacity change on spans that already exist.
 *
 * ## The two ways it declines to run
 *
 * **No JavaScript:** `--lvl` is never set, the CSS default is "fully developed", and the field is
 * simply there. Same contract as `WriteOn` — the effect is a flourish and the artwork is not.
 *
 * **Reduced motion:** developed immediately, once, at mount. A reader who has asked for less
 * motion should not get an image that assembles itself while they read.
 *
 * **Inside a deck:** nothing happens at all, because `window.scrollY` does not move while a
 * reader advances through slides — the same trap `WriteOn` documents, and the reason `InDeck`
 * exists. A field stuck at its entry level would be a slide of near-empty artwork that looks
 * deliberate.
 */

/** Viewport fraction where developing starts — 1.0 is the floor. */
const START = 1.0;

/** Viewport fraction where it is fully resolved. Above 0.5: done before the reading position. */
const END = 0.5;

export function Develop({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inDeck = useContext(InDeck);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // A deck is its own horizontal scroller, so the window's scroll never moves. Leave the field
    // fully developed rather than frozen part-way. See `DeckContext.tsx`.
    if (inDeck || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.style.setProperty("--lvl", "100");
      return;
    }

    let raf = 0;
    let last = -1;

    const apply = () => {
      raf = 0;
      const top = el.getBoundingClientRect().top;
      const vh = window.innerHeight;
      const p = Math.min(1, Math.max(0, (vh * START - top) / (vh * (START - END))));
      // Quantised to whole percent: below that the writes are invisible and merely frequent.
      const lvl = Math.round(p * 100);
      if (lvl === last) return;
      last = lvl;
      el.style.setProperty("--lvl", String(lvl));
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    // The listener exists only while the field is near the viewport.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          window.addEventListener("scroll", schedule, { passive: true });
          schedule();
        } else {
          window.removeEventListener("scroll", schedule);
        }
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(el);
    window.addEventListener("resize", schedule, { passive: true });
    apply();

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [inDeck]);

  return (
    <div ref={ref} className="develop">
      {children}
    </div>
  );
}
