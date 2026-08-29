/**
 * One table, three consumers: the input handler, the footer, and `?`.
 *
 * The old useInput was a 47-line conditional and the footer was a hand-written
 * string, so j/k moved the selection on three tabs and were documented on none
 * (app.mjs:255-265). Here a binding cannot exist undocumented: adding a row to
 * BINDINGS is the only edit needed to add a key, and both the footer and the help
 * overlay are generated from it.
 *
 * The other correction is that dispatch does NOT start with `if (busy) return`.
 * That line (app.mjs:206) made the keyboard dead for the ~120 seconds `hydra up`
 * takes, including `q`. Here `busy` gates the MUTATING bindings only; navigation,
 * the log, help, esc and quit stay live, and a suppressed key says so.
 */

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
    case "shift-tab": return key.tab && key.shift;
    case "pgup": return key.pageUp;
    case "pgdn": return key.pageDown;
    default: return input === spec;
  }
}

/**
 * Which binding scopes are live, most specific first. The order is the whole
 * precedence model — there is no other.
 */
export function scopesFor(s) {
  if (s.confirm) return ["confirm"];
  if (s.overlay === "help") return ["help", "global"];
  if (s.overlay === "log") return ["log", "list", "global"];
  if (s.overlay === "run") return ["transact", "list", "global"];
  if (s.overlay === "rig:tools") return ["tools", "rig", "list", "global"];
  if (s.overlay === "rig:wallets") return ["wallets", "rig", "list", "global"];
  if (s.overlay?.startsWith("rig:")) return ["rig", "list", "global"];
  if (!s.report) return ["empty", "global"];
  return ["matrix", "drawer", "global"];
}

