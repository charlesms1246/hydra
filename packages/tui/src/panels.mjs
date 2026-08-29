import { html } from "./ui.mjs";
import { Box, Text } from "ink";

/**
 * Ink requires every string to sit inside <Text>. A bare "${" "}" as a Box child
 * throws at render, so each row keeps its label in one Text and its value in
 * another — no loose strings between elements.
 */
const glyph = (up, warn) => (up ? "●" : warn ? "◐" : "○");
const tone = (up, warn) => (up ? "green" : warn ? "yellow" : "gray");

const Row = ({ label, up, warn, value, note }) => html`
  <${Box}>
    <${Box} width=${10}><${Text} color="gray">${label}<//><//>
    <${Box} width=${2}><${Text} color=${tone(up, warn)}>${glyph(up, warn)}<//><//>
    <${Text}>${value}<//>
    ${note ? html`<${Text} color="gray">${"   " + note}<//>` : null}
  <//>`;

export const Services = ({ s }) => {
  if (!s) return html`<${Text} color="gray">loading…<//>`;
  const sk = s.agents.skills;
  return html`
    <${Box} flexDirection="column">
      <${Row}
        label="devnet" up=${s.devnet.up}
        value=${s.devnet.up ? s.devnet.url : "down"}
        note=${s.devnet.up && s.devnet.blockNumber !== null ? `block ${s.devnet.blockNumber}` : null} />
      <${Row}
        label="indexer" up=${s.indexer.up}
        value=${s.indexer.up ? s.indexer.url : "down"}
        note=${s.indexer.up ? `lag ${s.indexer.lagSecs ?? "?"}s` : null} />
      <${Row}
        label="prover" up=${false} warn=${true}
        value=${s.prover.mode} note="no proving URL needed" />
      <${Row}
        label="mcp" up=${s.agents.mcp.present}
        value=${s.agents.mcp.present ? "present" : "missing"} />
      <${Row}
        label="skills"
        up=${sk.installed.length === sk.expected.length}
        warn=${sk.installed.length > 0}
        value=${`${sk.installed.length}/${sk.expected.length} installed`} />
      <${Box} marginTop=${1}>
        ${s.stack
          ? html`<${Text} color="gray">${"pool  " + s.stack.poolAddress}<//>`
          : html`<${Text} color="yellow">${"no running stack — run `hydra up` in another shell"}<//>`}
      <//>
    <//>`;
};

export const Wallets = ({ w, selected }) => {
  if (!w) return html`<${Text} color="gray">loading…<//>`;
  if (!w.available) return html`<${Text} color="yellow">${w.reason}<//>`;
  return html`
    <${Box} flexDirection="column">
      ${w.wallets.map((x, i) => html`
        <${Box} key=${x.name}>
          <${Text} color=${i === selected ? "cyan" : undefined}>${i === selected ? "▸ " : "  "}${x.name.padEnd(7)}<//>
          <${Text} color="gray">${x.address.slice(0, 16)}${"… "}<//>
          <${Text}>${Object.entries(x.balances).map(([sym, b]) => `${b.formatted ?? "?"} ${sym}`).join("   ")}<//>
        <//>`)}
      <${Box} marginTop=${1}><${Text} color="gray">${"f — fund the selected account (devnet only)"}<//><//>
    <//>`;
};

export const Activity = ({ b }) => {
  if (!b) return html`<${Text} color="gray">loading…<//>`;
  if (!b.available) return html`<${Text} color="yellow">${b.reason}<//>`;
  if (!b.blocks.length) return html`<${Text} color="gray">no blocks yet<//>`;
  return html`
    <${Box} flexDirection="column">
      ${b.blocks.map((x) => html`
        <${Box} key=${x.number}>
          <${Box} width=${9}><${Text} color="cyan">${"#"}${x.number}<//><//>
          <${Box} width=${8}><${Text} color=${x.txCount ? undefined : "gray"}>${x.txCount}${" tx"}<//><//>
          <${Text} color="gray">${x.hash.slice(0, 20)}${"…"}<//>
        <//>`)}
    <//>`;
};

