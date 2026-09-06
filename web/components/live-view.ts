import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { View } from "../../hydra-dapp/packages/tui/src/model.ts";

/**
 * The fixture `View` the live render draws, read on the server and passed down as a prop.
 *
 * ⛔ **Separate from `LiveTerminal.tsx` because that file is a client component and this reads a
 * file.** `node:fs` in a module a `"use client"` file imports is a build error, and the shape that
 * avoids it is the one Next.js already wants: the server reads, the client draws.
 *
 * Written by `scripts/capture-tui.ts` from the same `FIXTURE_STATE` the captured frames come from,
 * through the same `viewOf`. **One fixture, so the leak assertions in that script stand behind both
 * renders** — a second, hand-written `View` would be a second fixture with nothing checking it.
 *
 * The browser cannot build this for itself: `viewOf` lives in `app.ts`, which reaches
 * `packages/identity/`, which is exactly what I6 forbids in a browser context. So it arrives as
 * data. That is the same reason `Terminal.tsx` reads text rather than importing the renderer.
 */
export function liveView(): View {
  const path = join(process.cwd(), "tui-view.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as View;
  } catch {
    throw new Error(
      `${path} is missing. It is written by \`node scripts/capture-tui.ts\`, which runs as part of `
      + "`npm run build` — a live terminal with no model would render an empty box, which is the "
      + "failure a missing capture should never be allowed to look like.",
    );
  }
}