export const BINDINGS = [
  // ---- matrix ------------------------------------------------------------
  { scope: "matrix", keys: ["h", "left"], label: "move a field left", foot: "hjkl cell",
    run: (s, a) => a.cursor({ field: Math.max(0, s.cursor.field - 1), scroll: 0 }) },
  { scope: "matrix", keys: ["l", "right"], label: "move a field right",
    run: (s, a) => a.cursor({ field: Math.min(s.fieldCount - 1, s.cursor.field + 1), scroll: 0 }) },
  { scope: "matrix", keys: ["k", "up"], label: "move a party up",
    run: (s, a) => a.cursor({ party: Math.max(0, s.cursor.party - 1), scroll: 0 }) },
  { scope: "matrix", keys: ["j", "down"], label: "move a party down",
    run: (s, a) => a.cursor({ party: Math.min(s.partyCount - 1, s.cursor.party + 1), scroll: 0 }) },
  { scope: "matrix", keys: ["["], label: "previous run in the ledger", foot: "[ ] runs",
    run: (s, a) => a.selectRun(s.cursor.run + 1) },
  { scope: "matrix", keys: ["]"], label: "next run in the ledger",
    run: (s, a) => a.selectRun(s.cursor.run - 1) },
  { scope: "matrix", keys: ["n"], label: "previous action within this run",
    when: (s) => s.actionCount > 1,
    run: (s, a) => a.cursor({ action: Math.max(0, s.cursor.action - 1), scroll: 0 }) },
  { scope: "matrix", keys: ["N"], label: "next action within this run",
    when: (s) => s.actionCount > 1,
    run: (s, a) => a.cursor({ action: Math.min(s.actionCount - 1, s.cursor.action + 1), scroll: 0 }) },

  // ---- drawer ------------------------------------------------------------
  { scope: "drawer", keys: ["enter"], label: "expand the drawer over the matrix", foot: "enter expand",
    run: (s, a) => a.cursor({ expanded: !s.cursor.expanded }) },
  { scope: "drawer", keys: ["tab"], label: "cycle why → notes → anonymity set", foot: "tab drawer",
    run: (s, a) => a.cycleDrawer(1) },
  { scope: "drawer", keys: ["shift-tab"], label: "cycle the drawer backwards",
    run: (s, a) => a.cycleDrawer(-1) },
  { scope: "drawer", keys: ["pgdn"], label: "scroll the drawer down",
    run: (s, a) => a.cursor({ scroll: s.cursor.scroll + 3 }) },
  { scope: "drawer", keys: ["pgup"], label: "scroll the drawer up",
    run: (s, a) => a.cursor({ scroll: Math.max(0, s.cursor.scroll - 3) }) },

  // ---- empty state -------------------------------------------------------
  { scope: "empty", keys: ["e"], label: "load packages/leak/examples/private-transfer.json",
    foot: "e example", footRank: 1, run: (s, a) => a.loadExample() },

  // ---- the ? overlay -----------------------------------------------------
  // The keymap outgrew the screen: 45 bindings do not fit in the 22 rows a
  // 100x30 terminal leaves, let alone the 16 an 80x24 one does. Without these
  // the `help` scope had no bindings at all, so more than half of `?` was
  // unreachable from inside the TUI while README claimed `?` lists every key.
  { scope: "help", keys: ["j", "down"], label: "scroll the key list down", foot: "jk scroll",
    run: (s, a) => a.moveSel(1) },
  { scope: "help", keys: ["k", "up"], label: "scroll the key list up", run: (s, a) => a.moveSel(-1) },
  { scope: "help", keys: ["g"], label: "first binding", run: (s, a) => a.jumpSel("first") },
  { scope: "help", keys: ["G"], label: "last binding", foot: "g G ends", run: (s, a) => a.jumpSel("last") },
  { scope: "help", keys: ["pgdn"], label: "a page of bindings down", foot: "pgup pgdn page",
    run: (s, a) => a.pageSel(1) },
  { scope: "help", keys: ["pgup"], label: "a page of bindings up", run: (s, a) => a.pageSel(-1) },

  // ---- windowed lists ----------------------------------------------------
  { scope: "list", keys: ["j", "down"], label: "move down", foot: "jk row",
    run: (s, a) => a.moveSel(1) },
  { scope: "list", keys: ["k", "up"], label: "move up", run: (s, a) => a.moveSel(-1) },
  { scope: "list", keys: ["g"], label: "first item", run: (s, a) => a.jumpSel("first") },
  { scope: "list", keys: ["G"], label: "last item", foot: "g G ends", run: (s, a) => a.jumpSel("last") },
  { scope: "list", keys: ["pgdn"], label: "page down", run: (s, a) => a.pageSel(1) },
  { scope: "list", keys: ["pgup"], label: "page up", run: (s, a) => a.pageSel(-1) },
  { scope: "list", keys: ["/"], label: "filter this list", foot: "/ filter",
    run: (s, a) => a.startFilter() },
  { scope: "list", keys: ["enter"], label: "open the selected row", foot: "enter open",
    run: (s, a) => a.descend() },

  // ---- rig panes ---------------------------------------------------------
  { scope: "wallets", keys: ["f"], label: "fund the selected account", foot: "f fund", mutates: true,
    run: (s, a) => a.fundWallet() },
  { scope: "tools", keys: ["i"], label: "run the fix for this row (shows cmd and cwd first)",
    foot: "i fix", mutates: true, run: (s, a) => a.askFix() },

  // ---- run menu ----------------------------------------------------------
  { scope: "transact", keys: ["enter"], label: "preview this flow's disclosure, then y runs it",
    foot: "enter preview", mutates: true, run: (s, a) => a.askFlow() },

  // ---- confirm -----------------------------------------------------------
  { scope: "confirm", keys: ["y"], label: "run it", foot: "y run", run: (s, a) => a.confirmYes() },
  { scope: "confirm", keys: ["n", "esc"], label: "cancel", foot: "n cancel",
    run: (s, a) => a.confirmNo() },

  // ---- global ------------------------------------------------------------
  { scope: "global", keys: ["x"], label: "run menu — shield, register, transfer, re-discover notes",
    foot: "x run", footRank: 1, run: (s, a) => a.toggleOverlay("run") },
  { scope: "global", keys: ["s"], label: "rig · services", foot: "s w a t rig", footRank: 1,
    run: (s, a) => a.toggleOverlay("rig:services") },
  { scope: "global", keys: ["w"], label: "rig · wallets", run: (s, a) => a.toggleOverlay("rig:wallets") },
  { scope: "global", keys: ["a"], label: "rig · activity", run: (s, a) => a.toggleOverlay("rig:activity") },
  { scope: "global", keys: ["t"], label: "rig · tools", run: (s, a) => a.toggleOverlay("rig:tools") },
  { scope: "global", keys: ["L"], label: "the log — live while busy", foot: "L log", footRank: 1,
    run: (s, a) => a.toggleOverlay("log") },
  { scope: "global", keys: ["u"], label: "start the stack", foot: "u up", mutates: true,
    when: (s) => !s.up, run: (s, a) => a.bringUp() },
  // Deliberately NOT gated on s.up. The half-dead stack — devnet gone, the
  // indexer child from the same `hydra up` still alive with a recorded pid — is
  // exactly the state that needs cleaning up, and it is the state where s.up is
  // false. bringDown()'s else-branch signals both pids from recorded state.
  { scope: "global", keys: ["d"], label: "stop the stack — works from recorded pids with devnet already gone",
    foot: "d down", mutates: true, run: (s, a) => a.bringDown() },
  { scope: "global", keys: ["r"], label: "refresh the focused source now", foot: "r refresh",
    run: (s, a) => a.refreshFocused() },
  { scope: "global", keys: ["esc"],
    label: "clear filter → collapse drawer → up one level → close overlay, in that order",
    run: (s, a) => a.escape() },
  { scope: "global", keys: ["?"], label: "this list", foot: "? keys", tail: true,
    run: (s, a) => a.toggleOverlay("help") },
  // Live while busy on purpose. Ink's own Ctrl-C handler
  // (ink/build/components/App.js:143) already exits mid-fix, so swallowing q was
  // strictly worse than an honest prompt.
  { scope: "global", keys: ["q"], label: "quit (asks first if something is running)", foot: "q",
    tail: true, run: (s, a) => (s.busy ? a.askQuit() : a.exit()) },
];

