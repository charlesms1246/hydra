/**
 * One table, three consumers: the input handler, the `Keys` page, and the nav.
 *
 * Two rules this table exists to enforce.
 *
 * **No modifier combos.** Every binding is a key you can press alone. The old
 * table needed Shift for `?` (help), `L` (log), `G` (last) and `N` (next action),
 * which is four of the most-used destinations behind a chord.
 *
 * **w/a/s/d are movement, everywhere, always.** `a`/`d` move along the bottom
 * nav; `w`/`s` move within the focused list. They are never destinations, which
 * is why the page letters are o/b/c/f/x/t/l/k — binding `w` to Wallets as well
 * would make one key mean two things depending on where you happened to be.
 *
 * Enter is shared and resolved by precedence, not by mode: while the nav cursor
 * sits somewhere other than the page you are on, Enter opens that page; the
 * moment it agrees with the page, Enter belongs to the page again.
 */

import { PAGES, pageIndex } from "./chrome.mjs";

/** Ink's key object, in the vocabulary the table is written in. */
function matches(spec, input, key) {
  switch (spec) {
    case "up": return key.upArrow;
    case "down": return key.downArrow;
    case "left": return key.leftArrow;
    case "right": return key.rightArrow;
    case "enter": return key.return;
    case "esc": return key.escape;
    case "tab": return key.tab && !key.shift;
    default: return input === spec;
  }
}

/**
 * Which binding scopes are live, most specific first. The order is the whole
 * precedence model — there is no other.
 */
export function scopesFor(s) {
  if (s.quitting) return ["quit"];
  if (s.confirm) return ["confirm"];
  // Above the pages: while the cursor is parked elsewhere, Enter is the nav's.
  const navFirst = s.navCursor !== pageIndex(s.page);
  const page = {
    disclosure: s.report ? ["disclosure", "list"] : ["empty"],
    wallets: ["wallets", "list"],
    tools: ["tools", "list"],
    run: ["run", "list"],
    build: ["build", "list"],
    log: ["log", "list"],
    about: ["about"],
    activity: ["activity", "list"],
    overview: ["overview"],
  }[s.page] ?? [];
  return navFirst ? ["nav", ...page, "global"] : [...page, "nav", "global"];
}

const jump = (id) => ({
  scope: "global",
  keys: [PAGES.find((p) => p.id === id).key],
  label: `go to ${PAGES.find((p) => p.id === id).label}`,
  run: (s, a) => a.goto(id),
});

