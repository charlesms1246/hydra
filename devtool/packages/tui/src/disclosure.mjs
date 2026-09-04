/**
 * The home screen: the disclosure matrix, and the evidence under it.
 *
 * The previous TUI collapsed a 6×5 report into six sentences (app.mjs:162-184).
 * That transform was not merely lossy, it was wrong: an `invoke` gives the public
 * observer UNKNOWN, UNKNOWN, CLEAR, CLEAR, CLEAR, and the `if (clear.length)`
 * branch printed "learns counterparty, timing, addresses" — deleting both
 * UNKNOWNs, which facts.mjs:33 says are never a pass. It also rendered an
 * all-N/A row and an all-NOT_DISCLOSED row identically as grey "nothing from
 * this tx", the exact false reassurance facts.mjs:25-30 exists to prevent.
 *
 * So there is no transform here. These components render
 * report.disclosures[i].byParty[party][field] directly. Every component is pure.
 */

import { Box, Text } from "ink";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { html } from "./ui.mjs";
import { C, mark, PARTY_SHORT, FIELD_SHORT } from "./theme.mjs";
import { Frame, wrap, windowOf } from "./layout.mjs";
import { UNKNOWN } from "../../leak/src/facts.mjs";
import { whatDoesThisLeak } from "../../leak/src/leak.mjs";
import { leakConfig } from "../../cli/src/agentcmds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/**
 * The configuration `hydra-dev up` actually runs. Defined once, in the CLI, and
 * re-exported here: `hydra-dev leak --json` and this matrix are the same pane, and a
 * second copy of the config is the one way they could describe different
 * machines. See agentcmds.mjs for why `network` is omitted.
 */
export { leakConfig };

/**
 * The three values on the strip that are NOT read from the running stack, each
 * with the line that makes it true at this pin. They are literals, so they are
 * marked `fixed` on screen rather than presented as measurements — the strip is
 * the header under which all 30 cells are read, and a reader has no way to tell
 * a measured word from a typed one otherwise.
 *
 * Only `proving` is measured (status().prover.mode, packages/core/src/
 * services.mjs:40); `discovery` is leakConfig()'s own literal, above, justified
 * by the same control.mjs line as `ohttp OFF`.
 */
export const CONFIG_FIXED = [
  // Two arguments — `new IndexerDiscoveryProvider(indexerUrl, poolAddress)` — so
  // no OHTTP relay is configured for the discovery calls `hydra-dev up` makes.
  ["ohttp OFF", "ohttp OFF", "packages/cli/src/control.mjs:36"],
  // leakConfig() omits `network` on purpose; leak.mjs then names no auditor key.
  ["network UNKNOWN", "network UNKNOWN", "devnet, not mainnet or sepolia"],
  // set_viewing_key encrypts the private viewing key to self.auditor_public_key
  // and writes it through to_write_once_action. No opt-out, no substitution.
  ["escrow FORCED", "escrow ON", "upstream:privacy.cairo:319-345"],
];

/** Two values read from the stack, three typed ones marked as typed. */
export const ConfigStrip = ({ cfg, width }) => {
  const cited = CONFIG_FIXED.map(([v, , c]) => `${v} (${c})`).join(" · ");
  const long = CONFIG_FIXED.map(([v]) => v).join(" · ");
  const short = CONFIG_FIXED.map(([, v]) => v).join(" · ");
  const tight = CONFIG_FIXED.map(([, v]) => v).join(", ");
  // Widest that fits, in the order values give ground: the citations first, then
  // the `proving` label, then `escrow FORCED` → `escrow ON`, then the `discovery`
  // label. No VALUE is ever dropped — every word on this line changes what the
  // matrix below it means. The indent goes before any of them.
  const tiers = [
    `discovery ${cfg.discovery} · proving ${cfg.proving} · fixed ${cited}`,
    `discovery ${cfg.discovery} · proving ${cfg.proving} · fixed ${long}`,
    `discovery ${cfg.discovery} · ${cfg.proving} · fixed ${short}`,
    `${cfg.discovery} ${cfg.proving} · fixed ${tight}`,
  ];
  const line = tiers.find((t) => t.length + 1 <= width) ?? tiers[tiers.length - 1];
  return html`<${Text} color=${C.muted}>${(line.length + 1 <= width ? " " + line : line).slice(0, width)}<//>`;
};