/** The whole body of useInput. */
export function dispatch(s, input, key, api) {
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
      if (b.mutates && s.busy) return api.note("working — L watches the log, q quits", "warn");
      return b.run(s, api);
    }
  }
  return undefined;
}

/** The footer. It cannot omit a bound key, which is how j/k went undocumented. */
export function footerFor(s, width) {
  const live = scopesFor(s);
  const parts = [];
  const tail = [];
  for (const scope of live) {
    for (const b of BINDINGS) {
      if (b.scope !== scope || !b.foot) continue;
      if (b.when && !b.when(s)) continue;
      (b.tail ? tail : parts).push({ foot: b.foot, rank: b.footRank ?? 2 });
    }
  }
  // `? keys` and `q` are reserved out of the budget first: a footer that runs out
  // of room and drops the way to see the other keys, or the way out, is worse
  // than one that drops a key you can rediscover from `?`.
  const suffix = tail.map((p) => p.foot).join(" · ");
  const budget = width - 2 - (suffix ? suffix.length + 3 : 0);
  // Rank 1 is the set of destinations you cannot find by guessing — the rig
  // letters, the run menu, the log. They are placed before the navigation keys
  // for the region you are already looking at, so a narrow terminal keeps them.
  let out = "";
  for (const p of [...parts].sort((a, b) => a.rank - b.rank)) {
    const next = out ? `${out} · ${p.foot}` : p.foot;
    if (next.length > budget) break;
    out = next;
  }
  return suffix ? (out ? `${out} · ${suffix}` : suffix) : out;
}

const SCOPE_TITLE = {
  global: "global", matrix: "matrix", drawer: "drawer", empty: "empty",
  list: "list", rig: "rig", wallets: "wallets", tools: "tools",
  transact: "transact", confirm: "confirm", log: "log", help: "help",
};

/** The `?` overlay, grouped by scope, in table order. */
export function helpGroups() {
  const groups = [];
  for (const b of BINDINGS) {
    let g = groups.find((x) => x.scope === b.scope);
    if (!g) groups.push((g = { scope: b.scope, title: SCOPE_TITLE[b.scope] ?? b.scope, rows: [] }));
    g.rows.push({ keys: b.keys.join(" "), label: b.label });
  }
  return groups;
}

/** No (scope, key) pair may be claimed twice. Asserted by the test suite. */
export function duplicateBindings() {
  const seen = new Map();
  const dupes = [];
  for (const b of BINDINGS) {
    for (const k of b.keys) {
      const id = `${b.scope}:${k}`;
      if (seen.has(id)) dupes.push(id);
      seen.set(id, b);
    }
  }
  return dupes;
}
