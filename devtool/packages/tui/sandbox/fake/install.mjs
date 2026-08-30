/**
 * `runFix` without running a build.
 *
 * `fixable` and `describeFix` are pure and are re-exported from the real module —
 * only the half that shells out is replaced. The fake streams plausible output over a
 * few seconds so the confirm → run → rescan path can be felt at real speed, and then
 * marks the row fixed in the world so the Tools rig visibly changes.
 */

import { world } from "../state.mjs";

export { fixable, describeFix } from "../../../core/src/install.mjs";

const OUTPUT = [
  "  Downloading 0xspaceshard/starknet-devnet",
  "  Compiling starknet-devnet v0.8.0-rc.3",
  "  Finished `release` profile [optimized] target(s)",
];

export function runFix(row, onLine = () => {}) {
  const w = world();
  return new Promise((resolve) => {
    onLine(`$ ${row.cmd}`);
    let i = 0;
    const timer = setInterval(() => {
      if (i < OUTPUT.length) return onLine(OUTPUT[i++]);
      clearInterval(timer);
      w.fixed.add(row.name);
      w.note(`fixed ${row.name} (sandbox)`);
      resolve({ ok: true, code: 0 });
    }, 700);
  });
}
