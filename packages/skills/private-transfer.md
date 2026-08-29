---
name: strk20-private-transfer
description: What a STRK20 private transfer inside the privacy pool hides and what it reveals, and to which party — including the recipient address that channel opening publishes in plaintext. Use when designing, reviewing or explaining a pool-internal transfer, when reasoning about the anonymity set, or when writing user-facing copy about private payments.
---

# Private transfer — hidden versus visible

Read from `starkware-libs/starknet-privacy` at `980da8affafb9f8350975ca93c03b2299a31ac9b`.
Every claim below is either cited to a file and line in that tree, or marked **UNKNOWN**.

## The headline

A pool-internal transfer hides **amounts, balances and the link between a note and its
spend** from the public. It does **not** hide the *shape* of the transfer, and the first
transfer to a new counterparty **publishes that counterparty's address in plaintext**
because opening a channel appends to their storage vector by address.

Against anyone holding the viewing key — the auditor always, the discovery operator after
one sync, the proving operator with every transaction — a private transfer hides nothing
at all.

## The flow, as the contract executes it

Client actions execute in a fixed phase order (`packages/privacy/src/actions.cairo:275-315`):

1. **`OpenChannel`** — once per (sender, recipient) pair. Produces three server actions:
   an `Append` of the ECDH-encrypted channel info to the recipient, and two write-once
   storage writes (`packages/privacy/src/privacy.cairo:362-431`). The channel key is
   encrypted to the recipient's public key, along with the sender's address
   (`packages/privacy/src/utils.cairo:191-204`, `packages/privacy/src/objects.cairo:31-40`).
2. **`OpenSubchannel`** — once per (channel, token). Two write-once writes; the token is
   masked by a hash of the channel key, index and salt (`privacy.cairo:435-482`,
   `utils.cairo:113-126`).
3. **`UseNote`** — for each input note. Verifies ownership, decodes the amount, and
   produces a nullifier plus `EmitNoteUsed` (`privacy.cairo:587-632`).
4. **`CreateEncNote`** — for each output note. The amount is masked into a packed felt:
   `packed_value = pack(salt, h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt) + amount)`
   (`privacy.cairo:637-671`, `utils.cairo:293-306`).
5. Balance conservation is asserted inside the compile step, not published
   (`privacy.cairo:310`).
6. The invocation goes to the proving service, and the wallet submits `apply_actions`.

## What lands on chain, in plaintext

