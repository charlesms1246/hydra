# Phase B1 — client-side discovery cost

Produces `findings/07-client-discovery-cost.md`. Runs entirely in memory: no chain, no Cairo
toolchain, no proving service, no network.

## Prerequisites

Node >= 24, and the upstream SDK built from the clone at `../../../.upstream/sdk`:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
cd ../../../.upstream/sdk && npm ci && npm run build
```

The SDK builds without scarb — its generated files are committed.

## Run

```bash
npm install
node sweep.mjs       # scaling: notes, senders, tokens, combined  -> results.json
node ratelimit.mjs   # concurrency/latency tradeoff               -> results-ratelimit.json
```

Deterministic: `sweep.mjs` reports 520 calls at 256 notes and 3,529 at 1,920 on every run.

## Reading the output

- **`calls`** — total RPC calls. Bandwidth and rate-limit cost.
- **`rounds`** — sequential RPC depth, computed as `(elapsed - compute) / DELAY_MS` with a
  separate `DELAY=0` pass to isolate compute. Wall clock is approximately `rounds x RTT`,
  **not** `calls x RTT`, because discovery fans out. Do not simplify this to `elapsed / DELAY`:
  that inflated the figure ~80x and made the path look unusable.
- **`maxConc`** — peak concurrent calls. This is what a public RPC provider will refuse.
- **`dups`** — duplicate calls. Zero in every configuration measured.

The largest configuration (12 senders x 10 tokens x 16 notes = 1,920 notes) deliberately mirrors
`sdk/tests/internal/parallel-discovery.test.ts` so the figures can be cross-checked upstream.
