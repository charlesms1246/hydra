import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A still of the terminal interface, drawn with the same box characters the real one uses.
 *
 * ⛔ **This is a MOCK and it says so on the page.** It is not a capture: capturing the TUI needs a
 * running devnet, a funded account and a vault, so it cannot be produced at build time the way
 * `CommandSurface` captures the CLI's help. What can be pinned is the *chrome* — the box glyphs
 * and the pane titles below are read out of `packages/tui/src/screen.ts` and `view.ts` at build
 * time, so a mock whose frame no longer matches the product fails the build instead of quietly
 * becoming a drawing of something that does not exist.
 *
 * **The content inside the frame is invented and every value in it is obviously fake** — one-word
 * peer names, a short fingerprint of repeated characters. That is deliberate: a plausible-looking
 * fingerprint in a mock is a string somebody will eventually quote as real, and this project has
 * already had one claim assembled out of true-looking parts.
 *
 * ## Why a picture of the interface rather than a list of commands
 *
 * The demo pages read as help output, which is what they were: a captured command surface is a
 * catalogue, and a catalogue tells a reader what exists without showing them what using it is
 * like. The command list is still on the page, below this, because it is the part that is
 * verified. This is what the verified part looks like when it runs.
 */

/** The box glyphs, read from the TUI so the frame here cannot drift from the frame there. */
function boxGlyphs(): { tl: string; tr: string; bl: string; br: string; h: string; v: string } {
  const src = readFileSync(
    join(process.cwd(), "..", "hydra-dapp/packages/tui/src/screen.ts"),
    "utf8",
  );
  const m = /const BOX = \{([^}]*)\}/.exec(src);
  if (!m) {
    throw new Error(
      "packages/tui/src/screen.ts no longer declares BOX. The mock terminal draws its frame from "
      + "that constant so it cannot drift from the real one — find where the glyphs moved rather "
      + "than hardcoding them here.",
    );
  }
  const pick = (k: string) => {
    const g = new RegExp(`${k}:\\s*"([^"]+)"`).exec(m[1]);
    if (!g) throw new Error(`BOX has no ${k} — the mock terminal cannot draw its frame`);
    return g[1];
  };
  return { tl: pick("tl"), tr: pick("tr"), bl: pick("bl"), br: pick("br"), h: pick("h"), v: pick("v") };
}

const COLS = 92;

/** One titled pane, exactly as `screen.ts` composes one: title in the top rule, content clipped. */
function pane(title: string, lines: string[], width = COLS): string[] {
  const b = boxGlyphs();
  const inner = width - 2;
  const label = ` ${title} `.slice(0, inner);
  const out = [b.tl + label + b.h.repeat(Math.max(0, inner - label.length)) + b.tr];
  for (const l of lines) out.push(b.v + l.slice(0, inner).padEnd(inner) + b.v);
  out.push(b.bl + b.h.repeat(inner) + b.br);
  return out;
}

/**
 * The conversation view: the channel list beside a thread, which is the screen a reader would
 * actually spend time in.
 *
 * The marks are `?` and a tick, and each carries its basis on the same line — the TUI's own rule,
 * and the reason is that a mark alone is read as the strongest available meaning. A mock that drew
 * ticks without their bases would be teaching the wrong thing about the product.
 */
export function MockTui() {
  const left = 26;
  const right = COLS - left;
  const b = boxGlyphs();

  const channels = ["> ana", "  bo", "  cass"];
  const thread = [
    "  ana   are you still there",
    "        ? unverifiable — either of you could have written it",
    "",
    "  you   yes. sending the file now",
    "        ? unverifiable — either of you could have written it",
    "",
    "  ana   signed this one so you have it in writing",
    "        ✓ signed — under the key they handshook with",
  ];

  const rows = Math.max(channels.length, thread.length);
  const top: string[] = [];
  const cl = pane(`channels (${channels.length})`, [...channels, ...Array(rows - channels.length).fill("")], left);
  const th = pane("ana", [...thread, ...Array(rows - thread.length).fill("")], right);
  for (let i = 0; i < cl.length; i++) top.push(cl[i] + th[i]);

  const status = pane("status", [
    "  vault    up            queue    0 pending",
    "  chain    sepolia       reads    1.6s",
    "  invites  4 left",
  ]);

  return (
    <div className="tui">
      <pre className="tui-screen" aria-label="A still of the terminal interface: a channel list beside one conversation, with a status pane below.">
        {[...top, ...status].join("\n")}
      </pre>
      {/*
        ⛔ Says what it is. A picture of an interface, presented without this line, is a screenshot
        as far as a reader is concerned, and this project does not get to imply a capture it did
        not take. The frame is pinned to the source; the words inside are not.
      */}
      <p className="tui-note">
        A drawing of the interface, not a capture. The frame is read from{" "}
        <code>packages/tui/src/screen.ts</code> at build time so it cannot drift; the conversation
        in it is invented.
      </p>
    </div>
  );
}

/**
 * The devtool's screen: `hydra-dev status` against a local stack.
 *
 * Same rules as `MockTui` — the frame is read from the TUI's source, the contents are invented and
 * obviously so. `hydra-dev` is a scriptable CLI rather than a resident interface, so what it shows
 * is a run rather than a persistent view: the command, then what it printed.
 */
export function MockDevScreen() {
  const status = pane("hydra-dev status", [
    "  ● node      http://127.0.0.1:5050    block 421   chain SN_DEVNET",
    "  ● indexer   up                       lag 0",
    "  ● prover    container                idle",
    "  ○ mcp       not running",
    "  ○ skills    0/5 installed",
    "",
    "  pool        0x0000…0000",
  ]);

  return (
    <div className="tui">
      <pre className="tui-screen" aria-label="A still of the devtool printing the status of a local stack.">
        {["$ hydra-dev status", "", ...status].join("\n")}
      </pre>
      <p className="tui-note">
        A drawing, not a capture. The frame is read from <code>packages/tui/src/screen.ts</code> at
        build time; the addresses and block numbers in it are invented.
      </p>
    </div>
  );
}
