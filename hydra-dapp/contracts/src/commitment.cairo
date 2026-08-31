//! The content commitment.
//!
//! One pure function, and deliberately nothing else. `HYDRA_HANDOFF.md` Phase 2 asks
//! for a content commitment bound into every note so that authorship of specific
//! content stays provable after the payload expires.
//!
//! THE FIRST ARGUMENT WAS CALLED A NULLIFIER AND IT IS NOT ONE. The header here used to
//! say it was the pool's `h(TAG, channel_key, token, index, 0, owner_private_key)`,
//! bound to secret material only the owner holds. In the client that was never true:
//! the value came from the channel's own material, which BOTH ends hold, so it bound a
//! message to a conversation rather than to a person and either party could produce it.
//!
//! So it is a `blind`, which is what it actually does — it stops the commitment being a
//! bare hash of the content that anyone who guesses the plaintext can confirm. Who wrote
//! a message is answered by an Ed25519 signature over this commitment, under a key
//! derived from the author's own vault root and published in their bundle
//! (`packages/handshake/src/authorship.ts`). A primitive whose name claims more than it
//! does is worse than no primitive, because everything downstream believes the name.

/// Domain separation tag, `'hydra/authorship/v1'` as a short string.
///
/// Without it this is an ordinary two-element Poseidon hash, indistinguishable from
/// every other one on Starknet — so a value appearing in unrelated calldata could be
/// presented as a commitment to something it was never a commitment to.
pub const DOMAIN: felt252 = 'hydra/authorship/v1';

/// Commit to a piece of content, blinded so the commitment is not a bare content hash.
///
/// Order matters and is asserted by the tests: `commit(a, b) != commit(b, a)`, so a
/// blind can never be passed off as a content hash.
pub fn commit(blind: felt252, content_hash: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span(array![DOMAIN, blind, content_hash].span())
}