export const BINDINGS = [
  // ---- the nav bar -------------------------------------------------------
  { scope: "nav", keys: ["a", "left"], label: "move the nav cursor left",
    run: (s, a) => a.navMove(-1) },
  { scope: "nav", keys: ["d", "right"], label: "move the nav cursor right",
    run: (s, a) => a.navMove(1) },
  { scope: "nav", keys: ["enter"], label: "open the page under the nav cursor",
    when: (s) => s.navCursor !== pageIndex(s.page), run: (s, a) => a.openCursor() },

  // ---- movement, in any list --------------------------------------------
  { scope: "list", keys: ["w", "up"], label: "move up", run: (s, a) => a.moveSel(-1) },
  { scope: "list", keys: ["s", "down"], label: "move down", run: (s, a) => a.moveSel(1) },
  { scope: "list", keys: ["/"], label: "filter this list", run: (s, a) => a.startFilter() },

  // ---- disclosure --------------------------------------------------------
  { scope: "disclosure", keys: ["w", "up"], label: "select the party above",
    run: (s, a) => a.cursor({ party: Math.max(0, s.cursor.party - 1), scroll: 0 }) },
  { scope: "disclosure", keys: ["s", "down"], label: "select the party below",
    run: (s, a) => a.cursor({ party: Math.min(s.partyCount - 1, s.cursor.party + 1), scroll: 0 }) },
  { scope: "disclosure", keys: ["tab"], label: "next field — amount, token, counterparty, timing, addresses",
    run: (s, a) => a.cursor({ field: (s.cursor.field + 1) % s.fieldCount, scroll: 0 }) },
  { scope: "disclosure", keys: ["e"], label: "cycle the drawer — why, notes, anonymity set",
    run: (s, a) => a.cycleDrawer(1) },
  { scope: "disclosure", keys: ["enter"], label: "expand the drawer over the matrix",
    run: (s, a) => a.cursor({ expanded: !s.cursor.expanded }) },
  { scope: "disclosure", keys: ["["], label: "previous run", run: (s, a) => a.selectRun(s.cursor.run + 1) },
  { scope: "disclosure", keys: ["]"], label: "next run", run: (s, a) => a.selectRun(s.cursor.run - 1) },

  // ---- empty disclosure --------------------------------------------------
  { scope: "empty", keys: ["e"], label: "load the bundled private-transfer example",
    run: (s, a) => a.loadExample() },

  // ---- wallets -----------------------------------------------------------
  { scope: "wallets", keys: ["m"], label: "mint devnet funds to the selected account",
    mutates: true, run: (s, a) => a.fundWallet() },
  { scope: "wallets", keys: ["n"], label: "track another ERC20 by address",
    run: (s, a) => a.askToken() },
  { scope: "wallets", keys: ["v"], label: "export addresses and balances to JSON",
    mutates: true, run: (s, a) => a.exportWallets() },
  { scope: "wallets", keys: ["+"], label: "restart the stack with one more devnet account",
    mutates: true, run: (s, a) => a.askMoreAccounts() },

  // ---- tools -------------------------------------------------------------
  { scope: "tools", keys: ["tab"], label: "move between the categories and the detail",
    run: (s, a) => a.toggleFocus() },
  { scope: "tools", keys: ["i"], label: "run this row's fix (shows the command first)",
    mutates: true, run: (s, a) => a.askFix() },

  // ---- build -------------------------------------------------------------
  { scope: "build", keys: ["tab"], label: "move between the operations and the output",
    run: (s, a) => a.toggleFocus() },
  { scope: "build", keys: ["enter"], label: "run the selected operation (shows the command first)",
    mutates: true, run: (s, a) => a.askOperation() },

  // ---- sectioned pages ---------------------------------------------------
  // One meaning of `tab` across every two-section page: move between the sections.
  // It is the same "next thing" it means on Disclosure and About.
  { scope: "activity", keys: ["tab"], label: "move between the query and the list",
    run: (s, a) => a.toggleFocus() },
  { scope: "activity", keys: ["enter"], label: "edit the selected field",
    when: (s) => s.focus === "form", run: (s, a) => a.editField() },
  { scope: "activity", keys: ["enter"], label: "open the selected transaction's receipt",
    when: (s) => s.focus === "list", run: (s, a) => a.descend() },

  // ---- run ---------------------------------------------------------------
  { scope: "run", keys: ["tab"], label: "move between the builder and the flow list",
    run: (s, a) => a.toggleFocus() },
  { scope: "run", keys: ["enter"], label: "edit the selected field",
    when: (s) => s.focus === "form", run: (s, a) => a.editField() },
  { scope: "run", keys: ["enter"], label: "preview what this flow discloses, then y runs it",
    when: (s) => s.focus === "list", mutates: true, run: (s, a) => a.askFlow() },
  { scope: "run", keys: ["i"], label: "save the built flow", mutates: true,
    run: (s, a) => a.saveFlow() },
  { scope: "run", keys: ["-"], label: "forget the selected saved flow", mutates: true,
    when: (s) => s.focus === "list", run: (s, a) => a.forgetFlow() },

  // ---- about -------------------------------------------------------------
  { scope: "about", keys: ["tab"], label: "next guide section", run: (s, a) => a.cycleSection(1) },

  // ---- confirm -----------------------------------------------------------
  { scope: "confirm", keys: ["y"], label: "yes, run it", run: (s, a) => a.confirmYes() },
  { scope: "confirm", keys: ["n", "esc"], label: "no, cancel", run: (s, a) => a.confirmNo() },

  // ---- quit --------------------------------------------------------------
  { scope: "quit", keys: ["b"], label: "quit and leave the stack running",
    run: (s, a) => a.quitLeaveRunning() },
  { scope: "quit", keys: ["s"], label: "stop the stack, then quit", run: (s, a) => a.quitAndStop() },
  { scope: "quit", keys: ["q"], label: "quit without stopping anything",
    run: (s, a) => a.quitLeaveRunning() },
  { scope: "quit", keys: ["esc", "n"], label: "stay", run: (s, a) => a.cancelQuit() },

  // ---- destinations ------------------------------------------------------
  ...PAGES.map((p) => jump(p.id)),

  // ---- global ------------------------------------------------------------
  { scope: "global", keys: ["u"], label: "start the stack", mutates: true,
    when: (s) => !s.up, run: (s, a) => a.bringUp() },
  // Deliberately NOT gated on s.up. The half-dead stack — devnet gone, the
  // indexer child from the same `hydra up` still alive with a recorded pid — is
  // exactly the state that needs cleaning up, and it is the state where s.up is
  // false.
  { scope: "global", keys: ["p"], label: "stop the stack", mutates: true,
    run: (s, a) => a.bringDown() },
  { scope: "global", keys: ["r"], label: "refresh this page's data now", run: (s, a) => a.refreshFocused() },
  { scope: "global", keys: ["esc"], label: "clear the filter, then collapse, then back to Overview",
    run: (s, a) => a.escape() },
  { scope: "global", keys: ["q"], label: "quit — asks what to do with a running stack",
    run: (s, a) => a.askQuit() },
];