/** One entry per action run this session. Survives a stack outage. */
export const Ledger = ({ runs, selected, rows, width }) => {
  if (rows <= 0) return null;
  const { start, end } = windowOf(runs.length, selected, rows);
  const shown = runs.slice(start, end);
  const pad = Array.from({ length: Math.max(0, rows - shown.length) }, (_, i) => i);
  return html`
    <${Box} flexDirection="column">
      ${shown.map((r, i) => {
        const idx = start + i;
        const on = idx === selected;
        const unk = r.report?.unknownCount ?? 0;
        // The UNKNOWN count is the last thing to go, and the duration is the
        // first: a run's unknown cells are the reason to open it again.
        const cells = [
          `${on ? "▸" : " "} ${String(runs.length - idx).padStart(2)}  ${r.label}`.padEnd(Math.min(44, width - 38)),
          r.ok ? "ok  " : "FAIL",
          r.txHash ? r.txHash.slice(0, 8) + "…" : "on disk  ",
          ...(width >= 92 ? [r.ms ? String(r.ms).padStart(6) + "ms" : "      —", r.at.slice(0, 5)] : []),
          unk ? `${unk} UNKNOWN` : "",
        ];
        const line = cells.filter((c) => c !== "").join("  ");
        return html`<${Text} key=${r.id} color=${on ? C.accent : C.muted}>${" " + line.slice(0, width - 1)}<//>`;
      })}
      ${pad.map((i) => html`<${Text} key=${"lp" + i}>${" "}<//>`)}
    <//>`;
};

/**
 * The 6×5 matrix. All 30 cells, never rolled up, never summarised.
 *
 * THE AUDITOR sits below a dotted rule with a permanent epigraph because that row
 * is not a consequence of your configuration: it is DECRYPTABLE on all five
 * fields of all five action types, under every config (leak.mjs auditorRow).
 */
export const Matrix = ({ report, actionIndex, cursor, geom, width, focused, headline, right }) => {
  const d = report.disclosures[actionIndex];
  const { partyW, fieldW, marks } = geom;
  // THE AUDITOR is upper case at every width. It is the one row that is true
  // without a measurement, and it should not read like the other five.
  const gutter = marks === "long" ? 3 : 2;
  const label = ([id, long]) =>
    (id === "auditor" ? PARTY_SHORT.auditor : marks === "long" ? long : PARTY_SHORT[id] ?? id)
      .slice(0, partyW - gutter - 1);
  const head = ([, name]) => (marks === "long" ? name : FIELD_SHORT[name] ?? name);

  const cellFor = (pid, field) => d.byParty[pid]?.[field] ?? { disclosure: UNKNOWN };

  const partyRow = (party, pi) => {
    const [pid] = party;
    return html`
      <${Box} key=${pid}>
        <${Box} width=${partyW}>
          <${Text} color=${pid === "auditor" ? C.warn : undefined} bold=${pid === "auditor"}>
            ${(((pi === cursor.party ? "▸ " : "  ") + label(party)).padStart(gutter + label(party).length)).slice(0, partyW)}
          <//>
        <//>
        ${report.fields.map((f, fi) => {
          const m = mark(cellFor(pid, f).disclosure);
          const on = pi === cursor.party && fi === cursor.field;
          return html`
            <${Box} key=${f} width=${fieldW}>
              <${Text} color=${m.color} inverse=${on}>${m.word}<//>
            <//>`;
        })}
      <//>`;
  };

  const parties = report.parties;
  const dotted = "·".repeat(Math.max(0, partyW + fieldW * 5 - 28)) + " contract-enforced, always ··";
  return html`
    <${Frame} width=${width} focused=${focused}
      title=${headline} right=${right ?? `upstream ${report.upstreamCommit.slice(0, 8)}`}>
      <${Box}>
        <${Box} width=${partyW}><${Text}>${" "}<//><//>
        ${report.fields.map((f) => html`
          <${Box} key=${f} width=${fieldW}><${Text} color=${C.muted}>${head([null, f])}<//><//>`)}
      <//>
      ${parties.filter(([id]) => id !== "auditor").map(partyRow)}
      <${Text} color=${C.muted} dimColor>${dotted.slice(0, partyW + fieldW * 5)}<//>
      ${parties.filter(([id]) => id === "auditor").map((p) => partyRow(p, parties.length - 1))}
    <//>`;
};

