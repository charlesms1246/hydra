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

export const Tools = ({ d }) => {
  if (!d) return html`<${Text} color="gray">loading…<//>`;
  const bad = d.rows.filter((r) => r.status.trim() !== "ok");
  return html`
    <${Box} flexDirection="column">
      ${d.rows.map((r) => {
        const st = r.status.trim();
        return html`
          <${Box} key=${r.name}>
            <${Box} width=${3}>
              <${Text} color=${st === "ok" ? "green" : st === "WARN" ? "yellow" : "red"}>${st === "ok" ? "●" : st === "WARN" ? "◐" : "○"}<//>
            <//>
            <${Box} width=${29}><${Text}>${r.name.replace("artifact: ", "")}<//><//>
            <${Box} width=${17}><${Text} color="gray">${"want " + String(r.want).slice(0, 11)}<//><//>
            <${Text} color=${st === "ok" ? "gray" : "yellow"}>${r.got}<//>
          <//>`;
      })}
      ${bad.length
        ? html`
          <${Box} flexDirection="column" marginTop=${1}>
            <${Text} color="yellow">${"to fix:"}<//>
            ${bad.map((r) => html`
              <${Box} key=${r.name} marginLeft=${2} flexDirection="column">
                <${Text} color="gray">${r.name}<//>
                <${Text}>${"  " + String(r.hint ?? "").split("\n")[0]}<//>
              <//>`)}
          <//>`
        : html`<${Box} marginTop=${1}><${Text} color="green">${"everything pinned and built"}<//><//>`}
    <//>`;
};
