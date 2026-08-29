---
name: strk20-withdraw
description: What a STRK20 privacy-pool withdrawal hides and what it reveals, and to which party — the destination and exact amount are public, the origin is encrypted to the auditor specifically. Use when designing, reviewing or explaining an exit from the Starknet privacy pool, or when reasoning about deposit-to-withdrawal correlation.
---

# Withdraw — hidden versus visible

Read from `starkware-libs/starknet-privacy` at `980da8affafb9f8350975ca93c03b2299a31ac9b`.
Every claim below is either cited to a file and line in that tree, or marked **UNKNOWN**.

## The headline

A withdrawal publishes **the destination address, the token and the exact amount**. What
it hides from the public is **which pool user withdrew** — and it hides that by encrypting
the withdrawer's address *to the auditor*, in the same transaction. This is not a side
effect of the general escrow; it is a second, direct deanonymisation channel written into
the withdrawal path.

Because both ends of a pool position are public in amount — the `Deposit` event
(`packages/privacy/src/events.cairo:30-40`) and the `Withdrawal` event
(`events.cairo:16-28`) — deposit-to-withdrawal correlation by amount and timing is
available to anyone, with no keys at all. The pool's protection against it is the crowd,
and the crowd's size is **UNKNOWN** here and must be computed, not assumed.

## The flow, as the contract executes it

1. **`UseNote`**, once per input note, producing a nullifier and `EmitNoteUsed`
   (`packages/privacy/src/privacy.cairo:587-632`).
2. **`Withdraw`** (`privacy.cairo:507-531`). Input is
   `WithdrawInput { to_addr, token, amount, random }`
   (`packages/privacy/src/actions.cairo:182-193`); `random` must be non-zero
   (`actions.cairo:195-203`). The contract:
   - subtracts the amount from the in-transaction token balance,
   - **encrypts the withdrawing user's address to `self.auditor_public_key.read()`**
     (`privacy.cairo:518-523`, `packages/privacy/src/utils.cairo:253`),
   - emits `TransferTo(to_addr, token, amount)` and
     `EmitWithdrawal(Withdrawal { enc_user_addr, to_addr, token, amount })`.
3. Change, if any, comes back as a new encrypted note (`privacy.cairo:637-671`).
4. The invocation goes to the proving service; the wallet submits `apply_actions`
   (`sdk/src/internal/private-transfers.ts:125-133`).

## What lands on chain, in plaintext

- `Withdrawal { enc_user_addr, to_addr (indexed), token (indexed), amount }` —
  `events.cairo:16-28`. The event's own doc comment names the encryption's audience:
  *"Encrypted address of the withdrawing user. Can be decrypted by the auditor"*
  (`events.cairo:18`).
- The `TransferTo` server action, carrying `to_addr`, `token` and `amount`, is in the
  `apply_actions` calldata (`actions.cairo:347-356`,
  `sdk/src/internal/private-transfers.ts:130`).
- The ERC-20 `Transfer` from the pool to `to_addr` (`privacy.cairo:977-981`).
- One `NoteUsed { nullifier }` per input note (`events.cairo:102-107`) — the count of
  inputs is public even though their values are not.
- The fee payer: `fee_amount` STRK is pulled from `get_caller_address()`
  (`privacy.cairo:845-856`). Without a paymaster, the submitting account is linked to the
  withdrawal (`README.md:7`).

## Hidden versus visible, by party

| Fact | Public observer | Other pool users | Discovery operator | Proving operator | Auditor |
|---|---|---|---|---|---|
| That a withdrawal happened (`events.cairo:16-28`) | **Visible** | Visible | Visible | Visible | Visible |
| Destination address `to_addr` | **Visible** | Visible | Visible | Visible | Visible |
| Token and exact amount | **Visible** | Visible | Visible | Visible | Visible |
| Which pool user withdrew (`utils.cairo:253`) | Hidden | Hidden | **Visible** | **Visible** | **Visible — decrypted directly from `enc_user_addr`** |
| Which notes funded it (`hashes.cairo:224-236`) | Hidden | Hidden | Visible | Visible | Visible |
| Remaining balance / change note | Hidden | Hidden | Visible | Visible | Visible |
| Fee payer, unless a paymaster is used | **Visible** | Visible | Visible | Visible | Visible |

