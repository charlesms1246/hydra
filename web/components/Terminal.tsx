import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The terminal interface, rendered by the terminal interface.
 *
 * ⛔ **This is not a drawing of the TUI. It is the TUI's own output.** `scripts/capture-tui.ts`
 * calls `render()` from `packages/tui/src/view.ts` — the same pure function `main.ts` calls once
 * per frame — with a fixture model, and writes the result to `tui-frames.json` at build time. Every
 * box character, pane title, column width, truncation and colour here was produced by the product.
 *
 * The previous version hand-drew a box with the right glyphs, and the difference is exactly the one
 * the site keeps making elsewhere: a description of a thing is not the thing, and it goes stale
 * without anybody noticing. A capture that stops matching the product fails the build, because the
 * capture *is* the product running.
 *
 * ## Why the frames come through a file rather than an import
 *
 * `view.ts` reaches `identity/src/domains.ts` and three `vault-client` modules. **I6 says no
 * key-handling code may enter a browser context**, and `scripts/module-graph.ts` fails the build if
 * a page can reach one — correctly. So the renderer runs on the build machine and emits text, and
 * this component reads text. Same shape as `CommandSurface`, which captures the CLI's real help.
 *
 * ## Colour
 *
 * The capture translates the terminal's SGR codes to tone NAMES, not to colours, so this site's
 * palette decides what `warn` looks like rather than inheriting whatever a terminal would have
 * chosen. `screen.ts` uses nine tones and only nine are mapped; an unmapped code renders unstyled
 * rather than wrong.
 */

import type { Span } from "../scripts/ansi.ts";
import { Screen } from "./Screen.tsx";

type Frames = { chats: Span[][]; status: Span[][] };

function frames(): Frames {
  const path = join(process.cwd(), "tui-frames.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Frames;
  } catch {
    throw new Error(
      `${path} is missing. It is written by \`node scripts/capture-tui.ts\`, which runs as part of `
      + "`npm run build` — a page showing a terminal that was never rendered would be a drawing, "
      + "which is the thing this component exists to stop being.",
    );
  }
}

export function Terminal({ frame }: { frame: "chats" | "status" }) {
  const lines = frames()[frame];

  // Vacuity: an empty capture would render an empty box and look like a design choice.
  if (!lines?.length) {
    throw new Error(`tui-frames.json has no \`${frame}\` frame — the capture produced nothing.`);
  }

  const cols = Math.max(...lines.map((l) => l.reduce((n, s) => n + s.t.length, 0)));

  // The markup lives in `Screen` because the live render produces the same thing from different
  // spans, and two copies of it would agree until somebody edited one.
  return <Screen lines={lines} cols={cols} fit="scale" />;
}
