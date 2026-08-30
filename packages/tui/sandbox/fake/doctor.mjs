/**
 * `check()` without probing the machine.
 *
 * The real one runs five synchronous execFileSync probes plus a git rev-parse. Here the
 * rows are declared, so the `broken` scenario can hand the Tools rig a genuinely fixable
 * row — the state this machine cannot reach once it is fully provisioned, and the reason
 * the "i on a fixable row" check in render.mjs reports SKIP.
 */

import { world } from "../state.mjs";

export { upstreamPath, report } from "../../../cli/src/doctor.mjs";

const OK = "ok  ";
const BAD = "MISS";
const WARN = "WARN";

const ROWS = [
  { name: "node", want: ">= 24", got: "24.18.0" },
  { name: "scarb", want: "2.18.0", got: "2.18.0" },
  { name: "snforge", want: "0.63.0", got: "0.63.0" },
  { name: "universal-sierra-compiler", want: "any", got: "2.10.0" },
  { name: "starknet-devnet", want: "0.8.0-rc.3", got: "0.8.0-rc.3",
    breaks: true, cmd: "mkdir -p ~/.local/bin && curl -fsSL https://github.com/0xSpaceShard/starknet-devnet/releases/download/v0.8.0-rc.3/starknet-devnet-x86_64-unknown-linux-gnu.tar.gz | tar -xz -C ~/.local/bin" },
  { name: "upstream checkout", want: "980da8affafb", got: "980da8affafb" },
  { name: "artifact: pool", want: "built", got: "present",
    breaks: true, cmd: "scarb build -p privacy -p vesu_lending_anonymizer -p ekubo_swap_anonymizer -p shadow_account_anonymizer" },
  { name: "artifact: discoveryService", want: "built", got: "present",
    breaks: true, cmd: "cargo build --release -p discovery-service" },
  { name: "artifact: sdkDist", want: "built", got: "present" },
  { name: "artifact: clientDist", want: "built", got: "present" },
];

export function check() {
  const w = world();
  const rows = ROWS.map((r) => {
    const broken = w.scenario === "broken" && r.breaks && !w.fixed.has(r.name);
    return {
      status: broken ? BAD : OK,
      name: r.name,
      want: r.want,
      got: broken ? "not found" : r.got,
      hint: r.cmd ?? "no automatic fix — see the hint",
      cmd: broken ? r.cmd : null,
      cwd: null,
    };
  });
  // The machine property the sandbox cannot change, reported the way the real one does.
  rows.splice(5, 0, {
    status: WARN, name: "loopback refuses", want: "ECONNREFUSED", got: "blackholed",
    hint: "sandbox: reported as a warning so the WARN rendering path stays visible.", cmd: null,
  });
  return rows;
}