/** Never dropped at any width: an unglossed `not-by-tx` reads as "private". */
export const Legend = ({ width }) => {
  const full = "CLEAR in plaintext · DECRYPTABLE holds a key that opens it · not-by-tx NOT a privacy claim";
  const short = "CLEAR plaintext · DECRYPTABLE holds a key · not-by-tx NOT a privacy claim";
  return html`<${Text} color=${C.muted}>${"  " + (full.length + 2 <= width ? full : short).slice(0, width - 2)}<//>`;
};

/** The focused cell's verbatim `why` plus every citation it carries. */
export const WhyDrawer = ({ report, actionIndex, cursor, width, bodyRows, citeRows, scroll, focused, expanded }) => {
  const [pid, plabel] = report.parties[cursor.party];
  const field = report.fields[cursor.field];
  const cell = report.disclosures[actionIndex].byParty[pid]?.[field] ?? {};
  const interior = width - 2;
  const lines = wrap(cell.why ?? "no `why` on this cell — that is a defect in packages/leak", interior - 1);
  const cites = cell.cites ?? [];
  const body = expanded ? bodyRows : Math.max(1, bodyRows);
  const start = Math.min(scroll, Math.max(0, lines.length - body));
  // The "N more" indicator costs a row, so it comes OUT of the budget, not on top
  // of it. It used to be extra, which is why the whole frame reached stdout.rows
  // at every width from 70 to 76 — where the `why` wraps to more lines than fit —
  // and Ink cleared the terminal on every frame (ink/build/ink.js:121).
  const shown = lines.slice(start, start + (lines.length - start > body ? body - 1 : body));
  const more = lines.length - (start + shown.length);
  const m = mark(cell.disclosure);
  const citeBudget = expanded ? cites.length : citeRows;
  const citeShown = cites.slice(0, cites.length > citeBudget ? Math.max(0, citeBudget - 1) : citeBudget);
  const citeExtra = cites.length - citeShown.length;
  return html`
    <${Frame} width=${width} focused=${focused}
      title=${`why · ${plabel} × ${field}`}
      right=${expanded ? `${m.word} · esc collapses` : `${m.word} · ${cursor.field + 1} of ${report.fields.length} cells`}>
      ${shown.map((l, i) => html`
        <${Text} key=${"w" + i}>${(" " + l).padEnd(interior).slice(0, interior)}<//>`)}
      ${more > 0
        ? html`<${Text} color=${C.muted}>${` ↓ ${more} more — enter expands`}<//>`
        : Array.from({ length: Math.max(0, body - shown.length) }, (_, i) =>
            html`<${Text} key=${"wp" + i}>${" "}<//>`)}
      ${citeShown.map((c, i) => html`
        <${Box} key=${"c" + i}>
          <${Box} width=${8}><${Text} color=${C.muted}>${i === 0 ? " cites" : ""}<//><//>
          <${Text} color=${C.accent} dimColor>${c.slice(0, interior - 8)}<//>
        <//>`)}
      ${citeExtra > 0
        ? html`<${Text} color=${C.muted}>${`        +${citeExtra} more — enter expands`}<//>`
        : Array.from({ length: Math.max(0, (expanded ? 0 : citeRows) - citeShown.length) }, (_, i) =>
            html`<${Text} key=${"cp" + i}>${" "}<//>`)}
    <//>`;
};

