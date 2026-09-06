/**
 * The keys that only move the cursor — one implementation, two callers.
 *
 * `app.ts` calls this on a `Model`; the website's live demo calls it on a `View`. **That is the
 * whole point of the shape below.** An extraction only one caller uses is a copy with better
 * provenance: nothing forces it to stay true, and it drifts the first time somebody fixes a key
 * binding in the reducer and not here. So both call it, and the compiler holds them together.
 *
 * ## Why this file can exist at all
 *
 * `app.ts` reaches 40 files and 4 forbidden ones — `identity/src/domains.ts` and three
 * `vault-client` modules — so a browser cannot import the reducer. Measured across the reducer:
 * 49 pure return sites against 11 effectful ones, and every key a demo needs lives in a function
 * with **zero** effectful returns (`typed`, `command`, `move`, `go`, `cycle`). The effectful half
 * — `submit`, `action`, the flush ticker, answering a confirm — stays in `app.ts`, and none of it
 * could run in a browser anyway: every effect needs a chain, a vault or a filesystem.
 *
 * This module imports `model.ts` and `keys.ts`, which are 1 file and 0 forbidden each.
 *
 * ## `null` means "not a pure transition"
 *
 * One return value serves both callers: `app.ts` falls through to `submit`/`action`, and the demo
 * ignores the key. Neither has to know the other's list.
 */

import { FIELDS, PAGES } from "./model.ts";
import type { Page } from "./model.ts";
import type { Key } from "./keys.ts";

/**
 * The fields a key press can move, and nothing else.
 *
 * Both `Model` and `View` satisfy this structurally — see the assertion at the bottom of
 * `model.ts`, which fails at a named place with a reason if either drifts, rather than at
 * whichever call site the compiler happens to reach first.
 */
export type Nav = {
  readonly page: Page | "setup";
  readonly typing: boolean;
  readonly field: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly channel: number;
  readonly scroll: number;
  readonly help: boolean;
  readonly helpScroll: number;
};

const fieldsOf = (m: Nav) => FIELDS[m.page];

const go = <T extends Nav>(m: T, page: Page): T =>
  ({ ...m, page, field: 0, scroll: 0, typing: false });

function cycle<T extends Nav>(m: T, by: number): T {
  const i = PAGES.findIndex((p) => p.id === m.page);
  return go(m, PAGES[(i + by + PAGES.length) % PAGES.length].id);
}

/** j/k means "next channel" on the page with a channel list, and "scroll" everywhere else. */
function move<T extends Nav>(m: T, by: number, channels: number): T {
  if (m.page === "chats") {
    if (channels === 0) return m;
    return { ...m, channel: Math.min(channels - 1, Math.max(0, m.channel + by)), scroll: 0 };
  }
  return { ...m, scroll: Math.max(0, m.scroll + by) };
}

function typed<T extends Nav>(m: T, k: Key): T | null {
  const fields = fieldsOf(m);
  const current = fields[m.field];
  if (!current) return { ...m, typing: false };
  switch (k.t) {
    case "escape":
      return { ...m, typing: false };
    case "tab":
    case "down":
      return { ...m, field: (m.field + 1) % fields.length };
    case "shift-tab":
    case "up":
      return { ...m, field: (m.field + fields.length - 1) % fields.length };
    case "backspace":
      return { ...m, fields: { ...m.fields, [current.key]: m.fields[current.key].slice(0, -1) } };
    case "char":
      return { ...m, fields: { ...m.fields, [current.key]: m.fields[current.key] + k.value } };
    // `enter` submits, which is the page's primary action and always an effect.
    case "enter":
      return null;
    default:
      return m;
  }
}

function command<T extends Nav>(m: T, k: Key, channels: number): T | null {
  const fields = fieldsOf(m);
  if (k.t === "tab") return { ...m, field: fields.length ? (m.field + 1) % fields.length : 0 };
  if (k.t === "shift-tab") {
    return { ...m, field: fields.length ? (m.field + fields.length - 1) % fields.length : 0 };
  }
  if (k.t === "up" || (k.t === "char" && k.value === "k")) return move(m, -1, channels);
  if (k.t === "down" || (k.t === "char" && k.value === "j")) return move(m, 1, channels);
  if (k.t === "page-up") return move(m, -10, channels);
  if (k.t === "page-down") return move(m, 10, channels);
  if (k.t === "enter") return null;

  if (k.t === "char") {
    const digit = "123456".indexOf(k.value);
    if (digit >= 0 && m.page !== "setup") return go(m, PAGES[digit].id);
    if (k.value === "]" && m.page !== "setup") return cycle(m, 1);
    if (k.value === "[" && m.page !== "setup") return cycle(m, -1);
    if (k.value === "?") return { ...m, help: true, helpScroll: 0 };
    if (k.value === "i" && fields.length) return { ...m, typing: true };
    // `q` quits and everything else is a page action — neither is a cursor move.
    return null;
  }
  return m;
}

/**
 * One key, applied. `null` when the key is not a pure transition.
 *
 * ⚠ `channels` is **the number of selectable channels**, and it is the one thing here the type
 * system stopped holding. It used to be derived inside the reducer from `channelNames`; now each
 * caller computes it, and the compiler will check that both are numbers while checking nothing
 * about whether they mean the same thing. A count that included a channel the other side hides
 * would make `j`/`k` land somewhere different on the website than in the product, silently,
 * because both values are valid numbers.
 *
 * **Both callers must compute it the same way.** Today both do: `app.ts` `channelNames` is
 * `Object.keys(m.state?.channels ?? {}).sort()` and `model.ts` `channelNames` is
 * `Object.keys(v.client?.channels ?? {}).sort()` — the same set, the same order, neither
 * filtering. If either ever starts hiding a channel, this parameter should become the filtered
 * list rather than its length, so that one place decides what "selectable" means.
 */
export function navigate<T extends Nav>(m: T, k: Key, channels: number): T | null {
  /*
   * Help first, and it consumes ANY key. The page underneath is untouched, so the keystroke that
   * puts it away is the only thing help costs. `app.ts` checks `confirm` before calling this, so
   * opening help over a consent dialog cannot become a way to answer it.
   */
  if (m.help) {
    if (k.t === "up" || (k.t === "char" && k.value === "k")) {
      return { ...m, helpScroll: Math.max(0, m.helpScroll - 1) };
    }
    if (k.t === "down" || (k.t === "char" && k.value === "j")) {
      return { ...m, helpScroll: m.helpScroll + 1 };
    }
    return { ...m, help: false };
  }
  return m.typing ? typed(m, k) : command(m, k, channels);
}
