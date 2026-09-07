//! The pointer publisher — invariant I4.
//!
//! `HYDRA_HANDOFF.md` I4: payloads are never stored as pool notes. The pool carries pointers
//! and commitments only.
//!
//! The pool never emits our calldata itself — `ExternalContractInvoked` carries the contract
//! address and the selector and says so explicitly ("Calldata is not emitted",
//! `.upstream/packages/privacy/src/events.cairo:82-90`). So a pointer reaches the chain by the
//! pool invoking an external contract, which is this one, and that contract emitting it.
//!
//! The pool calls the entrypoint named by `INVOKE_SELECTOR = selector!("privacy_invoke")`
//! (`.upstream/packages/privacy/src/utils.cairo:84`), dispatched at
//! `.upstream/packages/privacy/src/privacy.cairo:878-886`.
//!
//! I4 IS ENFORCED BY THE SIGNATURE, not by a check. `privacy_invoke` takes two felts. There is
//! no length-prefixed array, no `Span<felt252>`, and no variant that carries bytes — so there
//! is no argument a caller could smuggle a message into, and no code path that would have to
//! be reviewed for one. A payload cannot be too large if there is nowhere to put it.
//!
//! It RETURNS an array, and that is not a hole in the above. The pool deserialises the return
//! value as its open-note deposits and reverts if it cannot, so a contract that returned nothing
//! could not be published through the pool at all — which was the state of this one until a
//! live pool-routed call failed with `INVALID_INVOKE_RETURN_DATA`. Nothing emits the return
//! value; it goes back to the pool, which reads deposits from it and discards the rest.

#[starknet::interface]
pub trait IChannel<TContractState> {
    /// Publish a pointer and its content commitment. Two felts in, and deliberately nothing else.
    ///
    /// Returns the pool's open-note deposits, which for this contract is always empty. The pool
    /// deserialises whatever comes back as `Span<OpenNoteDeposit>`
    /// (`.upstream/packages/privacy/src/utils.cairo:590-594`) and reverts with
    /// `INVALID_INVOKE_RETURN_DATA` if it cannot — so a contract returning nothing at all makes
    /// every pool-routed publish fail. An empty `Array<felt252>` serialises to the single felt
    /// `0`, which is the same wire form as an empty span of anything.
    ///
    /// This is not a payload channel. The return value goes back to the pool and is never
    /// emitted; `_apply_invoke_and_deposits` reads deposits from it and nothing else.
    fn privacy_invoke(
        ref self: TContractState, pointer: felt252, commitment: felt252,
    ) -> Array<felt252>;
}

