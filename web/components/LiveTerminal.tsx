"use client";

import { useEffect, useRef, useState } from "react";
import { render } from "../../hydra-dapp/packages/tui/src/view.ts";
import { channelNames } from "../../hydra-dapp/packages/tui/src/model.ts";
import type { View } from "../../hydra-dapp/packages/tui/src/model.ts";
import { navigate } from "../../hydra-dapp/packages/tui/src/nav.ts";
import type { Key } from "../../hydra-dapp/packages/tui/src/keys.ts";
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

/**
 * A DOM key event as the product's `Key`.
 *
 * ⚠ This is a translation, NOT a second implementation. `keys.ts` parses escape sequences off a
 * terminal's stdin; a browser hands us named keys instead, so something has to map one input
 * source onto the other. What it must not do is decide what a key MEANS — that is `nav.ts`, which
 * `app.ts` calls too. This function only says which `Key` was pressed.
 *
 * `null` for anything the product has no key for, so an unmapped browser key does nothing rather
 * than something invented.
 */
function keyOf(e: React.KeyboardEvent): Key | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "Enter": return { t: "enter" };
    case "Backspace": return { t: "backspace" };
    case "Tab": return e.shiftKey ? { t: "shift-tab" } : { t: "tab" };
    case "Escape": return { t: "escape" };
    case "ArrowUp": return { t: "up" };
    case "ArrowDown": return { t: "down" };
    case "ArrowLeft": return { t: "left" };
    case "ArrowRight": return { t: "right" };
    case "PageUp": return { t: "page-up" };
    case "PageDown": return { t: "page-down" };
    default:
      return e.key.length === 1 ? { t: "char", value: e.key } : null;
  }
}

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
export function LiveTerminal({ view: initial, commands, children }: {
  view: View;
  commands: readonly string[];
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  /** `null` until measured. A guessed default would draw one frame at the wrong size and jump. */
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const [tab, setTab] = useState<"tui" | "commands">("tui");
  /**
   * The demo's own copy of the view, moved by the PRODUCT'S OWN key handling.
   *
   * `nav.ts` `navigate` is the same function `app.ts` calls, so `2`, `j`, `k`, `i`, `[`, `]` and
   * `?` do here exactly what they do in the client — not because this agrees with the product,
   * but because it IS the product's code. Anything `navigate` returns `null` for is an effect
   * (send, read, flush) and there is no chain, vault or filesystem here to run one against, so it
   * correctly does nothing.
   */
  const [view, setView] = useState<View>(initial);

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
      <div
        ref={box}
        className="term-live-box"
        data-live-terminal={size ? size.cols : "measuring"}
        data-page={view.page}
        tabIndex={tab === "tui" ? 0 : -1}
        role={tab === "tui" ? "application" : undefined}
        aria-label={tab === "tui" ? "The terminal interface. Try 1 to 6, j, k, i and ?" : undefined}
        onKeyDown={(e) => {
          if (tab !== "tui") return;
          const k = keyOf(e);
          if (!k) return;
          const moved = navigate(view, k, channelNames(view).length);
          if (!moved) return;
          // Only once the product has actually consumed it — otherwise Tab would stop moving
          // focus out of a widget a reader may not have meant to enter.
          e.preventDefault();
          setView(moved);
        }}
      >
        {lines && size
          ? <Screen lines={lines} cols={size.cols} fit="fixed" />
          : children}
      </div>
    </div>
  );
}
