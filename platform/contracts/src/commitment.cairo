//! The authorship commitment.
//!
//! One pure function, and deliberately nothing else. `HYDRA_HANDOFF.md` Phase 2 asks
//! for a content commitment bound into every note so that authorship of specific
//! content stays provable after the payload expires; Phase 5 then proves knowledge of
//! the nullifier preimage against it. Phase 5 is not designed, so there is no registry
//! and no verifier here — writing either now would be inventing protocol.
//!
//! The nullifier is the pool's, and it is what makes this bind to an identity without
//! naming one: `nullifier = h(TAG, channel_key, token, index, 0, owner_private_key)`
//! (`HYDRA_HANDOFF.md` §2), deterministic and bound to secret material. Committing to
//! `(nullifier, content_hash)` therefore ties a specific message to a specific note
//! that only its owner can have produced.

/// Domain separation tag, `'hydra/authorship/v1'` as a short string.
///
/// Without it this is an ordinary two-element Poseidon hash, indistinguishable from
/// every other one on Starknet — so a value appearing in unrelated calldata could be
/// presented as a commitment to something it was never a commitment to.
pub const DOMAIN: felt252 = 'hydra/authorship/v1';

/// Commit to a piece of content authored by the owner of `nullifier`.
///
/// Order matters and is asserted by the tests: `commit(a, b) != commit(b, a)`, so a
/// nullifier can never be passed off as a content hash.
pub fn commit(nullifier: felt252, content_hash: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span(array![DOMAIN, nullifier, content_hash].span())
}
