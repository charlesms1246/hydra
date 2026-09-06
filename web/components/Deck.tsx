"use client";

import { useEffect, useRef, useState } from "react";

import { InDeck } from "./DeckContext.tsx";
import { Reveal } from "./Reveal.tsx";

/**
 * A horizontal slide deck: a snap-scrolling track, a progress rail, a counter and keyboard nav.
 *
 * **The pitch is slides because of who reads it** — a judge, watching a presenter, once. A tall
 * page invites reading and rewards skimming; a horizontal track says one screen, one claim, and a
 * swipe or an arrow moves exactly one beat. There is no "read on" affordance to resist.
 *
 * ## ⛔ WITHOUT JAVASCRIPT THIS BECOMES A VERTICAL PAGE, AND THAT WAS DECIDED FIRST
 *
 * The advancement is **CSS**, not script: an `overflow-x: auto` container with
 * `scroll-snap-type: x mandatory` and one snap point per slide. The script adds only the rail, the
 * counter and the keys. So with scripting off every slide is still reachable — but reachable by
 * *horizontal* scrolling, which on a desktop means shift-wheel and is a thing a reader has to
 * already know. **A deck that hides five of its six slides behind an affordance nobody sees is a
 * deck that shows one slide**, and this is the page the argument lives on.
 *
 * So `@media (scripting: none)` in `globals.css` unwinds the track into an ordinary vertical
 * stack. Not a degraded deck — a page, which is the shape that needs no affordance at all. The
 * same idiom keeps `WriteOn`'s copy readable, and it is the second load-bearing use of it here.
 *
 * The container also carries `tabIndex={0}` and an accessible name, so it is reachable and
 * arrow-scrollable by keyboard through the platform alone, before any of the handlers below run.
 *
 * ## The two nested elements in `Slide` are not optional
 *
 * Centring with `justify-content: center` directly on a scroll container silently truncates: once
 * content is taller than the box, flex centring overflows in **both** directions and the overflow
 * above the start edge is unreachable, because a scrollbar cannot travel to a negative offset. The
 * copy simply begins part-way through, on exactly the small screens nobody checks. The inner
 * wrapper separates the cases — short content centres in a viewport-tall box, tall content grows
 * past `min-height` and centring becomes a no-op.
 */
export function Deck({
  labels,
  children,
}: {
  /** One short label per slide, in order. Used for the rail and its accessible names. */
  labels: readonly string[];
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const count = root.querySelectorAll("[data-slide]").length;
    if (!count) return;

    /*
     * Derived from `scrollLeft`, not from per-slide rects: every slide is exactly one container
     * width, so this is one read instead of N, and it cannot disagree with the snap positions the
     * way a midpoint test can at a fractional device pixel ratio.
     */
    let raf = 0;
    const measure = () => {
      raf = 0;
      const w = root.clientWidth;
      if (!w) return;
      setActive(Math.max(0, Math.min(count - 1, Math.round(root.scrollLeft / w))));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };

    const go = (i: number) => {
      const target = Math.min(count - 1, Math.max(0, i));
      root.scrollTo({ left: target * root.clientWidth, behavior: "smooth" });
    };

    const onKey = (e: KeyboardEvent) => {
      // Never hijack keys aimed at something else — a focused field, or a modifier combination
      // that belongs to the browser.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      /*
       * Vertical keys are bound alongside the horizontal ones. A presenter remote emits
       * PageDown/PageUp — some emit Down/Up — with no way to know the deck runs sideways, so a
       * clicker must advance it or the deck cannot be presented from one, which is the single
       * situation it was built for.
       */
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        go(active + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        go(active - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        go(0);
      } else if (e.key === "End") {
        e.preventDefault();
        go(count - 1);
      }
    };

    measure();
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("keydown", onKey);
    };
  }, [active]);

  const jump = (i: number) => {
    const root = ref.current;
    if (!root) return;
    root.scrollTo({ left: i * root.clientWidth, behavior: "smooth" });
  };

  return (
    <>
      <div
        ref={ref}
        className="deck"
        data-deck
        tabIndex={0}
        role="region"
        aria-label="Pitch slides"
      >
        <InDeck.Provider value>{children}</InDeck.Provider>
      </div>

      {/*
        The rail is navigation, not decoration. Slides are the one layout where a reader cannot
        tell how much is left — every screen looks like the last — so the deck owes them a
        position and a way to jump. Hidden on narrow screens, where it would sit over the copy and
        where a touch reader already has momentum and a scrollbar.
      */}
      <nav className="deck-rail" aria-label="Slides">
        {labels.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => jump(i)}
            aria-label={`Go to ${label}`}
            aria-current={i === active ? "true" : undefined}
            className={i === active ? "deck-dot is-active" : "deck-dot"}
          >
            <span className="deck-dot-label">{label}</span>
            <span className="deck-dot-line" aria-hidden />
          </button>
        ))}
      </nav>

      <span className="deck-count" aria-hidden>
        {String(active + 1).padStart(2, "0")} / {String(labels.length).padStart(2, "0")}
      </span>
    </>
  );
}

/**
 * One slide: exactly one viewport wide, full height, and its own vertical scroller.
 *
 * ⛔ **A slide's argument has to fit its slide, and `aside` is how a figure stops fighting it.**
 *
 * Measured before this existed: at 1440x700 — an ordinary laptop with browser chrome — **all six
 * slides overflowed**, and on slide 06 the two things below the fold were `pitch.lede`, the
 * sentence the copy spec moved here precisely because it is the strongest close on the site, and
 * the only link out of the deck. The tail was reachable by scrolling *vertically inside a slide
 * that had just taught the reader movement is sideways*, which is less discoverable than the
 * horizontal scrolling this deck already refuses to rely on.
 *
 * A figure passed as `aside` moves beside the copy on a wide screen instead of under it, which
 * removes the tallest item from the vertical stack and uses the empty half of the slide the
 * measurement showed was there. Below that width it falls back under the copy, where the
 * viewport is tall relative to its width and there is room.
 *
 * **The fix is layout, not a scroll affordance.** Signposting a scroll treats a discoverability
 * problem as a labelling one, and the whole reason a deck is one screen per claim is to not have
 * that problem.
 */
export function Slide({
  n,
  label,
  aside,
  centre,
  children,
}: {
  n?: string;
  label: string;
  /** A figure or generated block. Sits beside the copy on a wide screen, under it otherwise. */
  aside?: React.ReactNode;
  /** The opener and the closer: one statement, centred, no section tick. */
  centre?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="slide" data-slide aria-label={label}>
      <div
        className={
          centre ? "slide-inner is-centre" : aside ? "slide-inner is-split" : "slide-inner"
        }
      >
        {/*
          ⛔ A FADE, not a write-on, and the deck is why.

          `WriteOn` drives its head from `window.scrollY`, which does not move in a horizontal
          scroller — that is what `InDeck` exists to prevent. But the instruction is that every
          slide's text animates, so the answer is a motion that depends on ARRIVAL rather than on
          offset. `Reveal` already works that way and already observes the deck as its root, so a
          slide's copy fades in when the slide reaches the reader and not before.
        */}
        <Reveal className="slide-copy">
          {n && (
            <span className="slide-tick" aria-hidden>
              {n} — {label}
            </span>
          )}
          {children}
        </Reveal>
        {aside && <div className="slide-aside">{aside}</div>}
      </div>
    </section>
  );
}
