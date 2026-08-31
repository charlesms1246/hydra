/**
 * Drawing, with no dependencies.
 *
 * The Devtool's TUI is Ink and React and that was the right call there: it is a developer tool
 * whose dependency tree is nobody's threat model. This is not that. This process holds the vault
 * root — `cli/src/state.ts` says so in its header — and every package in its tree is a package
 * that can read the file. Measured on this machine: `packages/tui/node_modules` in the Devtool
 * is 40 entries; the whole platform client is 2 (`@scure`, `@noble`). Forty more for a
 * rectangle-drawer is not a trade this client should make, so the rectangles are here.
 *
 * What that costs is about two hundred lines of ANSI and no layout engine. What it buys is that
 * `packages/tui` adds nothing to `npm ls` at all.
 *
 * EVERYTHING HERE IS A PURE FUNCTION FROM VALUES TO STRINGS. Nothing writes to a terminal;
 * `main.ts` does that, once per frame. That is what lets `adversary/test/tui-conversation.test.ts` drive the entire
 * interface with no TTY — the same split as `commands.ts` and `cli.ts`, for the same reason.
 */

/** SGR codes. Only the ones actually used; an unused colour is a colour nobody checked. */
const CODES = {
  reset: 0, bold: 1, dim: 2, inverse: 7,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90,
} as const;

export type Tone = keyof typeof CODES;

export const paint = (text: string, ...tones: Tone[]): string =>
  tones.length === 0 ? text
    : `\x1b[${tones.map((t) => CODES[t]).join(";")}m${text}\x1b[0m`;

/**
 * The visible width of a string.
 *
 * ANSI escapes occupy no columns, so every measurement has to strip them first. Widths are
 * counted in code points and this is deliberately NOT a full grapheme/east-asian-width
 * implementation: getting that right needs a table, a table is a dependency, and a message
 * containing an emoji will render one column narrow rather than wrongly. The failure is
 * cosmetic and local, which is the most a client should spend on it.
 */
export const width = (text: string): number =>
  [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;

/** Cut to `n` columns, keeping the escape sequences that are still in scope. */
export function truncate(text: string, n: number): string {
  if (width(text) <= n) return text;
  let out = "";
  let seen = 0;
  let i = 0;
  while (i < text.length && seen < n - 1) {
    const esc = /^\x1b\[[0-9;]*m/.exec(text.slice(i));
    if (esc) { out += esc[0]; i += esc[0].length; continue; }
    out += text[i]; i++; seen++;
  }
  return `${out}…\x1b[0m`;
}

export const padEnd = (text: string, n: number): string =>
  text + " ".repeat(Math.max(0, n - width(text)));

export const fit = (text: string, n: number): string => padEnd(truncate(text, n), n);

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

/**
 * A titled rectangle around a block of lines.
 *
 * Content is clipped to the box, never wrapped by the box: a caller that wants wrapping calls
 * `wrap` first, because only the caller knows whether the thing being cut is a message (wrap
 * it) or a blob id (do not).
 */
export function box(
  lines: readonly string[],
  opts: { readonly width: number; readonly height: number; readonly title?: string; readonly focus?: boolean },
): string[] {
  const inner = opts.width - 2;
  const edge = opts.focus ? (s: string) => paint(s, "cyan") : (s: string) => paint(s, "gray");
  const title = opts.title ? truncate(` ${opts.title} `, inner) : "";
  const bar = title + BOX.h.repeat(Math.max(0, inner - width(title)));
  const out = [edge(BOX.tl + bar + BOX.tr)];
  for (let i = 0; i < opts.height - 2; i++) {
    out.push(edge(BOX.v) + fit(lines[i] ?? "", inner) + edge(BOX.v));
  }
  out.push(edge(BOX.bl + BOX.h.repeat(inner) + BOX.br));
  return out;
}

/** Glue boxes side by side. They must already be the same height, and it throws if they are not. */
export function beside(...columns: readonly string[][]): string[] {
  const h = columns[0]?.length ?? 0;
  for (const c of columns) {
    if (c.length !== h) throw new Error(`beside got columns of ${h} and ${c.length} rows`);
  }
  return Array.from({ length: h }, (_, i) => columns.map((c) => c[i]).join(""));
}

/** Break text on spaces, hard-cutting any single word longer than the column. */
export function wrap(text: string, n: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (let word of paragraph.split(" ")) {
      // A word wider than the column cannot be broken on a space, and the alternative to
      // cutting it is a line that overflows the box and corrupts every row below it.
      while (width(word) > n) {
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      if (line && width(line) + 1 + width(word) > n) { out.push(line); line = ""; }
      line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * One frame, as one write.
 *
 * Redrawn whole rather than diffed. A diff is the obvious optimisation and it is wrong here:
 * the frame is at most a few kilobytes, terminals coalesce, and a diffing renderer that gets a
 * cell wrong leaves a stale character on screen that no later frame corrects — which in an
 * interface whose entire job is telling you what is disclosed is a bug with a nasty shape.
 *
 * `\x1b[H` homes the cursor instead of clearing, so the screen is overwritten in place and
 * there is no flash between frames.
 */
export const frame = (lines: readonly string[], rows: number): string =>
  `\x1b[H${lines.slice(0, rows).map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`;

export const ALT_SCREEN_ON = "\x1b[?1049h\x1b[?25l";
export const ALT_SCREEN_OFF = "\x1b[?25h\x1b[?1049l";