**The auditor can always decrypt.** Two independent routes on this flow: the root viewing
key escrowed at registration (`privacy.cairo:319-345`, `findings/01-escrow.md`), and
`enc_user_addr` on this very event (`privacy.cairo:518-523`, `events.cairo:18`). The
auditor key is read from contract storage, is not a user field, cannot be zeroed
(`actions.cairo:18-23`), and both registration writes are write-once. Rotating the auditor
key does **not** revoke the old auditor — the pool's own interface documentation records
that keys registered under a previous auditor cannot be decrypted by a new one
(`packages/privacy/src/interface.cairo:816-821`), which read from the user's side means
the auditor in office when you registered keeps that ability forever.

`get_auditor_public_key` is non-zero on both mainnet and Sepolia (`findings/06`), so this
is live, not a dormant code path.

The discovery and proving columns follow from the key disclosure, not from anything in the
withdraw path: the SDK sends the private viewing key in the discovery request body
(`sdk/src/internal/indexer-discovery.ts:160-166`; proven to be the private scalar at
`crates/discovery-service/src/api/validators.rs:236-246`; `findings/02`), and sends it to
the prover inside the `compile_actions` calldata
(`sdk/src/internal/proof-invocation-factory.ts:132-136`,
`sdk/src/internal/proving-service.ts:282-293`).

## Screening does not apply here — and that is worth knowing

Only a `TransferFrom` (a deposit) or an invoke sets a screening subject
(`privacy.cairo:864-909`); a withdrawal's `TransferTo` does not. `apply_actions` then
asserts that no attestation is attached (`privacy.cairo:799-801`). Upstream's proof
interceptor agrees: withdraw-only pool calls are bypassed with `allow`
(`proof-interceptor/README.md:45`).

So a withdrawal discloses nothing extra to the sanctions provider. The disclosure happened
on the way in (see the shield/deposit skill).

## Correlation is the real exposure

Nothing here needs a key:

- Deposit amounts are public (`events.cairo:30-40`). Withdrawal amounts are public
  (`events.cairo:16-28`). A distinctive amount deposited and later withdrawn is a link.
- The count of `NoteUsed` events reveals how many notes were consumed.
- Timing is public.

The defence is that many users are doing the same thing at the same time. Whether that is
true of a given pool at a given moment is a measurement, not a property of the source —
see UNKNOWN.

## UNKNOWN

- **The anonymity-set size at the moment of the withdrawal.** Not derivable from source.
  Compute it from chain state; never assert it. This is `what_does_this_leak`'s job
  (HANDOFF Phase F).
- **Who holds the auditor private key on mainnet, and under what policy** (`findings/01`).
  Also whether any deployment has considered an auditor key that is provably nobody's —
  the contract forbids zero but not an unspendable point.
- **The hosted proving-service and discovery-service URLs.** Not published in upstream at
  this commit; `demo/.env.mainnet.example:13-15` are literal `TODO_` placeholders. Use
  `resolve_endpoints` and ask StarkWare (HANDOFF §6 q5).
- **Whether the deployed pool is the audited code.** The published class hash matches
  neither deployment (`findings/06`); `pool_state` surfaces the discrepancy.

## What to do

- Do not tell users a withdrawal is private. Tell them the destination and amount are
  public and the origin is hidden from the public but not from the auditor.
- Withdraw to an address that is not already linked to the deposit address, or the
  origin-hiding buys nothing.
- Avoid distinctive amounts, and do not withdraw the whole deposit in one action, if
  correlation matters to the user.
- Use a paymaster if the submitting account should not be linked (`README.md:7`).
- Never claim revocability. The auditor's ability here is permanent and unrotatable by the
  user (`interface.cairo:816-821`, `findings/01`).
