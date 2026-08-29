---
name: strk20-shadow-account-dapp-call
description: What a STRK20 shadow-account dapp interaction hides and what it reveals, and to which party — unlinkable to the public, fully enumerable by anyone holding the viewing key, and settling at a publicly visible amount. Use when designing, reviewing or explaining a private swap, lending or other dapp call through the shadow account anonymizer.
---

# Shadow-account dapp call — hidden versus visible

Read from `starkware-libs/starknet-privacy` at `980da8affafb9f8350975ca93c03b2299a31ac9b`.
Every claim below is either cited to a file and line in that tree, or marked **UNKNOWN**.

## The headline

Shadow accounts are a real and well-built anti-correlation tool: the dapp sees a
per-user, per-dapp contract address and not the user, and two dapps see unrelated
addresses. Three things qualify that, and all three are load-bearing:

1. **The identity key derives from the viewing key.** Anyone holding it enumerates every
   shadow account you will ever derive, for any dapp name they can guess, across nonces —
   with no chain access and no cooperation.
2. **The settlement amount is public.** Funds return to the pool through an *open* note,
   whose deposited amount is emitted in plaintext and stored in plaintext.
3. **Unlinkability is only within the crowd** using the same dapp through the same
   anonymizer. That crowd's size is **UNKNOWN** and must be computed, not assumed.

## The flow, as the contract executes it

1. **`CreateOpenNote`**, ahead of the interaction, to receive the proceeds. The pool
   encrypts the recipient address to the auditor key and emits
   `OpenNoteCreated { enc_recipient_addr, token (indexed), note_id (indexed) }`
   (`packages/privacy/src/privacy.cairo:676-714`,
   `packages/privacy/src/events.cairo:54-64`).
2. **`ComputeAndInvoke`** (`packages/privacy/src/actions.cairo:221-243`). The pool derives
   `identity_key = h(IDENTITY_KEY_TAG, user_addr, user_private_key, contract_address)`
   (`privacy.cairo:557-559`, `packages/privacy/src/hashes.cairo:48-61`) and calls the
   anonymizer's `privacy_compute(identity_key, dapp_name, nonce)`, which returns
   `commitment = h(h(identity_key, dapp_name), nonce)`
   (`packages/shadow_account_anonymizer/src/shadow_account_anonymizer.cairo:101-103`,
   `:57-67`). The identity key never leaves the call; the pool forwards only the
   commitment (`privacy.cairo:571-582`).
3. **`privacy_invoke_with_computation`** on the anonymizer, callable only by the
   configured privacy contract (`shadow_account_anonymizer.cairo:140-145`, `:126-131`).
   It deploys the shadow account on first use, runs the dapp calls **as that account**,
   collects the requested tokens back into the anonymizer, and returns the deposits plus
   **the shadow account's address** as the associated address
   (`shadow_account_anonymizer.cairo:105-124`).
4. The pool emits `ExternalContractInvoked { contract_address (indexed), selector
   (indexed) }` and applies the deposits (`privacy.cairo:990-1035`, `events.cairo:81-91`).
   Calldata is deliberately not emitted because *"it is already visible in the public call
   trace"* (`privacy.cairo:988-989`).
5. Each deposit lands in its open note: the amount is written as plaintext
   (`pack(OPEN_NOTE_SALT, amount)`) and `OpenNoteDeposited { depositor (indexed), token
   (indexed), note_id (indexed), amount }` is emitted (`privacy.cairo:1039-1069`,
   `events.cairo:66-79`).

Addresses are deterministic and precomputable before deployment: salt = commitment, class
= the cemented `PRIMER_CLASS_HASH`, deployer = the anonymizer
(`shadow_account_anonymizer.cairo:44-55`,
`sdk/src/internal/shadow-account-address.ts:14-15`, `:24-58`). Replacing the shadow
account class does not move any existing address.

## What lands on chain, in plaintext

- The **anonymizer address and the selector** used, distinguishing a plain invoke from a
  compute-and-invoke (`events.cairo:81-91`).
- The **shadow account address**, and every dapp call it made, in the public call trace
  (`privacy.cairo:988-989`). The dapp's own events name the shadow account.
- **The settlement amount**, per token, in `OpenNoteDeposited`
  (`events.cairo:66-79`) — a plain `u128`, plus a plaintext storage write
  (`privacy.cairo:1056-1059`). This is the sharpest difference from a normal private
  transfer, where amounts are masked (`packages/privacy/src/utils.cairo:293-306`).
- `OpenNoteCreated`, with the recipient encrypted to the auditor (`events.cairo:54-64`).
- The fee payer, unless a paymaster is used (`privacy.cairo:845-856`, `README.md:7`).

## Hidden versus visible, by party

