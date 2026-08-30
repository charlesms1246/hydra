/**
 * The two panels that survived the page rewrite.
 *
 * Everything else in here — the services, wallets, activity and tools panes, the
 * generic `Rig` list/detail machinery and the `PANES` table it walked — was replaced
 * by dedicated pages that each know their own data, and is gone rather than left
 * unreachable. The log and the confirm prompt stayed because they are genuinely
 * shared: every page can put something in the log, and every page can ask.
 */

import { Box, Text } from "ink";
import { html } from "./ui.mjs";
import { C } from "./theme.mjs";
import { Frame, wrap, windowOf, indicatorFor } from "./layout.mjs";
import { Legend } from "./disclosure.mjs";

export const LogPane = ({ lines, title, width, height, selected, filter }) => {
  const interior = (width ?? 94) - 2;
  const all = (lines ?? []).map((l) => (typeof l === "string" ? { text: l, sev: "info" } : l));
  const shown = filter?.text
    ? all.filter((l) => l.text.toLowerCase().includes(filter.text.toLowerCase()))
    : all;
  const body = Math.max(1, (height ?? 10) - 2);
  const sel = Math.min(selected ?? Math.max(0, shown.length - 1), Math.max(0, shown.length - 1));
  const { start, end } = windowOf(shown.length, sel, body);
  const win = shown.slice(start, end);
  return html`
    <${Frame} width=${width ?? 94} height=${height ?? 10} focused=${true}
      title=${`log · ${title || "hydra"}${filter?.text ? ` · /${filter.text}${filter.typing ? "_" : ""}` : ""}`}
      right=${`${indicatorFor(shown.length, start, end)} · / filter · s w scroll`}>
      ${win.map((l, i) => {
        const sev = l.sev === "warn" ? C.warn : l.sev === "bad" ? C.bad : C.muted;
        return html`
          <${Box} key=${start + i}>
            <${Box} width=${2}>
              <${Text} color=${sev}>${l.sev === "warn" ? "!" : l.sev === "bad" ? "x" : " "}<//>
            <//>
            <${Text} color=${start + i === sel ? undefined : sev}>
              ${l.text.slice(0, interior - 2)}<//>
          <//>`;
      })}
      ${Array.from({ length: Math.max(0, body - win.length) }, (_, i) =>
        html`<${Text} key=${"lp" + i}>${" "}<//>`)}
    <//>`;
};

/**
 * One confirm component for every irreversible thing: a doctor fix and a real
 * transaction ask the same way. Descending into something that touches the world
 * asks first — one rule, not two.
 */
export const Confirm = ({ c, width }) => html`
  <${Box} flexDirection="column" marginTop=${1}>
    <${Text} color=${C.warn}>${"  " + c.prompt}<//>
    ${c.cmd ? html`<${Box} marginLeft=${4}><${Text}>${("$ " + c.cmd).slice(0, width - 6)}<//><//>` : null}
    ${c.cwd ? html`<${Box} marginLeft=${4}><${Text} color=${C.muted}>${("in " + c.cwd).slice(0, width - 6)}<//><//>` : null}
    ${(c.lines ?? []).map((l, i) =>
      html`<${Box} key=${i} marginLeft=${4}><${Text} color=${C.muted}>${l.slice(0, width - 6)}<//><//>`)}
    ${c.legend ? html`<${Legend} width=${width} />` : null}
    <${Text} color=${C.warn}>${"  y run · n cancel"}<//>
  <//>`;

/** The run menu. Each flow carries the leak action type it maps to. */
