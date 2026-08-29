---
name: strk20-shield-deposit
description: What a STRK20 privacy-pool shield (deposit) hides and what it reveals, and to which party. Use when designing, reviewing or explaining a deposit into the Starknet privacy pool, when a user asks whether depositing is private, or when writing user-facing copy about entering the pool.
---

# Shield / deposit — hidden versus visible

Read from `starkware-libs/starknet-privacy` at `980da8affafb9f8350975ca93c03b2299a31ac9b`.
Every claim below is either cited to a file and line in that tree, or marked **UNKNOWN**.

## The headline

**A deposit is not private.** It is the least private action in the protocol. Your address,
the token and the exact amount are emitted as a plaintext event and are also plainly
visible in the transaction calldata. What the pool gives you starts *after* the deposit:
the movement of the resulting note is private, the entry is not.

If you are writing copy, "shielding" should not be described as hiding the deposit. It
hides what happens next, from some parties, and never from the auditor.

## The flow, as the contract executes it

1. **First time only — `SetViewingKey`.** The user supplies exactly one field, a random
   felt (`packages/privacy/src/actions.cairo:11-16`), which must be non-zero
   (`actions.cairo:18-23`). The pool derives the public key and encrypts the user's
   **private** viewing key to the auditor key it reads from its own storage
   (`packages/privacy/src/privacy.cairo:319-345`). Both writes are write-once, so
   registration cannot be repeated or undone.
2. **`Deposit`.** Compiles to `TransferFrom(from_addr = user_addr, token, amount)` plus
   `EmitDeposit { user_addr, token, amount }` (`privacy.cairo:486-503`).
3. **A note to hold the funds.** In the same transaction the user opens a channel and
   subchannel to themselves if needed and creates a note
   (`privacy.cairo:362-431`, `435-482`, `637-671`). The SDK's `deposit(token, amount)`
   documents that in v1 the recipient is the depositor themselves or a pre-arranged note
   (`sdk/src/interfaces.ts:384-388`).
4. **Proving.** The whole client transaction — including `user_private_key` in the
   `compile_actions` calldata — is sent to a proving service. See "The prover" below.
5. **Submission.** The wallet submits `apply_actions(server_actions, screening)` to the
   pool (`sdk/src/internal/private-transfers.ts:125-133`). The pool charges
   `fee_amount` STRK from `get_caller_address()` (`privacy.cairo:845-856`).

## What lands on chain, in plaintext

- `Deposit { user_addr (indexed), token (indexed), amount }` — `packages/privacy/src/events.cairo:30-40`.
  The amount is a plain `u128`. Nothing here is encrypted or hashed.
- The `TransferFrom` server action itself, carrying `from_addr`, `token` and `amount`,
  is part of the `apply_actions` calldata (`actions.cairo:336-345`,
  `private-transfers.ts:130`). Even without the event, the deposit is legible.
- `ViewingKeySet { user_addr (indexed), public_key (indexed), enc_private_key }` on first
  registration — `events.cairo:4-14`. The escrowed ciphertext is public; only the auditor
  can open it.
- The submitting account address, because it pays the STRK fee (`privacy.cairo:845-856`).
  Upstream's own architecture note recommends a paymaster "to avoid leaking sender info"
  (`README.md:7`) — meaning that without one, the fee payer is linked to the transaction.

## Hidden versus visible, by party

| Fact | Public observer | Other pool users | Discovery operator | Proving operator | Screening provider | Auditor |
|---|---|---|---|---|---|---|
| That you deposited (`events.cairo:30-40`) | **Visible** | Visible | Visible | Visible | Visible | Visible |
| Your address (`events.cairo:33-34`) | **Visible** | Visible | Visible | Visible | **Visible — it is the screened field** | Visible |
| Token and exact amount (`events.cairo:36-39`) | **Visible** | Visible | Visible | Visible | Visible | Visible |
| Your private viewing key (`privacy.cairo:319-345`) | Hidden (ciphertext only) | Hidden | **Disclosed on first sync** | **Disclosed with the invocation** | Not disclosed | **Disclosed, mandatorily and forever** |
| Which note the deposit funded, and its later movement | Hidden | Hidden | Visible once synced | Visible | Not disclosed | **Visible** |
| Your submitting account, unless a paymaster is used (`README.md:7`) | **Visible** | Visible | Visible | Visible | Visible | Visible |

