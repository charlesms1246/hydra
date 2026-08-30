/**
 * Tools: what is installed, what is running, and what it has done.
 *
 * One cursor drives both sections — the category selected at the top decides what
 * the bottom lists — so the page costs no new keys beyond the shared `tab`.
 *
 * Two things on this page are honest absences rather than missing features.
 * **Uptime is stack-scoped, not per-process**: `state.json` records one `startedAt`
 * for the whole `hydra up`, so it is paired with `pidAlive` rather than presented
 * as a per-service figure. And **there is no update check**: nothing here reaches
 * the network, so what looks like one everywhere else is, here, pin drift against
 * `pins.mjs` — labelled as that and not as "up to date".
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C, glyph, tone } from "./theme.mjs";
import { Block, pad, trunc } from "./layout.mjs";
import { windowRows } from "./forms.mjs";

export const TOOL_CATEGORIES = [
  { id: "pins", label: "toolchain", hint: "pinned versions and build artifacts" },
  { id: "services", label: "services", hint: "what this stack is running, and for how long" },
  { id: "agents", label: "mcp & skills", hint: "the agent surface" },
  { id: "history", label: "history", hint: "what has run on this machine, newest first" },
];

/**
 * The doctor rows a filter leaves on screen.
 *
 * Exported and used by BOTH the renderer and `askFix`, because they must agree: row
 * 0 of a filtered list is not row 0 of the real one, and reading the unfiltered list
 * to decide what `i` fixes offers to run a command for a row you cannot see.
 */
export function visibleRows(rows, filter) {
  const t = String(filter?.text ?? "").trim().toLowerCase();
  if (!t) return rows ?? [];
  return (rows ?? []).filter((r) => `${r.name} ${r.want} ${r.got}`.toLowerCase().includes(t));
}

const ago = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const uptime = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};

/** The rows for one category. Pure, so the row count can be budgeted before render. */
export function rowsFor(cat, { doctor, svc, hist, width, filter }) {
  const w = width - 2;
  const line = (a, b, colour) => html`
    <${Text} wrap="truncate">
      <${Text} color=${C.muted}>${pad("  " + a, Math.min(30, Math.floor(w * 0.34)))}<//>
      <${Text} color=${colour}>${trunc(b, Math.max(0, w - Math.min(30, Math.floor(w * 0.34))))}<//>
    <//>`;

  if (cat === "pins") {
    const rows = visibleRows(doctor?.rows, filter);
    if (!rows.length) return [line("scanning…", "r rescans")];
    return rows.map((r) => html`
      <${Text} wrap="truncate">
        <${Text} color=${tone(r.status.trim() === "ok", r.status.trim() === "WARN")}>
          ${"  " + glyph(r.status.trim() === "ok", r.status.trim() === "WARN") + " "}<//>
        <${Text}>${pad(r.name, 28)}<//>
        <${Text} color=${C.muted}>${pad("want " + r.want, 22)}<//>
        <${Text}>${trunc(String(r.got), Math.max(0, w - 54))}<//>
        <${Text} color=${C.ok}>${r.cmd ? "  i fixes" : ""}<//>
      <//>`);
  }

  if (cat === "services") {
    const dn = svc?.devnet;
    const ix = svc?.indexer;
    return [
      line("stack started", svc?.stack?.startedAt ? `${uptime(svc.stack.startedAt)}  (${svc.stack.startedAt.slice(11, 19)})` : "no stack"),
      line("devnet", dn?.up ? `up · block ${dn.blockNumber ?? "?"} · pid ${dn.pid ?? "?"} ${dn.pidAlive ? "alive" : "gone"}` : dn?.reason ?? "down",
        dn?.up ? undefined : C.muted),
      line("indexer", ix?.up
        ? `${ix.healthy ? "ok" : "lagging"} · lag ${ix.lagSecs ?? "?"}s · pid ${ix.pid ?? "?"} ${ix.pidAlive ? "alive" : "gone"}`
        : ix?.reason ?? "down", ix?.up && !ix?.healthy ? C.warn : undefined),
      line("prover", `${svc?.prover?.mode ?? "?"} — ${svc?.prover?.note ?? ""}`),
      line("pool", svc?.stack?.poolAddress ?? "—"),
      // Stated because it is a real limit of the data, not an oversight.
      line("note", "uptime is for the whole stack — state.json records one startedAt", C.muted),
    ];
  }

  if (cat === "agents") {
    const sk = svc?.agents?.skills;
    const mcp = svc?.agents?.mcp;
    const own = sk?.own ?? { available: [], installed: [] };
    const tp = sk?.thirdParty ?? { pinned: [], installed: [] };
    return [
      line("mcp server", mcp?.present ? mcp.path : "missing", mcp?.present ? undefined : C.warn),
      line("hydra skills", `${own.installed.length}/${own.available.length} installed — node packages/skills/install.mjs`),
      line("pinned bundle", `${tp.installed.length}/${tp.pinned.length} installed — npx skills add welttowelt/strk20-skills`),
      line("install dir", sk?.dir ?? "—"),
      ...own.available.map((n) => html`
        <${Text} wrap="truncate">
          <${Text} color=${tone(own.installed.includes(n))}>${"    " + glyph(own.installed.includes(n)) + " "}<//>
          <${Text}>${pad(n, 40)}<//>
          <${Text} color=${C.muted}>${"hydra"}<//>
        <//>`),
      ...tp.pinned.map((n) => html`
        <${Text} wrap="truncate">
          <${Text} color=${tone(tp.installed.includes(n))}>${"    " + glyph(tp.installed.includes(n)) + " "}<//>
          <${Text}>${pad(n, 40)}<//>
          <${Text} color=${C.muted}>${"third-party, pinned in skills-lock.json"}<//>
        <//>`),
    ];
  }

  const entries = hist?.entries ?? [];
  if (!entries.length) {
    return [
      line("nothing recorded yet", "builds, fixes, flows and stack starts are appended as they happen", C.muted),
      line("file", hist?.file ?? "—", C.muted),
    ];
  }
  return entries.map((e) => html`
    <${Text} wrap="truncate">
      <${Text} color=${e.ok ? C.ok : C.bad}>${"  " + (e.ok ? "ok  " : "fail")}<//>
      <${Text} color=${C.muted}>${pad("  " + ago(e.at), 12)}<//>
      <${Text} color=${C.muted}>${pad(e.kind, 7)}<//>
      <${Text}>${pad(e.name, Math.max(10, w - 50))}<//>
      <${Text} color=${C.muted}>${e.ms === null ? "" : `${e.ms}ms`}<//>
    <//>`);
};