/**
 * report.notes[] with kind and cites, plus hydra's own local caveat under a label
 * that says whose sentence it is. A hydra annotation must never be mistakable for
 * a leak-generated row.
 */
export const NotesDrawer = ({ report, auditorNote, width, bodyRows, focused, scroll }) => {
  const interior = width - 2;
  const lines = [];
  for (const n of report.notes ?? []) {
    for (const l of wrap(`${n.kind}  ${n.text}`, interior - 1)) lines.push({ l, color: n.kind === "unknown" ? C.unknown : C.muted });
  }
  for (const l of wrap(`hydra annotation  ${String(auditorNote).replace(/\s+/g, " ").trim()}`, interior - 1)) {
    lines.push({ l, color: C.accent });
  }
  const start = Math.min(scroll, Math.max(0, lines.length - bodyRows));
  const shown = lines.slice(start, start + bodyRows);
  return html`
    <${Frame} width=${width} focused=${focused}
      title=${`notes · ${(report.notes ?? []).length} from the report`}
      right=${`${start + 1}-${start + shown.length}/${lines.length} · tab cycles`}>
      ${shown.map((x, i) => html`
        <${Text} key=${"n" + i} color=${x.color}>${(" " + x.l).padEnd(interior).slice(0, interior)}<//>`)}
      ${Array.from({ length: Math.max(0, bodyRows - shown.length) }, (_, i) =>
        html`<${Text} key=${"np" + i}>${" "}<//>`)}
    <//>`;
};

/** report.anonymitySets[] — question, size, basis, cites. */
export const AnonDrawer = ({ report, actionIndex, width, bodyRows, focused, scroll }) => {
  const interior = width - 2;
  const set = report.anonymitySets?.[actionIndex] ?? {};
  const lines = [
    { l: set.question ?? "no anonymity-set question for this action", color: undefined },
    ...wrap(`size ${set.size ?? UNKNOWN}`, interior - 1).map((l) => ({
      l, color: set.size === UNKNOWN || set.size === undefined ? C.unknown : C.warn,
    })),
    ...wrap(set.basis ?? "", interior - 1).map((l) => ({ l, color: C.muted })),
    ...(set.cites ?? []).map((c) => ({ l: c, color: C.accent })),
  ];
  const start = Math.min(scroll, Math.max(0, lines.length - bodyRows));
  const shown = lines.slice(start, start + bodyRows);
  return html`
    <${Frame} width=${width} focused=${focused}
      title=${`anonymity set · action ${actionIndex + 1}`}
      right=${`${start + 1}-${start + shown.length}/${lines.length} · tab cycles`}>
      ${shown.map((x, i) => html`
        <${Text} key=${"a" + i} color=${x.color}>${(" " + x.l).padEnd(interior).slice(0, interior)}<//>`)}
      ${Array.from({ length: Math.max(0, bodyRows - shown.length) }, (_, i) =>
        html`<${Text} key=${"ap" + i}>${" "}<//>`)}
    <//>`;
};

// ---------------------------------------------------------------------------
// The empty state, and the art
// ---------------------------------------------------------------------------

/** Read once at module load. Kept as data; nothing here is a string literal. */
const ART = (() => {
  try {
    const src = readFileSync(join(HERE, "art.txt"), "utf8").replace(/\n$/, "").split("\n");
    if (!src.length) return null;
    return { src, h: src.length, w: Math.max(...src.map((l) => l.length)) };
  } catch {
    return null;
  }
})();

/**
 * Box downsample. Two tones, not a threshold: averaging ink over the source
 * rectangle and emitting "#" at ≥50% and ":" above zero is what keeps the
 * silhouette's edges legible at quarter scale. A pure threshold turns to mush.
 */
