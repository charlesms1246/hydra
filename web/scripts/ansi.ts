/**
 * ANSI to spans — shared by the build-time capture and the live render.
 *
 * ⛔ **Tone NAMES, not colours, and this is the whole reason the module exists.** The renderer
 * emits SGR codes; translating them to `red`/`gray`/`bold` lets the site's palette decide what each
 * one looks like. Handing raw ANSI to anything with a palette of its own — a terminal emulator, for
 * instance — replaces the site's greys and single accent with somebody's sixteen-colour default,
 * and a captured frame beside a live one would not match.
 *
 * **No Node imports.** A client component has to be able to import this, which is the point: one
 * mapper for both paths means there is no second mapping to keep in agreement, and no drift
 * condition to guard against.
 */

/** The nine tones `packages/tui/src/screen.ts` actually uses. An unmapped code renders unstyled. */
const TONE: Record<string, string> = {
  "1": "bold", "2": "dim", "7": "inverse",
  "31": "red", "32": "green", "33": "yellow", "34": "blue",
  "35": "magenta", "36": "cyan", "90": "gray",
};

export type Span = { t: string; c: string[] };

export function spans(line: string): Span[] {
  const out: Span[] = [];
  let tones: string[] = [];
  let i = 0;
  while (i < line.length) {
    const esc = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
    if (esc) {
      const codes = esc[1].split(";").filter(Boolean);
      tones = codes.length === 0 || codes.includes("0")
        ? []
        : codes.map((c) => TONE[c]).filter(Boolean);
      i += esc[0].length;
      continue;
    }
    const next = line.indexOf("\x1b", i);
    const end = next === -1 ? line.length : next;
    const text = line.slice(i, end);
    if (text) out.push({ t: text, c: tones });
    i = end;
  }
  return out;
}
