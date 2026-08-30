//! The authorship commitment, and the two properties it has to have.
//!
//! `HYDRA_HANDOFF.md` Phase 2: "Bind a content commitment into every note. A hash costs
//! nothing and makes authorship of specific content provable later even after the
//! payload expires." Phase 5 then proves knowledge of a nullifier preimage bound to
//! that commitment.
//!
//! This is the commitment ONLY. No registry, no circuit, no verifier — Phase 5 is not
//! designed and inventing its ABI here would be inventing protocol.

use hydra_authorship::commitment::{DOMAIN, commit};

#[test]
fn commitment_is_deterministic() {
    assert(commit(7, 11) == commit(7, 11), 'not deterministic');
}

#[test]
fn commitment_binds_both_inputs() {
    // Changing either input must change the commitment, or it binds neither.
    assert(commit(7, 11) != commit(8, 11), 'nullifier not bound');
    assert(commit(7, 11) != commit(7, 12), 'content not bound');
}

#[test]
fn commitment_is_not_a_bare_hash_of_the_pair() {
    // Domain separation. Without the tag this collides with every other Poseidon-2 hash
    // on Starknet, including ones an adversary chooses — so a commitment could be
    // "found" in unrelated calldata and passed off as authorship of something else.
    assert(commit(7, 11) != core::poseidon::poseidon_hash_span(array![7, 11].span()), 'no domain tag');
    assert(DOMAIN != 0, 'empty domain tag');
}

#[test]
fn arguments_do_not_commute() {
    // h(a, b) != h(b, a). A commitment that commuted would let a nullifier be passed off
    // as a content hash.
    assert(commit(7, 11) != commit(11, 7), 'commutes');
}
