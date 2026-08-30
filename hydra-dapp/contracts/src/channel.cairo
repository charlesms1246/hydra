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

#[starknet::interface]
pub trait IChannel<TContractState> {
    /// Publish a pointer and its content commitment. Two felts, and deliberately nothing else.
    fn privacy_invoke(ref self: TContractState, pointer: felt252, commitment: felt252);
    /// How many pointers this contract has published. Public by construction — the events are.
    fn published(self: @TContractState) -> u64;
}

#[starknet::contract]
pub mod Channel {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        published: u64,
    }

    /// The whole on-chain footprint of a message.
    ///
    /// Neither field says who sent it, who it is for, or what it says. `pointer` is a blob id
    /// masked by a vault-domain, per-sequence pad (`packages/channel/src/pointer.ts`), so it
    /// names a blob only to someone holding the channel secret. `commitment` is
    /// `commit(nullifier, content_hash)`, which binds authorship without naming an author.
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
        fn privacy_invoke(ref self: ContractState, pointer: felt252, commitment: felt252) {
            // No access control, and that is the design rather than an omission. The pool
            // invokes this on a user's behalf and the caller is the pool, so gating on the
            // caller would let the pool's address be used to filter our events. Anyone may
            // publish a pointer; a pointer that names no blob you can find is noise, and noise
            // is what the anonymity set is made of.
            self.published.write(self.published.read() + 1);
            self.emit(PointerPublished { pointer, commitment });
        }

        fn published(self: @ContractState) -> u64 {
            self.published.read()
        }
    }
}
