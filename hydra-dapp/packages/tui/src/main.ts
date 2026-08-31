#!/usr/bin/env node
/**
 * `hydra-tui` — the client, as a process that stays running.
 *
 * This is the whole of the terminal wiring: raw mode, one write per frame, a one-second tick,
 * and teardown that runs on every path out including a crash. Everything it decides is decided
 * in `app.ts` and everything it does is done in `effects.ts`.
 *
 * IT BEING RESIDENT IS THE POINT, not a convenience. `commands.ts` schedules each upload for a
 * jittered moment after its own chain event, and a human running `hydra flush` by hand uploads
 * a message and all of its cover in one burst whenever they remember to — and a burst is a
 * message. `claude-docs/decisions/0011-cli-client.md` said so and could not fix it, because a
 * command is not running when the moment arrives. This is. `adversary/test/resident-flush.test.ts`
 * measures what that recovers and what it does not.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON } from "./screen.ts";
import { decode } from "./keys.ts";
import { start, update } from "./app.ts";
import type { Model } from "./app.ts";
import { screen } from "./view.ts";
import { perform } from "./effects.ts";
import { load, save, STATE_FILE } from "../../cli/src/state.ts";
import { chainFor } from "../../cli/src/chain.ts";

/** How often the queue is checked. One second, because the schedule is in milliseconds. */
const TICK_MS = 1000;

let model: Model = start(existsSync(STATE_FILE) ? load() : null, Date.now());

const size = () => ({
  rows: process.stdout.rows || 24,
  cols: process.stdout.columns || 80,
});

const draw = () => process.stdout.write(screen(model, size()));

const deps = {
  save,
  readFile: (path: string) => readFileSync(path, "utf8"),
  writeFile: (path: string, text: string) => writeFileSync(path, text),
  chain: chainFor,
  fetchImpl: fetch,
  now: Date.now,
};

function dispatch(event: Parameters<typeof update>[1]): void {
  const step = update(model, event);
  model = step.model;
  for (const effect of step.effects) {
    // Fire and forget on purpose: the reducer already marked the model busy, and awaiting here
    // would stop the interface redrawing while a chain publish takes ten seconds.
    perform(effect, model.state, deps).then(dispatch);
  }
  if (model.quit) return stop(0);
  draw();
}

let timer: NodeJS.Timeout;

function stop(code: number): void {
  clearInterval(timer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(ALT_SCREEN_OFF);
  process.exit(code);
}

if (!process.stdin.isTTY) {
  console.error("hydra-tui needs a terminal. For scripting, `packages/cli/src/cli.ts` does the same things.");
  process.exit(2);
}

process.stdout.write(ALT_SCREEN_ON);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const key of decode(chunk)) dispatch({ t: "key", key });
});
process.stdout.on("resize", () => dispatch({ t: "resize" }));
timer = setInterval(() => dispatch({ t: "tick", now: Date.now() }), TICK_MS);

// Restoring the terminal is not optional. A process that exits from the alternate screen with
// the cursor hidden leaves the user's shell unusable, and "it crashed" is not a reason for that
// to happen to them.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(0));
process.on("uncaughtException", (e) => {
  clearInterval(timer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(ALT_SCREEN_OFF);
  console.error(e);
  process.exit(1);
});

draw();
