"use client";

import { useEffect, useRef, useState } from "react";
import { render } from "../../hydra-dapp/packages/tui/src/view.ts";
import type { View } from "../../hydra-dapp/packages/tui/src/model.ts";
import { spans } from "../scripts/ansi.ts";
import type { Span } from "../scripts/ansi.ts";
import { Screen } from "./Screen.tsx";

/**
 * The terminal interface, re-rendered in the reader's browser at the reader's width.
 *
 * ## What this proves that a capture cannot
 *
 * `tui-frames.json` proves the layout at 96 columns, because that is the width it was rendered at.
 * On a 390px phone the CSS can only shrink it: `font-size: 100cqw / (cols * 0.61)` puts 96 columns
 * at about 6.7px against a 5px floor. Accurate and unreadable.
 *
 * This calls the same `render()` at the number of columns that actually fit at a readable size, so
 * **the truncation, the wrapping and the column arithmetic are the product's own, at the reader's
 * width.** `screen.ts` `truncate` and `wrap` decide what survives a narrow pane, and whether those
 * decisions are any good is a question a fixed-width picture cannot answer.
 *
 * ## WHY THIS MAY IMPORT `view.ts` AT ALL
 *
 * It is a client component, so everything it imports is bundled and served. I6 says no pool viewing
 * key and no vault content key may enter a browser, and `scripts/module-graph.ts` fails the build if
 * a page reaches `packages/identity/` or `packages/vault-client/`.
 *
 * `view.ts` used to reach four such modules across a graph of forty-three. It now reaches ten files
 * and none of them, because it draws a `View` — a narrow projection built on the Node side by
 * `app.ts` `viewOf` — instead of the client's `State`. **That is the only reason this import is
 * allowed, and it is not a general licence.** `app.ts` itself is still forbidden here, which is why
 * the view arrives as data rather than being derived in the browser.
 *
 * **Every specifier here and downstream must be relative.** `web/tsconfig.json` configures the
 * `@` path alias onto the package root, and `module-graph.ts` `resolveSpecifier` returns null for
 * anything not starting with `.` — so an `@`-aliased import ends the walk silently and the
 * boundary check would report zero having never entered this subtree. A page written the way a
 * Next.js developer writes pages is invisible to that check.
 *
 * The alias is deliberately described rather than written out above: `specifiersOf` strips
 * comments with a non-greedy match from the first comment opener to the next closer, so a literal
 * one inside this text is a sequence that only ever costs something later.
 */

/** Columns below this stop being a terminal and start being a column of single words. */
const MIN_COLS = 40;

/** And rows below this cannot hold a frame with a nav, a body and two footer lines. */
const MIN_ROWS = 12;

/**
 * `children` is the captured frame, server-rendered, and it is the fallback in the real sense:
 * it is in the markup, it is what a reader without JavaScript keeps, and it is what stays on
 * screen until a measurement exists. Only then is it replaced — never blanked first.
 *
 * `commands` is the same tool's real help output, captured by `cli-surface.ts` at build time.
 * It is drawn through the SAME `Screen` and the same tone mapping as the frame, because it is
 * the same surface showing a different thing — a terminal beside a styled code block would be
 * two treatments of one idea.
 */
export function LiveTerminal({ view, commands, children }: {
  view: View;
  commands: readonly string[];
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  /** `null` until measured. A guessed default would draw one frame at the wrong size and jump. */
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const [tab, setTab] = useState<"tui" | "commands">("tui");

  useEffect(() => {
    const el = box.current;
    if (!el) return;

    /**
     * One character's advance and one line's height, measured rather than assumed.
     *
     * The `0.61` in `globals.css` is a constant chosen to fit a known grid; here the grid is the
     * unknown, so guessing a ratio would put the box a few columns off in whatever font the
     * reader actually has. A hundred characters, because measuring one rounds badly.
     */
    const probe = (): { advance: number; line: number } => {
      const el2 = document.createElement("span");
      el2.className = "term-screen term-live";
      el2.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      el2.textContent = "0".repeat(100);
      el.appendChild(el2);
      const r = el2.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(el2).lineHeight) || r.height;
      el2.remove();
      return { advance: r.width / 100, line };
    };

    const fit = () => {
      const { advance, line } = probe();
      if (!advance || !line) return; // fonts not ready; the observer fires again when they are
      const r = el.getBoundingClientRect();
      setSize({
        cols: Math.max(MIN_COLS, Math.floor(r.width / advance)),
        rows: Math.max(MIN_ROWS, Math.floor(r.height / line)),
      });
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Plain text through the same mapper: `commandLines` carries no SGR, so every span comes back
     untoned and the site's palette draws it as body text inside the terminal frame. */
  const commandSpans: Span[][] = commands.map((l) => spans(l));

  const lines = size
    ? (tab === "tui" ? render(view, size).map(spans) : commandSpans)
    : null;

  return (
    <div className="term-live-wrap">
      <div className="term-tabs" role="tablist" aria-label="What to show">
        {(["tui", "commands"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "term-tab term-tab-on" : "term-tab"}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div ref={box} className="term-live-box" data-live-terminal={size ? size.cols : "measuring"}>
        {lines && size
          ? <Screen lines={lines} cols={size.cols} fit="fixed" />
          : children}
      </div>
    </div>
  );
}