| Fact | Public observer | The dapp | Other pool users | Discovery operator | Proving operator | Screening provider | Auditor |
|---|---|---|---|---|---|---|---|
| That an interaction happened (`events.cairo:81-91`) | **Visible** | Visible | Visible | Visible | Visible | Visible | Visible |
| The shadow account address | **Visible** | **Visible — it is the counterparty** | Visible | Visible | Visible | **Visible when policy is `Delegated`** | Visible |
| Which dapp, and the calls made (`privacy.cairo:988-989`) | **Visible** | Visible | Visible | Visible | Visible | Visible | Visible |
| Settlement amount per token (`events.cairo:66-79`) | **Visible** | Visible | Visible | Visible | Visible | Visible | Visible |
| Which user owns the shadow account (`hashes.cairo:48-61`) | Hidden | Hidden | Hidden | **Visible** | **Visible** | Hidden | **Visible** |
| That two shadow accounts belong to the same user | Hidden | Hidden (different dapp ⇒ different account) | Hidden | **Visible** | **Visible** | Hidden | **Visible** |
| Your other shadow accounts, for dapps you have not used | Hidden | Hidden | Hidden | **Enumerable** | **Enumerable** | Hidden | **Enumerable** |
| Your private viewing key | Hidden | Hidden | Hidden | Disclosed on sync | Disclosed with the invocation | Not disclosed | **Disclosed, mandatorily and forever** |

**The auditor can always decrypt.** The pool encrypts every user's private viewing key to
the auditor key held in contract storage, at registration, unconditionally and write-once,
with no user-side rotation (`privacy.cairo:319-345`, `utils.cairo:224-233`,
`actions.cairo:18-23`, `findings/01-escrow.md`). Because `identity_key` is a deterministic
hash of `(user_addr, user_private_key, anonymizer_address)`, the auditor derives every
partial commitment, every commitment and every address without any chain interaction.
Rotating the auditor key does not revoke the old auditor
(`packages/privacy/src/interface.cairo:816-821`). `get_auditor_public_key` is non-zero on
both mainnet and Sepolia (`findings/06`).

Enumeration is not even laborious: the anonymizer publishes
`get_shadow_accounts(partial_commitment, start_nonce, end_nonce, until_undeployed)`, up to
`MAX_SCAN_RANGE = 1024` nonces per call
(`shadow_account_anonymizer.cairo:170-176`, `:44-46`). A partial commitment is one
Poseidon hash away from the identity key, and the identity key is one hash away from the
viewing key. `findings/03-sub-accounts.md`.

The discovery and proving columns follow from the key disclosure, not from anything in
this flow: the SDK sends the private viewing key in the discovery request body
(`sdk/src/internal/indexer-discovery.ts:160-166`; proven to be the private scalar at
`crates/discovery-service/src/api/validators.rs:236-246`; `findings/02`), and sends it to
the prover inside the `compile_actions` calldata
(`sdk/src/internal/proof-invocation-factory.ts:132-136`,
`sdk/src/internal/proving-service.ts:282-293`).

## Screening reaches the shadow account

When the invoke target's open-note policy is `Delegated`, the addresses returned alongside
the deposits become the transaction's screening subject
(`privacy.cairo:1014-1026`) — and the anonymizer returns *the shadow account's address*
(`shadow_account_anonymizer.cairo:121-124`). Upstream's proof interceptor confirms the
other end: the screened address may be a deposit's `user_addr`, **the shadow account an
interaction runs through**, or an invoke target whose policy is `Required`
(`proof-interceptor/README.md:43`). Screening happens operator-side, as a sidecar to the
prover, and is invisible to the client except as JSON-RPC error `10000`
(`proof-interceptor/README.md:3`, `:5`, `:37`).

So the shadow account address — the thing whose whole purpose is to not be you — is sent
to a commercial sanctions provider on a `Delegated` interaction. That provider does not
learn who you are from that address alone; it does learn the address, and it learns it in
the same pipeline that saw your deposits.

`get_screener_public_key` is non-zero on both live pools (`findings/06`).

## UNKNOWN

- **Whether a shadow account anonymizer is deployed on mainnet or Sepolia.** The upstream
  compatibility matrix publishes class hashes for the Ekubo and Vesu anonymizers and
  **not** for the shadow account anonymizer (`README.md:58-62`, `findings/03`). Do not
  substitute `PRIMER_CLASS_HASH` — that is a different contract. `resolve_endpoints`
  reports this field as UNKNOWN.
- **The anonymity-set size.** A shadow account is unlinkable only within the set of users
  driving the same dapp through the same anonymizer in the same period. With few users,
  amount and timing correlation re-links trivially — and the settlement amount is public,
  which makes that correlation cheap. Compute this figure; never assert it
  (`findings/03`, HANDOFF Phase F).
- **What `dapp_name` values are in use.** Guessable names shrink the enumeration search
  for a key holder, but the practical impact depends on deployment and is not in source.
- **The hosted proving-service and discovery-service URLs** (`demo/.env.mainnet.example:13-15`
  are literal `TODO_` placeholders). Use `resolve_endpoints`; ask StarkWare (HANDOFF §6 q5).
- **Whether the deployed pool is the audited code.** The published pool class hash matches
  neither deployment (`findings/06`); `pool_state` surfaces the discrepancy.

## What to do

- Claim exactly this and no more: *unlinkable to the public and to the dapp; fully
  linkable by the auditor and by any discovery or proving operator you have used.*
- Do not build an identity-separation scheme on shadow accounts if the auditor is in the
  threat model. Identity separation has to happen above the pool, under keys the pool
  never sees (`findings/01`, `findings/03`).
- Remember the settlement amount is public. If the amount identifies the user, the shadow
  account does not help.
- Use different `dapp_name` values per context and nonces within a context — that is what
  they are for (`shadow_account_anonymizer.cairo:90-93`) — but do not treat it as defence
  against a key holder.
- Confirm the anonymizer address you are calling. Use `resolve_endpoints`; do not copy an
  address from a tutorial.