export function sample(rows, cols) {
  if (!ART) return [];
  const { src, h, w } = ART;
  const out = [];
  for (let r = 0; r < rows; r++) {
    const r0 = Math.floor((r * h) / rows);
    const r1 = Math.max(r0 + 1, Math.floor(((r + 1) * h) / rows));
    let line = "";
    for (let c = 0; c < cols; c++) {
      const c0 = Math.floor((c * w) / cols);
      const c1 = Math.max(c0 + 1, Math.floor(((c + 1) * w) / cols));
      let ink = 0;
      let n = 0;
      for (let y = r0; y < r1; y++) {
        for (let x = c0; x < c1; x++) {
          n++;
          const ch = (src[y] ?? "")[x];
          if (ch && ch !== " ") ink++;
        }
      }
      line += ink / n >= 0.5 ? "#" : ink > 0 ? ":" : " ";
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

/** 13×62 and 9×50 read as the creature; 7×30 is mush, so it is not a gate. */
export function pickArt(cols, rows) {
  if (!ART) return null;
  if (rows >= 13 && cols >= 62) return sample(13, 62);
  if (rows >= 9 && cols >= 50) return sample(9, 50);
  return null;
}

/**
 * The auditor row, generated rather than typed.
 *
 * The empty state used to print five `"DECRYPTABLE"` string literals under the
 * sentence "true of every action, in every configuration" — a disclosure claim,
 * in the disclosure vocabulary, asserted on the first screen a new user sees.
 * Standing rule 6 says those are computed. leak.mjs's auditorRow does not read
 * the config, so one report is enough; if that ever stops being true this row
 * changes with it instead of quietly going stale.
 */
const AUDITOR = (() => {
  const r = whatDoesThisLeak({ config: leakConfig(null), actions: [{ type: "register" }] });
  const row = r.disclosures[0].byParty.auditor;
  return { fields: r.fields, cells: r.fields.map((f) => row[f]) };
})();

/**
 * Second zero. The one row that is true without a measurement is on screen
 * before anything has been run, and it carries its citations.
 */
export const EmptyState = ({ hasStack, width, height }) => {
  const interior = width - 2;
  const art = hasStack ? null : pickArt(interior - 2, height - 10);
  const pad = art ? Math.max(0, Math.floor((interior - Math.max(...art.map((l) => l.length))) / 2)) : 0;
  const pitch = hasStack
    ? ["no transaction yet — x runs one · e loads packages/leak/examples/private-transfer.json"]
    : [
        "six parties can read a transaction on this pool. one of them you cannot",
        "remove: registration encrypts your private viewing key to an auditor key",
        "held in contract storage — write-once, no opt-out, no substitution.",
      ];
  const colW = Math.floor((interior - 2) / AUDITOR.fields.length);
  return html`
    <${Frame} width=${width} title=${hasStack ? "nothing has been run yet" : "nothing has been run"}
      right=${hasStack ? "x runs a flow" : "u starts a stack"}>
      ${(art ?? []).map((l, i) => html`
        <${Text} key=${"art" + i} color=${C.muted} dimColor>${" ".repeat(pad) + l}<//>`)}
      ${pitch.map((l, i) => html`<${Text} key=${"p" + i}>${"  " + l.slice(0, interior - 2)}<//>`)}
      <${Text}>${" "}<//>
      <${Text} color=${C.warn}>${"  the auditor · true of every action, in every configuration"}<//>
      <${Box}>
        <${Box} width=${4}><${Text}>${" "}<//><//>
        ${AUDITOR.fields.map((f) => html`
          <${Box} key=${f} width=${colW}><${Text} color=${C.muted}>${FIELD_SHORT[f] ?? f}<//><//>`)}
      <//>
      <${Box}>
        <${Box} width=${4}><${Text}>${" "}<//><//>
        ${AUDITOR.fields.map((f, i) => html`
          <${Box} key=${"d" + f} width=${colW}>
            <${Text} color=${mark(AUDITOR.cells[i].disclosure).color}>
              ${mark(AUDITOR.cells[i].disclosure).word}<//>
          <//>`)}
      <//>
      <${Text} color=${C.accent} dimColor>
        ${("  findings/01-escrow.md · upstream:packages/privacy/src/privacy.cairo:319-345").slice(0, interior)}
      <//>
    <//>`;
};
