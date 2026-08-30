/**
 * Build: compile the contracts, run the Cairo tests, and see whether the chain is
 * running the code that is currently on disk.
 *
 * The durations shown are measured, not guessed, and they are on screen because the
 * first ~15 seconds of an `snforge` run emit nothing at all on stdout — that is the
 * test-target compile, which goes to stderr. Without an elapsed counter the page
 * looks hung for a quarter of a minute.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C, glyph, tone } from "./theme.mjs";
import { Block, pad, trunc } from "./layout.mjs";
import { windowRows } from "./forms.mjs";
import { OPERATIONS } from "../../core/src/toolchain.mjs";

const secs = (n) => (n >= 60 ? `~${Math.round(n / 60)}m` : `~${n}s`);

/** Operation rows, with whatever the last run said about each. */
function opRows({ width, results, artifacts, selected, focus }) {
  return OPERATIONS.map((op, i) => {
    const on = focus === "list" && i === selected;
    const r = results?.[op.id];
    const built = op.artifact ? artifacts?.[op.id] : undefined;
    const state = r
      ? r.ok ? C.ok : C.bad
      : built === false ? C.warn : C.muted;
    const status = r
      ? `${r.verdict?.text ?? (r.ok ? "ok" : "failed")} · ${Math.round(r.ms / 100) / 10}s`
      : built === false ? "not built" : built === true ? "built" : secs(op.seconds);
    return html`
      <${Text} key=${op.id} wrap="truncate">
        <${Text} color=${on ? C.accent : undefined}>${on ? "▸" : " "}<//>
        <${Text} color=${C.muted}>${pad(op.group, 7)}<//>
        <${Text} color=${on ? C.accent : undefined} bold=${on}>${pad(op.label, 28)}<//>
        <${Text} color=${state}>${pad(status, 26)}<//>
        <${Text} color=${C.muted}>${trunc(op.cmd, Math.max(0, width - 66))}<//>
      <//>`;
  });
}

/** The bottom frame has three states: idle, running, and a finished result. */
function bottomRows({ width, busy, result, lines, deploy }) {
  const w = width - 2;
  if (busy) {
    const el = Math.round((Date.now() - busy.since) / 1000);
    return [
      html`<${Text} key="b" color=${C.warn} wrap="truncate">
        ${`  ${busy.label} — ${el}s elapsed, expected ${secs(busy.seconds ?? 0)}`}<//>`,
      html`<${Text} key="n" color=${C.muted} wrap="truncate">
        ${"  snforge prints nothing for its first ~15s; that is the test-target compile"}<//>`,
      ...(lines ?? []).slice(-40).map((l, i) =>
        html`<${Text} key=${"l" + i} color=${C.muted} wrap="truncate">${"  " + l}<//>`),
    ];
  }

  if (result?.parsed) {
    const p = result.parsed;
    const head = html`<${Text} key="h" wrap="truncate">
      <${Text} color=${result.ok ? C.ok : C.bad} bold>${"  " + (result.verdict?.text ?? "")}<//>
      <${Text} color=${C.muted}>${`   in ${Math.round(result.ms / 100) / 10}s · exit ${result.code}`}<//>
    <//>`;
    const pkgs = p.packages.map((k, i) => html`
      <${Text} key=${"p" + i} wrap="truncate">
        <${Text} color=${C.muted}>${pad("  " + k.name, 34)}<//>
        <${Text}>${pad(`${k.passed} passed`, 14)}<//>
        <${Text} color=${k.failed ? C.bad : C.muted}>${pad(`${k.failed} failed`, 13)}<//>
        <${Text} color=${C.muted}>${`${k.ignored} ignored · ${k.filtered} filtered`}<//>
      <//>`);
    const fails = p.tests.filter((t) => t.status === "FAIL").map((t, i) => html`
      <${Text} key=${"f" + i} color=${C.bad} wrap="truncate">${"    " + trunc(t.name, w - 6)}<//>`);
    return [head, ...pkgs, ...(fails.length ? [html`<${Text} key="fh" color=${C.bad}>${"  failures"}<//>`] : []), ...fails];
  }

  if (result) {
    return [
      html`<${Text} key="h" wrap="truncate">
        <${Text} color=${result.ok ? C.ok : C.bad} bold>${"  " + (result.verdict?.text ?? "")}<//>
        <${Text} color=${C.muted}>${`   in ${Math.round(result.ms / 100) / 10}s`}<//>
      <//>`,
      ...(lines ?? []).slice(-30).map((l, i) =>
        html`<${Text} key=${"l" + i} color=${C.muted} wrap="truncate">${"  " + l}<//>`),
    ];
  }

  const d = deploy ?? {};
  const dcol = d.state === "stale" ? C.warn : d.state === "current" ? C.ok : C.muted;
  return [
    html`<${Text} key="d1" wrap="truncate">
      <${Text} color=${dcol}>${"  deploy  " + glyph(d.state === "current", d.state === "stale") + "  "}<//>
      <${Text}>${trunc(d.detail ?? "", w - 14)}<//>
    <//>`,
    html`<${Text} key="d2" color=${C.muted} wrap="truncate">
      ${"  the only deploy path here is a stack restart — sdk/src/testing/devnet.ts reads the"}<//>`,
    html`<${Text} key="d3" color=${C.muted} wrap="truncate">
      ${"  pool artifact and deploys it inside Devnet.initialize(), so p then u is the deploy"}<//>`,
    html`<${Text} key="d4">${" "}<//>`,
    html`<${Text} key="d5" color=${C.muted} wrap="truncate">
      ${"  enter runs the selected operation · every one shows its command and confirms first"}<//>`,
  ];
}

export const BuildPage = ({
  width, height, selected, focus, results, artifacts, busy, result, lines, deploy,
}) => {
  const topH = OPERATIONS.length + 2;
  const botH = Math.max(5, height - topH);
  const inner = topH - 2;
  const rows = opRows({ width, results, artifacts, selected, focus });
  const win = windowRows(rows, selected, inner);

  return html`
    <${Box} flexDirection="column" width=${width} height=${height} overflow="hidden">
      <${Block} w=${width} h=${topH} title="operations" focused=${focus === "list"}
        right=${win.note || "enter runs the selected one"} rows=${win.rows} />
      <${Block} w=${width} h=${botH}
        title=${busy ? "running" : result ? "result" : "deploy"} focused=${focus === "out"}
        right=${busy ? "l watches the full log" : ""}
        rows=${bottomRows({ width, busy, result, lines, deploy })} />
    <//>`;
};