- **The recipient's address.** `ServerAction::Append(AppendInput { recipient_addr,
  enc_channel_info })` (`privacy.cairo:417`, `actions.cairo:327-334`) is part of the
  `apply_actions` calldata (`sdk/src/internal/private-transfers.ts:130`), and
  `_apply_append` uses it as the storage map key (`privacy.cairo:962-965`). A public
  observer of a channel-opening transaction learns *which address is being paid*. The
  sender's address is not in that action — it is encrypted to the recipient — but the fee
  payer is visible (below), so without a paymaster the pair is linkable.
- **The number of inputs and outputs.** One `NoteUsed { nullifier (indexed) }` per input
  (`packages/privacy/src/events.cairo:102-107`) and one `EncNoteCreated { note_id
  (indexed), packed_value }` per output (`events.cairo:93-100`). Values are masked; the
  counts are not. The fan-in/fan-out shape of every transfer is public.
- **The fee payer.** `collect_fee` pulls `fee_amount` STRK from `get_caller_address()`
  (`privacy.cairo:845-856`). Upstream recommends a paymaster "to avoid leaking sender
  info" (`README.md:7`) — that recommendation exists because otherwise the submitter is
  linked to the transaction.
- Storage addresses and masked values for the write-once actions. Opaque without the key.
- **No ERC-20 movement.** A pure internal transfer emits no `Deposit` and no `Withdrawal`
  and produces no `TransferFrom`/`TransferTo`, so no token amount is visible.

## Why the public cannot link a note to its spend

`note_id = h(NOTE_ID_TAG, channel_key, token, index, 0)`
(`packages/privacy/src/hashes.cairo:200-210`) and
`nullifier = h(NULLIFIER_TAG, channel_key, token, index, 0, owner_private_key)`
(`hashes.cairo:224-236`). The nullifier includes the owner's private key, so the two
values cannot be connected without it. **Anyone holding the key computes both** and links
every spend to every note it came from — the property is unlinkability to the public, not
unlinkability as such.

## Hidden versus visible, by party

| Fact | Public observer | Other pool users | Discovery operator | Proving operator | Auditor |
|---|---|---|---|---|---|
| That a pool transaction happened | **Visible** | Visible | Visible | Visible | Visible |
| Amounts (`utils.cairo:293-306`) | Hidden | Hidden | **Visible** | **Visible** | **Visible** |
| Recipient address, on channel opening (`privacy.cairo:417`) | **Visible** | Visible | Visible | Visible | Visible |
| Recipient address, on later transfers in an existing channel | Hidden | Hidden | Visible | Visible | Visible |
| Sender address (`utils.cairo:191-204`) | Hidden | Hidden, except the recipient | **Visible** | **Visible** | **Visible** |
| Token (`utils.cairo:113-126`) | Hidden | Hidden | Visible | Visible | Visible |
| Which note was spent (`hashes.cairo:224-236`) | Hidden | Hidden | Visible | Visible | Visible |
| Number of inputs and outputs (`events.cairo:93-107`) | **Visible** | Visible | Visible | Visible | Visible |
| Your full channel graph — who you pay and who pays you | Hidden | Hidden | **Visible** | **Visible** | **Visible** |
| Fee payer, unless a paymaster is used (`privacy.cairo:845-856`) | **Visible** | Visible | Visible | Visible | Visible |

**The auditor can always decrypt.** The pool encrypts every user's private viewing key to
the auditor key held in its own storage, at registration, unconditionally, write-once,
with no rotation available to the user (`privacy.cairo:319-345`, `utils.cairo:224-233`,
`findings/01-escrow.md`). The auditor therefore holds exactly the key the discovery
service asks for, and can perform exactly the same decryption. The mainnet and Sepolia
auditor keys are non-zero and differ from each other (`findings/06`), so a Sepolia test
does not exercise the mainnet trust assumption.

The "discovery operator" column is not hypothetical: the SDK sends the private viewing
key in the request body and the service decrypts server-side, returning `sender_addr`,
`token`, `amount`, `salt` and `note_id` as plaintext
(`sdk/src/internal/indexer-discovery.ts:160-166`, `:58-67`;
`crates/discovery-service/src/api/validators.rs:236-246`; `findings/02`).

The "proving operator" column is established the same way: the invocation is
`compile_actions(user_address, user.viewingKey, actions)`
(`sdk/src/internal/proof-invocation-factory.ts:132-136`) and is sent whole as the
`transaction` parameter of `starknet_proveTransaction`
(`sdk/src/internal/proving-service.ts:282-293`).

## Keeping the key on the client is practical

`ContractDiscoveryProvider` does traversal and decryption client-side; the viewing key
never leaves the process (`sdk/src/internal/contract-discovery.ts:386`). It is importable
from `@starkware-libs/starknet-privacy-sdk/testing` — the problem is signposting, not
access (`sdk/src/index.ts:34`, `findings/02`).

Measured on Mocknet: ~2 RPC calls per note, linear, no duplicate calls, and 1–3 seconds
at a 1,920-note history with `{ rateLimit: { concurrency: 32 } }`. Omitting `rateLimit`
gives no throttling at all (715 concurrent calls); `rateLimit: {}` defaults to
concurrency 8 and takes ~18.6 seconds. Both defaults are wrong; pass 32–64
(`sdk/src/internal/contract-discovery.ts:388`, `findings/07`). Cost tracks **counterparty
count** more than volume.

This removes the discovery operator from the table. It does not remove the prover or the
auditor.

## UNKNOWN

- **The anonymity-set size.** Publicly, a spend is unlinkable to its note, so the set is
  bounded by the pool's live unspent notes — but the actual number depends on chain state
  and on timing and amount correlation, and is not a property of the source. Compute it;
  do not assert it. This is what `what_does_this_leak` exists to do (HANDOFF Phase F).
- **The hosted proving-service and discovery-service URLs.** Not published anywhere in
  upstream at this commit (`demo/.env.mainnet.example:13-15` are literal `TODO_`
  placeholders). Use `resolve_endpoints`; ask StarkWare (HANDOFF §6 q5).
- **Whether OHTTP is enabled on StarkWare's hosted deployment, and whether a relay is
  operated.** `OHTTP_ENABLED` defaults to `false` server-side, and without a relay the
  client talks to the gateway directly (`findings/02`).
- **Whether the deployed pool is the audited code.** The published class hash matches
  neither deployment (`findings/06`); `pool_state` surfaces it.
- **Wallet-API applications.** If the app uses the Starknet Wallet API rather than the
  SDK, the discovery and OHTTP decisions are made inside the wallet, where the app
  developer neither controls nor observes them, and static analysis cannot see them
  (`findings/08`).

## What to do

- Never claim "private transfer" without naming the parties it is private *from*. The
  honest claim is: private from other users and from chain observers; not private from
  the auditor, nor from any discovery or proving service you use.
- Treat the first transfer to a new counterparty as a public disclosure of that
  counterparty's address, and plan around it (batching, pre-opened channels, paymaster).
- Do not carry message content or identity under keys derived from the pool viewing key.
  The pool can give unlinkability and settlement; it cannot give confidentiality against
  the auditor (`findings/01`).
- Prefer `ContractDiscoveryProvider` with `{ rateLimit: { concurrency: 32 } }`. Standing
  rule 7: self-hosting the indexer changes who the operator is, not that there is one.
