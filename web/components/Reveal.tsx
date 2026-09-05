"use client";

import { useEffect, useRef } from "react";

/**
 * One reveal for figures and boxes, so the site stops having several.
 *
 * ⛔ **The site had three different reveals and no rule about which applied where** — `WriteOn`
 * for a lede, `Develop` for an ASCII field, and nothing at all for figures and cards. A reader
 * scrolling one page met text that typed, artwork that resolved, and diagrams that were simply
 * already there, which reads as three unfinished ideas rather than one intention.
 *
 * This is the third: a figure or a box fades and rises once, when it arrives.
 *
 * ## ⛔ IT OBSERVES ITS OWN SCROLLER, NOT THE VIEWPORT
 *
 * The pitch is a horizontal deck that is its own scroll container, so a viewport-rooted observer
 * fires for every slide at once while the reader is still on the first — every figure would have
 * played before it was seen. The nearest scrollable ancestor is found and used as the observer
 * root, which makes the same component correct on a scrolling page (root: the viewport) and
 * inside the deck (root: the track).
 *
 * That is the third component to hit this trap — `WriteOn` and `Develop` both take a direct path
 * inside a deck via `InDeck`. **Here the answer is better than opting out**: the reveal is not a
 * function of scroll POSITION, only of arrival, so it works in a horizontal scroller instead of
 * having to be disabled in one.
 *
 * ## Once, and never back
 *
 * It does not un-reveal. `WriteOn` deliberately runs backwards because its whole argument is that
 * the write head is a pure function of scroll offset. This is not that: a figure that faded out
 * when it left and back in when it returned would flicker on every pass through a deck, and a
 * reader moving between two slides would see the artwork restart each time.
 *
 * Without JavaScript nothing is hidden — the CSS default is the revealed state, and `.is-revealed`
 * only confirms it. Same contract as every other effect here: the flourish is the animation and
 * the content is not.
 */
export function Reveal({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("is-revealed");
      return;
    }

    /*
     * ⛔ THE DECK, EXPLICITLY. Do not go back to "nearest scrollable ancestor".
     *
     * That is what this did, and it was wrong twice over. Walking up for any `overflow: auto`
     * finds `.slide` first — which has `overflow-y: auto` for tall content — so a figure was
     * measured against its own slide and intersected immediately. On an ordinary page it found
     * `body`, whose computed overflow is `hidden auto`, and a root the height of the whole
     * document means everything intersects at load.
     *
     * **Both bugs presented as success**: the probe counted five revealed elements and reported
     * five, which is what a working reveal also looks like. What separated them was asking
     * WHEN — all five had fired on slide one. A count is not a measurement of staging.
     *
     * `[data-deck]` or the viewport. Two cases, named, no inference.
     */
    const root: Element | null = el.closest("[data-deck]");

    el.classList.add("is-hidden");
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        el.classList.remove("is-hidden");
        el.classList.add("is-revealed");
        io.disconnect();
      },
      { root, threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={className ? `reveal ${className}` : "reveal"}>
      {children}
    </div>
  );
}
