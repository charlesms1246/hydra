# hydra-lint

Flags STRK20 SDK configurations that disclose more than the developer intends.

Every rule states a **disclosure consequence** and cites the finding that established it.
No rule asserts a privacy property; the tool reports only what it can determine.

```bash
node src/cli.mjs <file-or-dir>... [--json]
```

Exit 0 clean or info-only, 1 at warn or above, 2 bad invocation.

## Rules

| Rule | Sev | What it catches | Source |
|---|---|---|---|
| `HYD001` | error | `createPrivateTransfers({ discoveryProvider: { url } })` — the documented path, which **cannot** enable OHTTP and posts the private viewing key | `findings/02` |
| `HYD002` | error | `ohttp: false` on a key-bearing provider | `findings/02` |
| `HYD003` | warn | Any `IndexerDiscoveryProvider` use — the operator receives the viewing key | `findings/02` |
| `HYD008` | warn | `IndexerDiscoveryProvider` built without OHTTP where the option **was** available | `findings/02` |
| `HYD004` | warn | `ContractDiscoveryProvider` with no `rateLimit` — unbounded, measured 715 concurrent calls | `findings/07` |
| `HYD005` | warn | `concurrency <= 8` — measured 18.6s vs 2.8s at 32 | `findings/07` |
| `HYD006` | error | Mainnet and Sepolia pool addresses in one file — different auditors, different classes | `findings/06` |
| `HYD007` | info | The auditor can decrypt this user's history. **Always emitted** when pool usage is detected | `findings/01` |
| `HYD000` | unknown | Config not statically determinable. **Not** a pass | — |

## Two design decisions

**Absence of findings is never a safety claim.** `HYD000` exists so indirection is reported
rather than silently skipped, and the clean-run message says so explicitly. Standing rule 6.

**Severity is calibrated to what the developer could have done.** `HYD001` is an error because
the config path gives no way to enable OHTTP at all — the developer may not know. `HYD008` is a
warning for the constructor form, where the option was available and not taken, which may be a
deliberate opt-out. Upstream's own demo is exactly that case and reporting it as an error was
over-reporting; it was downgraded after being run against real code.

## Parsing

TypeScript compiler API, no type checker — shape-based, single-file, fast. Commented-out code,
template strings and same-named calls on other objects do not fire; there is a fixture for each.
The cost is that cross-module indirection surfaces as `HYD000`.

## Tests

```bash
npm install && npm test
```

Seven fixtures, each declaring exactly which rules must fire — including
`false-positive-bait.ts`, which must produce nothing. A linter that over-reports trains people
to ignore it.
