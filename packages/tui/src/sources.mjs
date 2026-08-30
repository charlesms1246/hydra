/**
 * The polling scheduler, and the only file in the TUI that calls @hydra/core.
 *
 * The old refresh() re-fetched everything every 2 seconds regardless of what was
 * on screen, and on the transact tab that meant a real SDK discoverNotes() —
 * transact.mjs:25 → control.mjs:131-144, a 180-second-timeout round trip — twice
 * every two seconds, unattended. Here each source declares its own cadence and
 * its own gate, holds a single-flight guard so a slow call can never overlap
 * itself or land out of order, and keeps its last good value with a visibly
 * climbing age when a call fails.
 *
 * TUI/CLI parity is auditable by reading this one file: `blocks` takes the same
 * HYDRA_BLOCKS default as agentcmds.mjs:116, which the old app.mjs:82 did not.
 */

import { React } from "./ui.mjs";
import { status } from "../../core/src/services.mjs";
import { wallets } from "../../core/src/wallets.mjs";
import { latestBlocks } from "../../core/src/chain.mjs";
import { check } from "../../cli/src/doctor.mjs";

const { useState, useRef, useEffect, useCallback } = React;

const SOURCES = {
  status: {
    cadenceMs: 2000,
    gate: () => true,
    fn: () => status().catch(() => null),
  },
  blocks: {
    cadenceMs: 3000,
    // The overview shows recent chain activity too, so it needs this as well.
    gate: (ctx) => (ctx.page === "activity" || ctx.page === "overview") && ctx.up,
    fn: () => latestBlocks(Number(process.env.HYDRA_BLOCKS ?? 8)).catch(() => null),
  },
  wallets: {
    // wallets.mjs:39-46 is one awaited RPC per account per token, serially — six
    // round trips on a three-account devnet. It does not belong on a 2s timer.
    cadenceMs: 5000,
    gate: (ctx) => (ctx.page === "wallets" || ctx.page === "overview") && ctx.up,
    fn: () => wallets().catch(() => null),
  },
  doctor: {
    // Never on a timer. check() is five synchronous execFileSync probes plus a
    // git rev-parse; it blocks the Ink event loop, so it runs on first entry to
    // the tools rig and on `r`, and nowhere else. There is no spinner because a
    // blocked event loop cannot animate one — the visible pause is the signal.
    cadenceMs: null,
    gate: (ctx) => ctx.page === "tools" || ctx.page === "overview",
    fn: async () => {
      try { return { rows: check() }; } catch (e) { return { rows: [], error: e.message }; }
    },
  },
};

export function useSources(page) {
  const [data, setData] = useState({});
  const [ages, setAges] = useState({});
  const inflight = useRef({});
  const lastRun = useRef({});
  const ctx = useRef({ page, up: false });
  ctx.current.page = page;

  const run = useCallback(async (name) => {
    const src = SOURCES[name];
    if (!src || inflight.current[name]) return;
    inflight.current[name] = true;
    // Shared with the tick below, so a fetch issued on entering a region does not
    // get repeated by the timer a fraction of a second later. `wallets` is six
    // serial RPC round trips; it must not run twice for one keypress.
    lastRun.current[name] = Date.now();
    try {
      const v = await src.fn();
      setData((d) => ({ ...d, [name]: v }));
      setAges((a) => ({ ...a, [name]: Date.now() }));
      if (name === "status") ctx.current.up = Boolean(v?.devnet?.up);
    } finally {
      inflight.current[name] = false;
    }
  }, []);

  // One timer for everything. Per-source cadence is a modulo of the tick, so a
  // slow source can never starve a fast one and there is one thing to stop.
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      for (const [name, src] of Object.entries(SOURCES)) {
        if (src.cadenceMs === null) continue;
        if (!src.gate(ctx.current)) continue;
        if (now - (lastRun.current[name] ?? 0) < src.cadenceMs) continue;
        run(name);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [run]);

  // Every gated source fires the moment its region opens, not on the next tick.
  // Waiting for the shared 1s tick meant entering the wallets or activity rig
  // showed a bare "loading…" for up to a full second before the first fetch was
  // even issued. `data[name] === undefined` keeps it to once — a failed fetch
  // stores null, not undefined, so this cannot become a retry loop.
  useEffect(() => {
    for (const [name, src] of Object.entries(SOURCES)) {
      if (src.gate(ctx.current) && data[name] === undefined) run(name);
    }
  }, [page, run, data]);

  const staleness = useCallback(
    (name) => (ages[name] ? Math.round((Date.now() - ages[name]) / 1000) : null),
    [ages]
  );

  return { data, ages, refresh: run, staleness, SOURCES };
}
