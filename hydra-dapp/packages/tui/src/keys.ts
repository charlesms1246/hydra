/**
 * Raw bytes from a terminal, as names.
 *
 * `readline.emitKeypressEvents` would do this and it is not used, for one reason: it needs a
 * real stream and a real TTY, so every test of key handling would need a pty. Decoding here
 * means `test/render.test.ts` can feed the app a string and assert on the frame, which is the
 * only way the interface itself gets tested rather than the functions behind it.
 *
 * The decoder is deliberately partial. It knows the sequences this interface binds and returns
 * the raw text for everything else, so an unbound key types itself into a field instead of
 * doing something surprising — the failure mode of a partial table is a character, not an
 * action.
 */

export type Key =
  | { readonly t: "char"; readonly value: string }
  | { readonly t: "enter" }
  | { readonly t: "backspace" }
  | { readonly t: "tab" }
  | { readonly t: "shift-tab" }
  | { readonly t: "escape" }
  | { readonly t: "up" | "down" | "left" | "right" }
  | { readonly t: "page-up" | "page-down" }
  | { readonly t: "ctrl"; readonly value: string };

const SEQUENCES: Record<string, Key> = {
  "\x1b[A": { t: "up" },
  "\x1b[B": { t: "down" },
  "\x1b[C": { t: "right" },
  "\x1b[D": { t: "left" },
  "\x1b[5~": { t: "page-up" },
  "\x1b[6~": { t: "page-down" },
  "\x1b[Z": { t: "shift-tab" },
  "\r": { t: "enter" },
  "\n": { t: "enter" },
  "\x7f": { t: "backspace" },
  "\b": { t: "backspace" },
  "\t": { t: "tab" },
  "\x1b": { t: "escape" },
};

/**
 * Split one read into keys.
 *
 * A terminal delivers a paste as one chunk, so this returns a list rather than a key: handling
 * only the first byte of a chunk would silently drop most of a pasted bundle path, and a path
 * that is quietly truncated is worse than one that does not paste at all.
 */
export function decode(chunk: string): Key[] {
  const out: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const head = chunk.slice(i, i + 4);
    const match = Object.keys(SEQUENCES)
      .filter((s) => head.startsWith(s))
      .sort((a, b) => b.length - a.length)[0];
    if (match) {
      // A bare escape is only the start of a sequence when a `[` or an `O` follows it — CSI and
      // SS3, which is every sequence a terminal sends for a key. Anything else after it is the
      // escape KEY followed by a keystroke, and consuming that keystroke is how "Esc then 3"
      // stopped leaving a field and switching pages.
      if (match === "\x1b" && /^[[O]/.test(chunk.slice(i + 1, i + 2))) {
        const rest = chunk.slice(i + 1);
        const end = rest.search(/[a-zA-Z~]/);
        // Unterminated in this chunk: drop it rather than emit a key nobody pressed.
        i += end < 0 ? chunk.length : end + 2;
        continue;
      }
      out.push(SEQUENCES[match]);
      i += match.length;
      continue;
    }
    const code = chunk.charCodeAt(i);
    if (code < 32) out.push({ t: "ctrl", value: String.fromCharCode(code + 96) });
    else out.push({ t: "char", value: chunk[i] });
    i++;
  }
  return out;
}
