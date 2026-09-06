# HYDRA

**A local STRK20 privacy stack, and tooling that computes what a transaction actually discloses.**

Building on the Starknet privacy pool normally means pointing at two hosted services you do
not control. HYDRA runs the whole thing locally — devnet, the pool deployed from source, funded
accounts, a local discovery service — and then tells you, per transaction and per
configuration, exactly who learns what.

Nothing it reports is asserted. Every claim is computed from the pool source or measured, and
carries a `file:line` citation.

## Quick start

Requires **Node >= 24** and `git`. HYDRA does not vendor the privacy pool — it drives a
checkout of [`starknet-privacy`](https://github.com/starkware-libs/starknet-privacy) pinned to
one commit. That pin has a single source of truth, `UPSTREAM_SHA` in
`devtool/packages/cli/src/pins.mjs`, and `hydra-dev doctor` prints the clone command with it already
filled in, so it is not repeated here.

```bash
# 1. HYDRA itself. The published package is `hydra-devtool`; until it is published,
#    run it from a clone.
git clone https://github.com/charlesms1246/hydra.git && cd hydra/devtool

# 2. its own dependencies. `npx` finds the binaries this links; nothing goes on your PATH.
npm install

# 3. everything else. `up` clones the pool source at the pinned revision, builds it, and
#    starts devnet + pool + funded accounts + local discovery service. It ASKS before each
#    third-party toolchain install and shows the command first — `--yes` consents in advance,
#    and with no terminal it refuses rather than assuming.
npx hydra-dev up
```

Then `npx hydra-dev` for the TUI, and `npx hydra-dev doctor` for the fifteen-row table if you
want to see what it found. `doctor` is still the honest starting point when something is wrong —
it prints the exact fix for every row — but you no longer have to run it first to be told what
`up` was about to do anyway.

`hydra-dev doctor` is the honest starting point, and how many rows it prints tells you where you
are: **nine** before the checkout exists — six pinned tools, one property of the machine, the
checkout itself, and whether the prebuilt-artifacts package is installed —
and **fifteen** once it does, adding the six build artifacts. It
prints the exact command for anything missing, and needs no dependencies itself, so it works
before `bootstrap` does.

## The TUI

```
hydra-dev
```

It opens on the mark while it probes the machine — the outline fills cyan from the centre as
each source reports in, then seals red once they all have — and then on an **overview
dashboard**: the stack, the chain, the toolchain, your wallets, what this session has run, and
the standing note that the auditor can decrypt all of it.

Every page is on the nav bar along the bottom. The page you are on is filled in; the rest are
outlined, each with the key that opens it.

| Key | Page |
|---|---|
| **o** | **Overview** — the dashboard: stack, chain, tooling, wallets, recent runs |
| **b** | **Wallets** — test accounts, balances, and the devnet faucet (`m` mints) |
| **c** | **Activity** — recent blocks, and `enter` twice reaches a transaction receipt |
| **f** | **Disclosure** — the matrix: six parties x five fields, every cell, for the last flow |
| **x** | **Run** — shield, register, private transfer; `enter` previews what each will disclose |
| **t** | **Tools** — the doctor rows, and it can run the fixes (each confirmed first) |
| **j** | **Build** — the contract and Cairo-test operations, read from the checkout's manifests |
| **l** | **Log** — the live output of whatever is running |
| **g** | **About** — what this is, why it exists, and every binding, in six sections |

**Nothing needs a modifier key.** `w a s d` and the arrows are movement and only movement —
`a`/`d` and `←`/`→` walk the nav bar, `enter` opens what the cursor is over, and `w`/`s` and
`↑`/`↓` move inside the page. That is why the page letters are `o b c f x t j l g`: binding `w`
to Wallets as well would make one key mean two things depending on where you were.

`u` starts the stack, `p` stops it, `r` refreshes, `esc` goes back, `q` quits — and quitting
asks what to do with a running stack, because leaving devnet and the discovery service up is
the right answer when you are about to run `hydra-dev status`, and the wrong one when you are done.

Every screen fills the terminal and nothing scrolls: pages are laid out to the size they are
given, and where a list is longer than its space it says how many rows it dropped rather than
hiding them behind a scrollbar you have to discover.

The disclosure matrix is the point of the project: it runs a real private transfer against the
local pool and shows, cell by cell, what that disclosed — a public observer learns the *timing*,
the counterparty learns everything, and the auditor can decrypt everything, always. Nothing is
summarised: `not-by-tx` is glossed on screen as *not* a privacy claim — it is scoped to one
transaction and says nothing about correlation across transactions, off-chain side channels or
prior knowledge (`devtool/packages/leak/src/facts.mjs:25-30`) — and `UNKNOWN` is never rendered as a pass.

Two things the matrix says about a local run, because they are true and not flattering:
its `network` is **UNKNOWN** (a devnet is neither mainnet nor Sepolia, so no auditor key is in
force that this tool can name), and the report describes the **declared action shape, not the
receipt** — `hydra-dev tx` returns an event count, not decoded events, so nothing here can check a
report against the transaction it sent.

## For agents

Every page that reads is also a command, and every command takes `--json`: Disclosure is
`hydra-dev leak`, the Overview's stack block `hydra-dev status`, Wallets `hydra-dev wallets`, Activity
`hydra-dev blocks`, Tools `hydra-dev doctor`. Run is the one exception — it submits real transactions
and has no command twin.

```bash
hydra-dev leak transfer --json
hydra-dev status --json
hydra-dev indexer --status --json
hydra-dev wallets --json
hydra-dev tx 0x07f1… --json
```

Human output is a rendering of the same object, so the TUI and an agent cannot disagree.

## Packages

| Package | What it is |
|---|---|
| `core/` | every operation as a plain function returning plain data — zero dependencies |
| `cli/` | the command surface, `hydra-dev up`, doctor, bootstrap, dapp scaffold |
| `tui/` | the terminal UI (Ink) |
| `leak/` | `what_does_this_leak(tx)` — the disclosure set, per party and per field |
| `linter/` | flags SDK configurations that disclose more than intended |

`archive/gui/` holds a browser view of the disclosure matrix; `experiments/` holds the
measurement harnesses behind the numbers quoted here.

## Two things worth knowing before you build on the pool

**The auditor can decrypt everything.** At registration the pool encrypts your private viewing
key to an auditor key held in contract storage. It is mandatory, cannot be opted out of or
substituted, and is write-once. This is true of every STRK20 integration, so HYDRA states it on
every run rather than leaving it to documentation.

**Your viewing key reaches more parties than you may expect.** Which ones depends on your
configuration, and that is precisely what `hydra-dev` and the linter compute for you.

A set of findings documenting this in detail, with source citations and two upstream patches,
is being shared with StarkWare before publication.

## Scaffold a dapp

```bash
hydra-dev init dapp
```

Clones the official STRK20 starter kit and writes `.env.local` pointing at your running stack.
It drives the pool through the **Wallet API**, where the wallet holds the viewing key — a
different route from the SDK, and one the linter cannot see inside.

## Licence

Apache-2.0, matching upstream, so contributions flow both ways. Full text in [`LICENSE`](LICENSE).
