/**
 * The furniture every page shares: the page table, the bottom nav, the top status
 * bar, and the quit prompt.
 *
 * PAGES is the single source for all three of: what the nav draws, what key jumps
 * where, and what `keys` documents. The old footer was a generated string of
 * whatever bindings happened to be live, which is why it read as
 * "s w a t rig · L log · i fix · jk row · g G ends" — accurate, and unreadable to
 * anyone who did not already know the app.
 *
 * Page letters deliberately avoid w/a/s/d. Those four are movement everywhere in
 * this UI, so binding them to destinations as well would make the same key mean
 * two things depending on where you were.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C, glyph, tone } from "./theme.mjs";

export const PAGES = [
  { id: "overview", key: "o", label: "Overview", short: "Ovw" },
  { id: "wallets", key: "b", label: "Wallets", short: "Wal" },
  { id: "activity", key: "c", label: "Activity", short: "Act" },
  { id: "disclosure", key: "f", label: "Disclosure", short: "Dis" },
  { id: "run", key: "x", label: "Run", short: "Run" },
  { id: "tools", key: "t", label: "Tools", short: "Tls" },
  { id: "build", key: "j", label: "Build", short: "Bld" },
  { id: "log", key: "l", label: "Log", short: "Log" },
  { id: "about", key: "g", label: "About", short: "Abt" },
];

export const pageIndex = (id) => Math.max(0, PAGES.findIndex((p) => p.id === id));

/**
 * The bottom navigation.
 *
 * Three states, and they have to stay distinguishable: the page you are ON (solid
 * background), the one the cursor is OVER (accent, bracketed), and the rest
 * (outlined). At narrow widths the labels drop to three letters before anything
 * is dropped entirely — losing a destination is worse than abbreviating it.
 */
export const NavBar = ({ width, active, cursor }) => {
  // Three tiers, and the last one still shows every destination. Overflowing the
  // row is not an option: Ink squeezes it and the separators disappear, which is
  // how a nav bar becomes an unreadable run of words.
  const cost = (f) => PAGES.reduce((n, p) => n + f(p).length + 3, 0) - 1;
  const label = cost((p) => `${p.label} (${p.key})`) <= width
    ? (p) => `${p.label} (${p.key})`
    : cost((p) => `${p.short} (${p.key})`) <= width
      ? (p) => `${p.short} (${p.key})`
      : (p) => p.key;
  const cells = PAGES.map((p, i) => {
    const text = ` ${label(p)} `;
    const isActive = p.id === active;
    const isCursor = i === cursor;
    if (isActive) {
      return html`<${Text} key=${p.id} backgroundColor=${C.accent} color="black" bold>${text}<//>`;
    }
    if (isCursor) {
      return html`<${Text} key=${p.id} color=${C.accent}>${"[" + text.slice(1, -1) + "]"}<//>`;
    }
    return html`<${Text} key=${p.id} color=${C.muted}>${text}<//>`;
  });
  const sep = html`<${Text} color=${C.border}>${"│"}<//>`;
  return html`
    <${Box} width=${width}>
      ${cells.flatMap((c, i) => (i ? [html`<${Box} key=${"s" + i}>${sep}<//>`, c] : [c]))}
    <//>`;
};

/**
 * The top status bar — every page but the overview, which shows the same facts
 * in full and would otherwise say everything twice.
 *
 * Liveness only. No disclosure vocabulary appears here: a status bar is glanced
 * at, and a glanceable privacy claim is exactly the kind this project refuses to
 * make (facts.mjs:25-33).
 */
export const StatusBar = ({ width, svc, note }) => {
  const dn = svc?.devnet;
  const ix = svc?.indexer;
  const bits = [
    { g: glyph(dn?.up), t: tone(dn?.up), text: `devnet ${dn?.up ? `block ${dn.blockNumber ?? "?"}` : "down"}` },
    { g: glyph(ix?.up && ix?.healthy, ix?.up), t: tone(ix?.up && ix?.healthy, ix?.up),
      text: `indexer ${ix?.up ? (ix.healthy ? "ok" : `lag ${ix.lagSecs ?? "?"}s`) : "down"}` },
    { g: "◐", t: C.warn, text: `prover ${svc?.prover?.mode ?? "?"}` },
    { g: glyph(svc?.agents?.mcp?.present), t: tone(svc?.agents?.mcp?.present),
      text: `mcp ${svc?.agents?.mcp?.present ? "present" : "missing"}` },
  ];
  const pool = svc?.stack?.poolAddress;
  const right = pool ? `pool ${pool.slice(0, 8)}…${pool.slice(-4)}` : "no stack";
  const leftLen = bits.reduce((n, b) => n + b.text.length + 3, 0);
  return html`
    <${Box} width=${width} justifyContent="space-between">
      <${Box}>
        ${bits.flatMap((b, i) => [
          i ? html`<${Text} key=${"d" + i} color=${C.border}>${" · "}<//>` : null,
          html`<${Text} key=${"b" + i} color=${b.t}>${b.g + " "}<//>`,
          html`<${Text} key=${"t" + i} color=${C.muted}>${b.text}<//>`,
        ].filter(Boolean))}
      <//>
      <${Text} color=${C.muted}>
        ${leftLen + right.length + 2 <= width ? right : ""}${note ? "" : ""}
      <//>
    <//>`;
};

/**
 * The quit prompt.
 *
 * A stack this TUI started is a devnet, a discovery service and a control API. On
 * quit that is a real choice, not a confirmation: leaving them up is the right
 * answer when you are about to run `hydra status` or a test, and the wrong one
 * when you are done for the day. Neither is safe to assume, so it asks, and it
 * says what is still running.
 */
export const QuitPrompt = ({ width, running, managed }) => {
  // Built as an array with explicit keys rather than a conditional fragment: htm
  // returns sibling elements as a bare array, and Ink's reconciler warns on every
  // frame without them — which on a 25fps screen is a wall of stderr.
  const rows = [];
  if (running) {
    rows.push(["r0", C.muted,
      `    devnet, the discovery service and the control API are running${
        managed ? " — this session started them" : " — started elsewhere"}`]);
    rows.push(["r1", null, "    b", "  quit, leave them running in the background", C.ok]);
    rows.push(["r2", null, "    s", "  stop the stack, then quit", C.bad]);
  } else {
    rows.push(["r0", C.muted, "    nothing is running"]);
  }
  rows.push(["r3", null, "    q", running ? "  quit without deciding (leaves them running)" : "  quit", C.accent]);
  rows.push(["r4", null, "  esc", "  stay", C.muted]);

  return html`
    <${Box} flexDirection="column" width=${width}>
      <${Text} color=${C.warn} bold>${"  quit hydra?"}<//>
      ${rows.map(([key, plain, a, b, keyColour]) =>
        plain !== null && plain !== undefined
          ? html`<${Text} key=${key} color=${plain} wrap="truncate">${a}<//>`
          : html`
            <${Text} key=${key} wrap="truncate">
              <${Text} color=${keyColour} bold>${a}<//>
              <${Text} color=${C.muted}>${b}<//>
            <//>`)}
    <//>`;
};