export const ToolsPage = ({ width, height, doctor, svc, hist, focus, selected, catSel, filter }) => {
  const topH = TOOL_CATEGORIES.length + 2;
  const botH = Math.max(5, height - topH);
  const cat = TOOL_CATEGORIES[catSel] ?? TOOL_CATEGORIES[0];

  const counts = {
    pins: visibleRows(doctor?.rows, filter).filter((r) => r.status.trim() !== "ok").length,
    services: svc?.devnet?.up ? 0 : 1,
    agents: (svc?.agents?.skills?.expected?.length ?? 0) - (svc?.agents?.skills?.installed?.length ?? 0),
    history: (hist?.entries ?? []).filter((e) => !e.ok).length,
  };

  const topRows = TOOL_CATEGORIES.map((c, i) => {
    const on = focus === "top" && i === catSel;
    const bad = counts[c.id] > 0;
    const badge = c.id === "history"
      ? bad ? `${counts[c.id]} failed` : "all clear"
      : bad ? `${counts[c.id]} need attention` : "all clear";
    return html`
      <${Text} key=${c.id} wrap="truncate">
        <${Text} color=${on ? C.accent : undefined}>${on ? "▸" : " "}<//>
        <${Text} color=${i === catSel ? C.accent : C.muted} bold=${i === catSel}>${pad(c.label, 16)}<//>
        <${Text} color=${bad ? C.warn : C.ok}>${pad(badge, 20)}<//>
        <${Text} color=${C.muted}>${trunc(c.hint, Math.max(0, width - 42))}<//>
      <//>`;
  });

  const rows = rowsFor(cat.id, { doctor, svc, hist, width, filter });
  const inner = botH - 2;
  const win = windowRows(rows, selected, inner);

  return html`
    <${Box} flexDirection="column" width=${width} height=${height} overflow="hidden">
      <${Block} w=${width} h=${topH} title="tools" focused=${focus === "top"}
        right="w s picks a category · tab moves down" rows=${topRows} />
      <${Block} w=${width} h=${botH} title=${cat.label} focused=${focus === "list"}
        right=${win.note || (cat.id === "pins" ? "i runs the selected fix" : "")}
        rows=${win.rows} />
    <//>`;
};
