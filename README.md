# HYDRA

**A local STRK20 privacy stack, and tooling that computes what a transaction actually discloses.**

Building on the Starknet privacy pool normally means pointing at two hosted services you do
not control. HYDRA runs the whole thing locally — devnet, the pool deployed from source, funded
accounts, a local discovery service — and then tells you, per transaction and per
configuration, exactly who learns what.

Nothing it reports is asserted. Every claim is computed from the pool source or measured, and
carries a `file:line` citation.

## Quick start

Requires **Node >= 24** and a checkout of
[`starknet-privacy`](https://github.com/starkware-libs/starknet-privacy) at
`980da8affafb9f8350975ca93c03b2299a31ac9b`, either at `.upstream/` beside this repo or pointed
at by `HYDRA_UPSTREAM`.

```bash
hydra() { node packages/cli/src/cli.mjs "$@"; }   # or add packages/cli/src/cli.mjs to PATH

hydra bootstrap     # install node dependencies
hydra doctor        # check the toolchain — tells you how to fix whatever is missing
hydra up            # devnet + pool + funded accounts + local discovery service
hydra               # the TUI
```

`hydra doctor` is the honest starting point: it verifies twelve pinned tools and build
artifacts, and prints the exact command for anything missing. It needs no dependencies itself,
so it works before `bootstrap` does.

## The TUI

```
hydra
```

| Pane | What it does |
|---|---|
| **Services** | devnet, indexer, prover, MCP and skills — live |
| **Wallets** | test accounts, balances, and the devnet faucet |
| **Activity** | recent blocks |
| **Tools** | the doctor rows, and it can run the fixes (each confirmed first) |
| **Transact** | shield, register, private transfer — then what that just disclosed |

`u` starts the stack, `d` stops it, `q` quits.

The Transact pane is the point of the project: it runs a real private transfer against the
local pool and shows the disclosure underneath it — a public observer learns the *timing*, the
counterparty learns everything, and the auditor can decrypt everything, always.

## For agents

Every pane is also a command, and every command takes `--json`:

```bash
hydra status --json
hydra indexer --status --json
hydra wallets --json
hydra tx 0x07f1… --json
```

Human output is a rendering of the same object, so the TUI and an agent cannot disagree.

## Packages

| Package | What it is |
|---|---|
| `core/` | every operation as a plain function returning plain data — zero dependencies |
| `cli/` | the command surface, `hydra up`, doctor, bootstrap, dapp scaffold |
| `tui/` | the terminal UI (Ink) |
| `leak/` | `what_does_this_leak(tx)` — the disclosure set, per party and per field |
| `linter/` | flags SDK configurations that disclose more than intended |
| `mcp/` | MCP server exposing endpoints, environment, lint and pool state |

`archive/gui/` holds a browser view of the disclosure matrix; `experiments/` holds the
measurement harnesses behind the numbers quoted here.

## Two things worth knowing before you build on the pool

**The auditor can decrypt everything.** At registration the pool encrypts your private viewing
key to an auditor key held in contract storage. It is mandatory, cannot be opted out of or
substituted, and is write-once. This is true of every STRK20 integration, so HYDRA states it on
every run rather than leaving it to documentation.

**Your viewing key reaches more parties than you may expect.** Which ones depends on your
configuration, and that is precisely what `hydra` and the linter compute for you.

A set of findings documenting this in detail, with source citations and two upstream patches,
is being shared with StarkWare before publication.

## Scaffold a dapp

```bash
hydra init dapp
```

Clones the official STRK20 starter kit and writes `.env.local` pointing at your running stack.
It drives the pool through the **Wallet API**, where the wallet holds the viewing key — a
different route from the SDK, and one the linter cannot see inside.

## Licence

Apache-2.0, matching upstream, so contributions flow both ways.