export const Tools = ({ d, selected, confirm }) => {
  if (!d) return html`<${Text} color="gray">loading…<//>`;
  const rows = d.rows;
  const bad = rows.filter((r) => r.status.trim() !== "ok");
  return html`
    <${Box} flexDirection="column">
      ${rows.map((r, i) => {
        const st = r.status.trim();
        const isSel = i === selected;
        const canFix = st !== "ok" && r.cmd;
        return html`
          <${Box} key=${r.name}>
            <${Box} width=${2}>
              <${Text} color="cyan">${isSel ? "▸" : " "}<//>
            <//>
            <${Box} width=${3}>
              <${Text} color=${st === "ok" ? "green" : st === "WARN" ? "yellow" : "red"}>${st === "ok" ? "●" : st === "WARN" ? "◐" : "○"}<//>
            <//>
            <${Box} width=${29}>
              <${Text} color=${isSel ? "cyan" : undefined}>${r.name.replace("artifact: ", "")}<//>
            <//>
            <${Box} width=${17}><${Text} color="gray">${"want " + String(r.want).slice(0, 11)}<//><//>
            <${Box} width=${14}><${Text} color=${st === "ok" ? "gray" : "yellow"}>${r.got}<//><//>
            <${Text} color=${canFix ? "magenta" : "gray"}>${canFix ? "fixable" : ""}<//>
          <//>`;
      })}

      ${confirm
        ? html`
          <${Box} flexDirection="column" marginTop=${1}>
            <${Text} color="yellow">${"run this? it executes a real command"}<//>
            <${Box} marginLeft=${2}><${Text}>${"$ " + confirm.cmd}<//><//>
            ${confirm.cwd ? html`<${Box} marginLeft=${2}><${Text} color="gray">${"in " + confirm.cwd}<//><//>` : null}
            <${Text} color="yellow">${"y run · n cancel"}<//>
          <//>`
        : bad.length === 0
          ? html`<${Box} marginTop=${1}><${Text} color="green">${"everything pinned and built"}<//><//>`
          : html`
            <${Box} flexDirection="column" marginTop=${1}>
              <${Text} color="yellow">${bad.length + " need attention — ↑↓ to select, i to fix"}<//>
              ${rows[selected] && rows[selected].status.trim() !== "ok" && !rows[selected].cmd
                ? html`<${Box} marginLeft=${2}><${Text} color="gray">${"no automatic fix: " + String(rows[selected].hint ?? "").split("\n")[0]}<//><//>`
                : null}
            <//>`}
    <//>`;
};

/** Shared output pane — stack startup and fix commands both stream here. */
export const LogPane = ({ lines, title }) => {
  if (!lines?.length) return null;
  return html`
    <${Box} flexDirection="column" marginTop=${1} borderStyle="round" borderColor="gray" paddingX=${1}>
      <${Text} color="gray">${title}<//>
      ${lines.slice(-8).map((l, i) => html`
        <${Text} key=${i} color="gray">${l.length > 92 ? l.slice(0, 92) + "…" : l}<//>`)}
    <//>`;
};

/**
 * Transact — run a real private transfer against the local pool, then show what
 * it disclosed. The point of the pane is the pairing: hydra is the only place
 * where doing the thing and seeing its disclosure sit on one screen.
 */
export const Transact = ({ t, selected, actions }) => {
  if (!t?.available) {
    return html`<${Text} color="yellow">${t?.reason ?? "no running stack — press u to start one"}<//>`;
  }
  return html`
    <${Box} flexDirection="column">
      ${actions.map((a, i) => html`
        <${Box} key=${a.id}>
          <${Box} width=${2}><${Text} color="cyan">${i === selected ? "▸" : " "}<//><//>
          <${Text} color=${i === selected ? "cyan" : undefined}>${a.label}<//>
        <//>`)}

      <${Box} marginTop=${1} flexDirection="column">
        <${Text} color="gray">${"notes in the pool"}<//>
        ${["alice", "bob"].map((who) => html`
          <${Box} key=${who} marginLeft=${2}>
            <${Box} width=${8}><${Text}>${who}<//><//>
            <${Text} color=${(t.notes?.[who] ?? []).length ? undefined : "gray"}>
              ${(t.notes?.[who] ?? []).length
                ? t.notes[who].map((n) => `${n.amount} ${n.symbol}`).join("   ")
                : "none"}
            <//>
          <//>`)}
      <//>

      ${t.last
        ? html`
          <${Box} marginTop=${1} flexDirection="column">
            <${Text} color=${t.last.ok ? "green" : "red"}>
              ${t.last.ok ? `${t.last.what} ok` : `${t.last.what} failed`}
            <//>
            ${t.last.txHash
              ? html`<${Box} marginLeft=${2}><${Text} color="gray">${"tx " + t.last.txHash}<//><//>`
              : null}
            ${t.last.error
              ? html`<${Box} marginLeft=${2}><${Text} color="red">${t.last.error.slice(0, 100)}<//><//>`
              : null}
          <//>`
        : null}

      ${t.leak
        ? html`
          <${Box} marginTop=${1} flexDirection="column">
            <${Text} color="gray">${"what that disclosed — " + t.leak.subject}<//>
            ${t.leak.rows.map((r) => html`
              <${Box} key=${r.party} marginLeft=${2}>
                <${Box} width=${28}><${Text} color="gray">${r.party}<//><//>
                <${Text} color=${r.color}>${r.summary}<//>
              <//>`)}
            <${Box} marginLeft=${2}>
              <${Text} color="gray" dimColor>${"full report: packages/leak"}<//>
            <//>
          <//>`
        : null}
    <//>`;
};
