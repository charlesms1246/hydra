# Phase B1 — client-side discovery cost

Produces `findings/07-client-discovery-cost.md`. Runs entirely in memory: no chain, no Cairo
toolchain, no proving service, no network.

## Prerequisites

Node >= 24, and the upstream SDK built from the clone at `.upstream/`:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
cd .upstream/sdk && npm ci && npm run build
```

The SDK builds without scarb — its generated files are committed.

Both scripts deep-import `sdk/dist/utils/crypto.js` from that clone (`derivePublicKey` is
reachable from no published subpath — see findings/07 "Import surface"). They locate it the way
`packages/cli/src/doctor.mjs` `upstreamPath()` does: `HYDRA_UPSTREAM` if set, then the in-repo
`.upstream/`, then a sibling `../.upstream/`. Paths are resolved from the script's own location,
so cwd does not matter.

## Run

All paths below are from the repo root.

```bash
npm install --prefix experiments/07-client-discovery-cost
node experiments/07-client-discovery-cost/sweep.mjs       # scaling      -> results.json
node experiments/07-client-discovery-cost/ratelimit.mjs   # throttling   -> results-ratelimit.json
```

Both write their JSON next to the script, not into the cwd.

Deterministic: `sweep.mjs` reports 520 calls at 256 notes and 3,529 at 1,920 on every run.
`rounds` is **not** deterministic in either script — see below.

## Reading the output

- **`calls`** — total RPC calls. Bandwidth and rate-limit cost.
- **`rounds`** — sequential RPC depth. Wall clock is approximately `rounds x RTT`, **not**
  `calls x RTT`, because discovery fans out. This is the one column that does **not** reproduce:
  three consecutive runs of `sweep.mjs` gave 191 / 174 / 182 at the 1,920-note row, and
  `ratelimit.mjs` gave 34 / 40 / 68 at `concurrency: 32`. Treat it as an order of magnitude, never
  as a figure. The two scripts also compute it differently: `ratelimit.mjs` runs a separate
  `DELAY=0` pass and reports `(elapsed - compute) / DELAY_MS`, while `sweep.mjs` reports the
  unadjusted `elapsed / DELAY_MS`, which is why they disagree (191 vs 8-23) on the same
  1,920-note configuration.
- **`maxConc`** — peak concurrent calls. This is what a public RPC provider will refuse.
- **`dups`** — duplicate calls. Zero in every configuration measured.

The largest configuration (12 senders x 10 tokens x 16 notes = 1,920 notes) deliberately mirrors
`sdk/tests/internal/parallel-discovery.test.ts` so the figures can be cross-checked upstream.
