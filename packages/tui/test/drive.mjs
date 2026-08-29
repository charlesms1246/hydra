/**
 * Headless driver. Mounts the real App against a fake tty, feeds it keystrokes,
 * and prints the last frame with its row count and widest line.
 *
 * Tests assert; this shows. A dashboard that passes every assertion and still
 * reads as noise is a failure nothing in render.mjs would catch, so:
 *
 *   node test/drive.mjs 100 30 e TAB
 *   node test/drive.mjs 80 24 t DOWN ENTER
 *
 * Key names: ENTER ESC TAB UP DOWN LEFT RIGHT PGUP PGDN; anything else is sent
 * as literal characters.
 */

import { render } from "ink";
import { Writable, PassThrough } from "node:stream";
import { html } from "../src/ui.mjs";
import { App } from "../src/app.mjs";

class Sink extends Writable {
  constructor(c, r) { super(); this.frames = []; this.columns = c; this.rows = r; }
  _write(x, e, cb) { this.frames.push(x.toString()); cb(); }
}
const strip = (t) => t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

const [cols, rows, ...keys] = process.argv.slice(2);
const stdin = new PassThrough();
stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
const stdout = new Sink(Number(cols), Number(rows));
const app = render(html`<${App} />`, { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
await new Promise((r) => setTimeout(r, 250));
const KEY = { ENTER: "\r", ESC: "\x1b", TAB: "\t", DOWN: "\x1b[B", UP: "\x1b[A", RIGHT: "\x1b[C", LEFT: "\x1b[D", PGDN: "\x1b[6~", PGUP: "\x1b[5~" };
for (const k of keys) { stdin.write(KEY[k] ?? k); await new Promise((r) => setTimeout(r, 180)); }
await new Promise((r) => setTimeout(r, 250));
const f = strip(stdout.frames.at(-1) ?? "").replace(/\n$/, "").split("\n");
console.log(`=== ${cols}x${rows} after [${keys.join(" ")}] — ${f.length} rows, max width ${Math.max(...f.map((l) => l.length))} ===`);
f.forEach((l) => console.log("|" + l + "|"));
app.unmount();
process.exit(0);
