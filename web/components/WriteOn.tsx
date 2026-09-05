"use client";

import { useContext, useEffect, useRef } from "react";

import { InDeck } from "./DeckContext.tsx";

/**
 * Text that types itself onto the page under scrollbar control — characters resolving in reading
 * order as the page moves down, and unwriting in reverse as it moves back up.
 *
 * ⛔ **Scroll position, not a triggered animation, and the difference is the whole effect.** The
 * write head is a pure function of where the element sits in the viewport, so the text is never
 * mid-flight independently of the page: stop scrolling and it stops, reverse and it erases, land
 * on the same offset twice and it looks identical both times. A one-shot fired by an
 * `IntersectionObserver` — the obvious implementation — cannot do the last two, because once it
 * has played there is no state left to run backwards. If this is ever "simplified" to an observer
 * callback, the thing that made it worth having is what was removed.
 *
 * ## Why the copy is still readable without JavaScript
 *
 * Characters ship at `opacity: 0` and are revealed from a scroll handler, so with scripting
 * unavailable this would serve paragraphs of invisible text. The `@media (scripting: none)` rule
 * in `globals.css` turns them back on, and its `!important` is load-bearing: it has to beat the
 * inline styles this file writes. **The typing is a flourish; the sentences under it are the
 * content**, which on this site is not a figure of speech — every sentence here is checked by
 * `test/site.test.ts` for claims it is not allowed to make, and a check that reads the markup
 * cannot tell that the reader saw nothing.
 *
 * ## Mechanics
 *
 * **No React state.** Scroll-linked state re-renders the subtree every frame. The spans are
 * written to directly, and only characters that actually crossed the head are touched, so
 * scrubbing a paragraph end to end touches each span exactly once.
 *
 * **Characters are grouped in per-word `inline-block` spans with the spaces left outside them.**
 * Both halves matter: without the word wrapper the browser may break a line mid-word, and with
 * the spaces inside it cannot break lines at all.
 */

/** Viewport fraction at which the element's top starts writing — 1.0 is the viewport floor. */
const START = 1.0;

/**
 * Viewport fraction at which the text is fully written.
 *
 * **Above 0.5 on purpose: writing finishes _before_ the text reaches the middle of the screen.**
 * Below that the reader arrives at a paragraph still assembling itself, which turns a flourish
 * into an obstacle — they either wait or scroll past to force it. At 0.55 the last character
 * settles while the block is still in the lower half, so by the time it is in the reading
 * position it is simply text.
 */
const END = 0.55;

export function WriteOn({
  text,
  className,
  as: Tag = "p",
}: {
  text: string;
  className?: string;
  as?: "p" | "div" | "span" | "h2" | "h3";
}) {
  const ref = useRef<HTMLElement>(null);

  // Inside a deck there is no window scroll to write against — see `DeckContext.tsx`. The text
  // renders plainly and the whole scroll pipeline below is skipped.
  const direct = useContext(InDeck);

  useEffect(() => {
    if (direct) return;
    const el = ref.current;
    if (!el) return;

    const chars = Array.from(el.querySelectorAll<HTMLElement>("[data-ch]"));
    if (!chars.length) return;

    /*
     * Honour the reader's stated preference by writing everything at once.
     *
     * Read here rather than in CSS because the effect is inline styles from a scroll handler,
     * which a media query cannot reach. Checked once at mount: a reader who changes this setting
     * mid-page is not a case worth a listener.
     */
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const c of chars) c.style.opacity = "1";
      return;
    }

    /** How many characters are currently written. Starts at zero: the markup ships hidden. */
    let written = 0;
    let raf = 0;

    const apply = () => {
      raf = 0;
      const top = el.getBoundingClientRect().top;
      const vh = window.innerHeight;
      const start = vh * START;
      const end = vh * END;

      // Clamped inverse-lerp. `end < start`, hence the reversed subtraction.
      const p = Math.min(1, Math.max(0, (start - top) / (start - end)));
      const next = Math.round(p * chars.length);
      if (next === written) return;

      // Only the crossed range is touched. Opacity is transitioned in CSS, so this one write
      // per character produces the brightness ramp.
      if (next > written) for (let i = written; i < next; i++) chars[i].style.opacity = "1";
      else for (let i = written - 1; i >= next; i--) chars[i].style.opacity = "0";
      written = next;
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    // The scroll listener only exists while the paragraph is near the viewport. The margin is
    // generous so the state is already correct by the time it is on screen.
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
  }, [text, direct]);

  // `\n` forces a line break while the character index keeps counting across it — a hard-broken
  // display line has to write as one continuous sweep, not restart per line.
  const lines = text.split("\n").map((line) => line.split(" "));

  /*
   * The direct path emits no per-character spans at all, rather than emitting them and overriding
   * `opacity` back to 1. Those spans exist solely to be addressed by the write head; keeping them
   * would ship thousands of empty elements per slide and leave `.write-on-ch` one specificity
   * accident away from hiding the copy again.
   */
  if (direct) return <Tag className={className}>{text}</Tag>;

  return (
    <Tag ref={ref as React.Ref<never>} className={className}>
      {lines.map((words, li) => (
        <span key={li} className={lines.length > 1 ? "write-on-line" : undefined}>
          {words.map((word, wi) => (
            <span key={`${word}-${wi}`}>
              {/* The word is the unbreakable unit; characters inside it stay in normal inline
                  flow, so kerning and justification are unaffected. */}
              <span className="write-on-word">
                {Array.from(word, (ch, ci) => (
                  <span key={ci} data-ch className="write-on-ch">
                    {ch}
                  </span>
                ))}
              </span>
              {wi < words.length - 1 ? " " : null}
            </span>
          ))}
        </span>
      ))}
    </Tag>
  );
}