#[starknet::contract]
pub mod Channel {
    /// ⛔ **NO STORAGE, AND THE EMPTINESS IS THE FEATURE.**
    ///
    /// This held `published: u64`, a counter incremented on every publish, read by nothing outside
    /// its own test. Removing it was not a tidy-up; it removed a disclosure and more than half the
    /// cost of a message.
    ///
    /// **Starknet events are L2-only. Storage diffs are posted to L1.** That counter was this
    /// contract's ONLY storage, so it was the only thing that put the contract into the L1 state
    /// diff at all — and it changed on every single publish. An observer with no access to L2
    /// events, reading L1 alone, learned **how many pointers were published in each block**. That
    /// is a rate signal on the whole system, free, permanent, and disclosed by nothing else here.
    ///
    /// **MEASURED ON REAL TRANSACTIONS, BECAUSE THE `snforge` NUMBERS OVERSTATED IT BY 5x.** This
    /// said *"0.0138 STRK a message, 57% of a publish"*, from `snforge`'s `l2_gas`: 855,710 with the
    /// counter against 365,130 without. That figure is the CONTRACT's execution and nothing else. A
    /// publish is a transaction through an account, and account `__validate__`/`__execute__` costs
    /// ~600k `l2_gas` the counter never touched — so it is the denominator, and leaving it out
    /// inflated the saving.
    ///
    /// Both contracts deployed to one local devnet, same account, same calldata, only the contract
    /// differing:
    ///
    ///     with the counter     l1_data_gas 256   l2_gas 1,101,440
    ///     without              l1_data_gas 128   l2_gas   981,440
    ///
    /// That is a **10.9% `l2_gas` saving, devnet-to-devnet** — not 57%.
    ///
    /// ⛔ **AND DEVNET NUMBERS DO NOT TRANSFER TO MAINNET. MEASURED, AFTER SAYING THEY DID.** This
    /// comment previously converted the devnet figure straight into "0.028133 STRK a message" at
    /// mainnet prices. Five real publishes on mainnet then cost **0.031062 STRK each**
    /// (`l1_gas` 0, `l1_data_gas` 128, `l2_gas` 1,097,280) — the same class costs **11.8% more
    /// `l2_gas` on mainnet than on devnet**, so the absolute figure was 10.4% low.
    ///
    /// **The mainnet saving is therefore UNMEASURED and this comment will not invent it.** The old
    /// class was never deployed to mainnet, so there is no mainnet pair to difference. What is
    /// measured is the devnet pair (10.9%) and the mainnet absolute (0.031062). Scaling one by the
    /// other is the move that produced the wrong number in the first place.
    ///
    /// The counter's real price was paid at DECLARE, where the storage-bearing class costs
    /// 35,690,880 `l2_gas` against 20,383,360 — **43% off a one-time cost**, and that one is large.
    ///
    /// **The `l1_data_gas` halving IS the state diff, and it survives contact with mainnet
    /// exactly**: 256 -> 128 on devnet, and every mainnet publish shows `l1_data_gas` 128. L1 data
    /// gas is what it costs to post a state diff, so the number that priced the counter is the
    /// number that proves it was visible. **That is the argument for this change. The per-message
    /// money never was, and is smaller than this comment once claimed twice over.**
    ///
    /// It was also a single global slot every publisher writes, which serialises under parallel
    /// execution — a throughput cost on top of the other two.
    ///
    /// **Adding storage back re-opens all three.** If a counter is ever wanted, it belongs in an
    /// indexer reading the events, which are public already and cost L2 gas only.
    /// `tests/channel.cairo::publishing_writes_no_state` covers the observable consequence — every
    /// call returning identically however many preceded it. It cannot prove a `#[storage]` field
    /// absent from outside the contract, and it no longer claims to: the guarantee is the empty
    /// `struct Storage {}` below, which is verified by reading it.
    #[storage]
    struct Storage {}

    /// The whole on-chain footprint of a message.
    ///
    /// Neither field says who sent it, who it is for, or what it says. `pointer` is a blob id
    /// masked by a vault-domain, per-sequence pad (`packages/channel/src/pointer.ts`), so it
    /// names a blob only to someone holding the channel secret. `commitment` is
    /// `commit(blind, content_hash)`. Authorship is a signature over this value, carried in
    /// the message body — never on chain. See `packages/handshake/src/authorship.ts`.
    ///
    /// Neither is indexed. A `#[key]` would let anyone filter the chain for one pointer, which
    /// costs nothing to the reader who already has it and hands a free index to everyone else.
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        PointerPublished: PointerPublished,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PointerPublished {
        pub pointer: felt252,
        pub commitment: felt252,
    }

    #[abi(embed_v0)]
    impl ChannelImpl of super::IChannel<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, pointer: felt252, commitment: felt252,
        ) -> Array<felt252> {
            // No access control, and that is the design rather than an omission. The pool
            // invokes this on a user's behalf and the caller is the pool, so gating on the
            // caller would let the pool's address be used to filter our events. Anyone may
            // publish a pointer; a pointer that names no blob you can find is noise, and noise
            // is what the anonymity set is made of.
            self.emit(PointerPublished { pointer, commitment });
            // No deposits. Publishing a pointer moves no value, and an empty array is how the
            // pool is told so — see the interface.
            array![]
        }
    }
}
