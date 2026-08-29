# hydra-leak — `what_does_this_leak(tx)`

Given a described transaction **and the configuration it will run under**, produce a
**disclosure set**: for each party, what they learn — amount, token, counterparty, timing,
addresses in the clear — and how large the anonymity set actually is.

Phase F of HYDRA. Node >= 24, plain `.mjs`, no build step, no dependencies.

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24

node src/cli.mjs --example shield
node src/cli.mjs --example private-transfer
node src/cli.mjs --example shadow-dapp-call
node src/cli.mjs my-tx.json --json
echo '{"actions":[{"type":"transfer"}]}' | node src/cli.mjs -
```

```js
import { whatDoesThisLeak } from "./src/leak.mjs";
const report = whatDoesThisLeak({ actions: [...], config: {...}, observations: {...} });
```

Exit 0 when a report is produced, 2 on bad invocation. There is deliberately **no**
non-zero "this leaks" exit code: a disclosure set is a description, not a verdict.

## Input

```jsonc
{
  "config": {
    "network":   "mainnet" | "sepolia",
    "discovery": "indexer-hosted" | "indexer-self-hosted" | "client",
    "ohttp":     true | false,
    "proving":   "service-hosted" | "service-self-hosted" | "mock"
  },
  "actions": [
    { "type": "register" },
    { "type": "deposit",  "token": "STRK", "amount": "1000" },
    { "type": "transfer", "token": "STRK", "amount": "25", "opensChannel": false },
    { "type": "withdraw", "token": "STRK", "amount": "40", "to": "0x..." },
    { "type": "invoke",   "via": "shadow-account", "dapp": "ekubo", "contract": "0x..." }
  ],
  "observations": { "registeredPoolUsers": 412, "shadowAccountsForDapp": 9 }
}
```

**Every key is optional, and every omission costs you an answer rather than buying you
one.** Omit `config.discovery` and the discovery row is `UNKNOWN`, not "no discovery
service". Omit `opensChannel` and the public counterparty cell is `UNKNOWN`, because
whether a transfer discloses its recipient depends on whether it is the first one into
that channel. `observations` is the only route to an anonymity-set number; there is no
default and nothing is estimated.

## Output vocabulary

| Value | Meaning |
|---|---|
| `CLEAR` | the party learns the value in plaintext |
| `DECRYPTABLE` | the value is on chain encrypted and this party holds a key that opens it |
| `NOT_DISCLOSED_BY_THIS_TX` | **this transaction** does not put the value where the party can read it, by the named mechanism |
| `UNKNOWN` | not computable from the input given. **Never a pass** |
| `N/A` | the field does not exist for this action |

There is no value meaning "private". `NOT_DISCLOSED_BY_THIS_TX` is scoped to one
transaction and always carries the mechanism that makes it true; it says nothing about
correlation across transactions, off-chain side channels, or what a party already knew.
Every report repeats this as a `[scope]` note.

## Parties

The four Phase F names, plus two the source forces into the table.

| Party | Why it is here |
|---|---|
| public chain observer | events, storage state diffs, and the public call trace |
| other pool users | holding notes grants no extra read access — identical to the public observer |
| the counterparty | a transfer's recipient is *told* the amount, token and sender; that is what a transfer is |
| discovery service operator | receives the private viewing key when the indexer path is used (`findings/02`) |
| **proving service operator** | **not in the Phase F list.** See below |
| the auditor | **always `DECRYPTABLE`, every field, every action, every configuration** (`findings/01`) |

### The auditor row

Enforced by an invariant test, not by convention: `test/run.mjs` asserts that for every
case, every action, every field, the auditor cell is `DECRYPTABLE`. No configuration
changes it, because `auditor_public_key` is read from contract storage rather than user
input, `random.is_non_zero()` blocks neutralisation, and both writes go through
`to_write_once_action` (`findings/01`). Both live pools return a non-zero auditor key, so
this is operative and not a dormant code path (`findings/06`).

### The proving service row — a party no finding covers yet

`ProofInvocationFactory` compiles the `compile_actions` calldata as
`[userAddress, user.viewingKey, ...clientActions]`
(`upstream:sdk/src/internal/proof-invocation-factory.ts:132-136`) and
`ProvingService.proveTransaction` POSTs that invocation to the proving service
(`upstream:sdk/src/internal/proving-service.ts:282-294`). So a hosted prover receives the
user's address, their **private viewing key**, and every action of the transaction in
plaintext — the same disclosure `findings/02` documents for the indexer, on a path a
developer must use to reach a real chain at all.

This is read from upstream source at `980da8af`, is not yet written up in `findings/`, and
is cited to `upstream:file:line` rather than to a finding. It is included because omitting
a party that receives the root viewing key would be exactly the false reassurance this
tool exists to prevent. **It should become a finding.**

## Anonymity set

Reported per action, and `UNKNOWN` unless actually computed. Three outcomes only:

1. **Derived from the action's structure.** A deposit's `user_addr` and a registration's
   `user_addr` are indexed event fields, so the set is **1** — computed, not estimated.
   A deposit is not an anonymising action.
2. **Supplied by the caller** under `observations`, echoed back with its provenance
   attached and labelled an upper bound on the crowd only.
3. **`UNKNOWN`**, with the basis stating exactly what would have to be measured: for a
   transfer or withdrawal, the count of registered pool users holding a comparable balance
   of that token at that block; for a shadow-account call, the count of distinct shadow
   accounts that anonymizer deployed for that dapp in a comparable window.

`findings/03` is why this matters: a shadow account is unlinkable only within the crowd
using the same dapp through the same anonymizer, so an uncomputed anonymity set is the
difference between a real property and a slogan. An invariant test asserts that any
numeric size traces to case 1 or case 2.

## Citations

Every cell, every anonymity-set entry and every note carries a `cites` array, checked by
an invariant test — the tool cannot emit an uncited claim.

- `findings/NN-*.md` — this repository's write-ups.
- `upstream:path:line` — `starkware-libs/starknet-privacy` at
  `980da8affafb9f8350975ca93c03b2299a31ac9b`, cited directly where no finding covers the
  claim yet.

## What the source says that the findings did not

Two disclosures came out of reading upstream for this package and are not in `findings/`:

**Opening a channel discloses the recipient.** `OpenChannel` produces an `Append` server
action, and `_apply_append` pushes into `recipient_channels: Map<ContractAddress,
Vec<EncChannelInfo>>` — a storage map keyed by the **plaintext recipient address**
(`upstream:packages/privacy/src/privacy.cairo:90,962-965`). `get_num_of_channels(recipient_addr)`
is a public view over it (`:1078-1080`). So anyone can ask, for any address, how many
channels have been opened to it, and watch that count increment in a given block. The
*sender* is not disclosed. This fires only on the first transfer into a channel, which is
why `opensChannel` is an input and why omitting it yields `UNKNOWN`.

**Invoke calldata is public by design.** The pool does not emit calldata in
`ExternalContractInvoked` — and says why: *"calldata is intentionally not emitted, as it is
already visible in the public call trace"* (`:989`). So amounts and addresses inside a dapp
call are public. This tool does not parse calldata, so it reports those fields `UNKNOWN`
unless you declare them, rather than inferring them.

## Limits — read before quoting the output

- **Single transaction only.** No correlation analysis across transactions. Amount, timing
  and token correlation shrink every anonymity set reported here, by an amount this tool
  does not compute.
- **No chain access.** Nothing is read from a live pool. Deployment facts (pool addresses,
  auditor and screener keys) are the values `findings/06` recorded on 2026-08-29 and may
  have drifted.
- **Calldata is not parsed.** See above.
- **The screener is out of scope.** A regular-pool deposit requires a screening attestation
  covering the depositor (`upstream:packages/privacy/src/privacy.cairo:858-876`), and both
  live pools return a non-zero screener key. What that path discloses has not been
  examined; a report containing a deposit says so as an `[unknown]` note.
- **The RPC endpoint is not modelled.** Client-side discovery contacts no discovery
  service, but the RPC provider you traverse through still sees the call pattern and your
  IP. The `client` row says so; it does not quantify it.
- **Self-hosting is not modelled as a fix.** `indexer-self-hosted` and
  `service-self-hosted` produce the same `CLEAR` cells as the hosted variants, with a note
  that self-hosting changes who the operator is and not what is disclosed — standing rule 7.

## Tests

```bash
npm test          # or: node test/run.mjs
```

Nine expectation cases plus five invariants. The invariants are the point: the auditor row
is `DECRYPTABLE` everywhere; no claim is uncited; no anonymity-set number exists without a
derivation or a caller observation; the output never contains a bare "is private" / "is
safe" claim; unrecognised input is surfaced as a problem rather than silently dropped.

The case that matters most is `nothing declared: config absent` — a transfer with no
configuration at all, which must return `UNKNOWN` for the discovery, prover, public
counterparty and anonymity-set cells while still stating the auditor row. A tool that
answered that case reassuringly would be worse than no tool.