**The auditor can always decrypt.** `auditor_public_key` is read from contract storage,
never supplied by the user; the encryption is unconditional; both storage writes are
write-once; and the ephemeral secret is asserted non-zero so the obvious neutralisation is
rejected (`privacy.cairo:319-345`, `actions.cairo:18-23`,
`packages/privacy/src/utils.cairo:224-233`). There is no opt-out, no substitution, no
rotation available to the user. `findings/01-escrow.md`.

`pool_state(network)` in the HYDRA MCP server confirms this is live rather than dormant:
the auditor key is non-zero on both mainnet and Sepolia (`findings/06`).

## The three parties that receive the key, not two

`findings/01` establishes the auditor and `findings/02` the discovery service. A deposit
adds a third, established from source here:

- **The proving service.** `ProofInvocationFactory.create` compiles the invocation as
  `compile_actions(user_address, user.viewingKey, actions)`
  (`sdk/src/internal/proof-invocation-factory.ts:132-136`), and that whole invocation is
  sent to the prover as the `transaction` parameter of `starknet_proveTransaction`
  (`sdk/src/internal/proving-service.ts:282-293`). `ViewingKey` is the private scalar —
  the discovery service proves this by deriving the registered public key from the same
  value (`crates/discovery-service/src/api/validators.rs:236-246`, `findings/02`).
  OHTTP is available on this path too (`proving-service-provider.ts:74-80`) and, exactly
  as for the indexer, it hides the client IP from the prover and not the key.
- **Your RPC node, if you use `simulate()` or the mock prover.**
  `CallMockProofProvider` sends the same calldata to `node.callContract` or
  `channel.simulateTransaction` (`sdk/src/internal/mock-proving.ts:139-152`, `173-186`).
  A public RPC endpoint is then a fourth holder of the key. This is easy to do by
  accident, because `simulate()` is a documented API and configuring a public endpoint is
  the normal thing to do.

## Screening: a fifth party, on this flow specifically

Deposits are the action that triggers screening. `_apply_actions` marks a `TransferFrom`'s
`from_addr` as the screening subject (`privacy.cairo:873-876`), and `apply_actions`
requires a matching attestation signed by the pool's `screener_public_key`
(`privacy.cairo:784-803`, `921-943`).

The attestation is produced operator-side: the proof interceptor runs as a sidecar to the
prover, decodes the deposit action span, and screens `user_addr` against Elliptic's AML
API via an HMAC-signed `POST /screen` to `elliptic-proxy`
(`proof-interceptor/README.md:3`, `:37`, `:43`). So a deposit discloses the depositor's
address to a commercial sanctions provider, and the client cannot see this happen —
upstream states screening is "invisible from the outside", surfacing only as JSON-RPC
error `10000` when blocked (`proof-interceptor/README.md:5`).

`get_screener_public_key` is non-zero on both mainnet and Sepolia (`findings/06`), so this
path is configured on the live pools.

## UNKNOWN

- **The hosted proving-service and discovery-service URLs.** Not published anywhere in
  upstream at this commit; `demo/.env.mainnet.example:13-15` leaves both as literal
  `TODO_` placeholders. Do not guess — use `resolve_endpoints`, and ask StarkWare
  (HANDOFF §6 q5).
- **Who holds the auditor private key on mainnet, and under what policy.** Not answerable
  from source (`findings/01`).
- **Whether the deployed pool is the audited code.** The class hash published in the
  compatibility matrix matches neither deployment (`findings/06`); `pool_state` surfaces
  the discrepancy.
- **Whether a relay is actually operated for OHTTP.** Without one the client talks to the
  gateway directly and OHTTP buys close to nothing (`findings/02`).
- **What the screening provider retains**, and for how long. Outside the repository.

## What to do

- Do not describe a deposit as private in user-facing copy. Describe it as the public
  entry point to a pool whose *internal* movements are private from the public.
- Assume the deposit address is permanently linked to the pool position it funds, for
  anyone holding the viewing key — which is at least the auditor.
- Use a paymaster if the submitting account should not be linked (`README.md:7`).
- Do not point `simulate()` at an endpoint you would not hand the user's viewing key to.
- Run `lint_config` on the integration: the documented `createPrivateTransfers({
  discoveryProvider: { url } })` path gives you no OHTTP at all (`sdk/src/factory.ts:108`,
  `findings/02`).