/** The whole body of useInput. */
export function dispatch(s, input, key, api) {
  // A prompt is a one-line text field. Like the filter below it is not a binding
  // scope, because while it is open every printable key is data rather than a
  // command — `q` types a q, it does not quit.
  if (s.prompt) {
    if (key.escape) return api.closePrompt();
    if (key.return) return api.submitPrompt();
    if (key.backspace || key.delete) return api.setPrompt(s.prompt.value.slice(0, -1));
    if (input && !key.ctrl && !key.meta) return api.setPrompt(s.prompt.value + input);
    return undefined;
  }
  // `/` opens a one-line text mode. It is not a binding scope because while it is
  // open every printable key is data, not a command.
  if (s.filter?.typing) {
    if (key.escape) return api.setFilter(null);
    if (key.return) return api.setFilter({ text: s.filter.text, typing: false });
    if (key.backspace || key.delete) return api.setFilter({ text: s.filter.text.slice(0, -1), typing: true });
    if (input && !key.ctrl && !key.meta) return api.setFilter({ text: s.filter.text + input, typing: true });
    return undefined;
  }
  for (const scope of scopesFor(s)) {
    for (const b of BINDINGS) {
      if (b.scope !== scope) continue;
      if (!b.keys.some((k) => matches(k, input, key))) continue;
      if (b.when && !b.when(s)) continue;
      if (b.mutates && s.busy) return api.note("working — l watches the log, q quits", "warn");
      return b.run(s, api);
    }
  }
  return undefined;
}

const SCOPE_TITLE = {
  nav: "the nav bar", list: "moving in a list", disclosure: "disclosure",
  empty: "disclosure (nothing loaded)", wallets: "wallets", tools: "tools",
  run: "run", confirm: "confirm", quit: "quitting", global: "anywhere",
  about: "about", log: "log", overview: "overview", activity: "activity", build: "build",
};

/** The `Keys` page, grouped by scope, in table order. */
export function helpGroups() {
  const groups = [];
  for (const b of BINDINGS) {
    let g = groups.find((x) => x.scope === b.scope);
    if (!g) groups.push((g = { scope: b.scope, title: SCOPE_TITLE[b.scope] ?? b.scope, rows: [] }));
    g.rows.push({ keys: b.keys.join(" / "), label: b.label });
  }
  return groups;
}

/**
 * No (scope, key) pair may be claimed twice UNCONDITIONALLY. Asserted by the tests.
 *
 * Two bindings may share a key when their `when:` predicates separate them — that is
 * how `enter` means "edit this field" in a form section and "open this row" in a list
 * section without a second scope. `dispatch` takes the first whose `when` passes, so
 * the only real collision is two bindings that are both always live.
 */
export function duplicateBindings() {
  const seen = new Map();
  const dupes = [];
  for (const b of BINDINGS) {
    for (const k of b.keys) {
      const id = `${b.scope}:${k}`;
      const prev = seen.get(id);
      if (prev && !prev.when && !b.when) dupes.push(id);
      if (!prev || !b.when) seen.set(id, b);
    }
  }
  return dupes;
}

/**
 * Keys claimed more than once in a scope where at least one binding is conditional.
 *
 * Not a fault — it is the intended mechanism — but a caller that wants to show the
 * keymap needs to know which rows are alternatives rather than separate keys.
 */
export function conditionalPairs() {
  const byId = new Map();
  for (const b of BINDINGS) {
    for (const k of b.keys) {
      const id = `${b.scope}:${k}`;
      byId.set(id, (byId.get(id) ?? 0) + 1);
    }
  }
  return [...byId.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

/** Every binding must be pressable without a modifier. Asserted by the test suite. */
export function comboBindings() {
  const NAMED = new Set(["up", "down", "left", "right", "enter", "esc", "tab"]);
  const out = [];
  for (const b of BINDINGS) {
    for (const k of b.keys) {
      if (NAMED.has(k)) continue;
      // A single character that is not its own lowercase needs Shift to type.
      if (k.length !== 1 || k !== k.toLowerCase()) out.push(`${b.scope}:${k}`);
    }
  }
  return out;
}
