/**
 * Headless driver against the REAL modules — a running stack, or whatever this machine
 * actually has. For a driver that needs no stack at all, see `sandbox/run.mjs --drive`.
 *
 * Tests assert; this shows. A dashboard that passes every assertion and still reads as
 * noise is a failure nothing in render.mjs would catch, so:
 *
 *   node test/drive.mjs 100 30 e TAB
 *   node test/drive.mjs 80 24 t DOWN ENTER
 *
 * Key names: ENTER ESC TAB UP DOWN LEFT RIGHT PGUP PGDN SPACE; anything else is sent
 * as literal characters.
 */

import { drive } from "../sandbox/drive.mjs";

const [cols, rows, ...keys] = process.argv.slice(2);
await drive(Number(cols) || 100, Number(rows) || 30, keys);
process.exit(0);
