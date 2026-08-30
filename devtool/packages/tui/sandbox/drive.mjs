/**
 * Headless frame capture, for the sandbox.
 *
 * Same idea as test/drive.mjs, but importable so run.mjs can boot the world first —
 * a top-level-await script could not, because the loader has to be registered and the
 * fake server listening before App is imported.
 */

import { render } from "ink";
import { Writable, PassThrough } from "node:stream";

const KEY = { ENTER: "\r", ESC: "\x1b", TAB: "\t", DOWN: "\x1b[B", UP: "\x1b[A",
  RIGHT: "\x1b[C", LEFT: "\x1b[D", PGDN: "\x1b[6~", PGUP: "\x1b[5~", SPACE: " " };
const strip = (t) => t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

class Sink extends Writable {
  constructor(c, r) { super(); this.frames = []; this.columns = c; this.rows = r; }
  _write(x, e, cb) { this.frames.push(x.toString()); cb(); }
}

export async function drive(cols, rows, keys = [], settleMs = 400) {
  const { html } = await import("../src/ui.mjs");
  const { App } = await import("../src/app.mjs");

  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
  const stdout = new Sink(cols, rows);
  const app = render(html`<${App} />`, { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });

  await new Promise((r) => setTimeout(r, settleMs));
  for (const k of keys) {
    // `WAIT:<ms>` is a pause, not a keystroke — the only way to drive something that
    // spawns a real process (a build, a test run) and still capture its result frame.
    const wait = /^WAIT:(\d+)$/.exec(k);
    if (wait) { await new Promise((r) => setTimeout(r, Number(wait[1]))); continue; }
    stdin.write(KEY[k] ?? k);
    await new Promise((r) => setTimeout(r, 220));
  }
  await new Promise((r) => setTimeout(r, Math.max(300, settleMs)));

  const f = strip(stdout.frames.at(-1) ?? "").replace(/\n$/, "").split("\n");
  const width = Math.max(0, ...f.map((l) => l.length));
  console.log(`=== ${cols}x${rows} after [${keys.join(" ")}] — ${f.length} rows, max width ${width} ===`);
  f.forEach((l) => console.log("|" + l + "|"));
  if (f.length >= rows) console.log(`!! ${f.length} rows >= stdout.rows ${rows} — Ink clears the terminal here`);
  app.unmount();
  return { frame: f, rows: f.length, width };
}
