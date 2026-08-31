//! Parity vectors for the TypeScript side.
//!
//! `packages/channel/src/commitment.ts` recomputes the same commitment off-chain, and the
//! two must never disagree: a commitment written by the client and checked on chain is
//! worthless if the client's Poseidon, its felt encoding or its domain tag differ by so much
//! as a byte. The failure would be silent — a proof that verifies against nothing.
//!
//! So this test does not assert. It prints, and
//! `packages/adversary/test/commitment-parity.test.ts` runs `snforge test` and compares every
//! line against its own computation. Cairo is the authority; the TypeScript follows it.
//!
//! The cases are chosen to break encodings rather than to look representative: zero, one, the
//! largest felt, and values that straddle the 31-byte boundary where a naive byte-packing
//! stops round-tripping.

use hydra_authorship::commitment::{DOMAIN, commit};

#[test]
fn emit_parity_vectors() {
    // felt252's prime is 2^251 + 17 * 2^192 + 1; the last case is P - 1.
    let cases: Array<(felt252, felt252)> = array![
        (0, 0),
        (1, 0),
        (0, 1),
        (1, 2),
        (2, 1),
        ('hydra', 'authorship'),
        (0x800000000000011000000000000000000000000000000000000000000000000, 1),
        (255, 256),
        (0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff, 0xff),
        (3618502788666131213697322783095070105623107215331596699973092056135872020480, 7),
    ];
    println!("DOMAIN {}", DOMAIN);
    for case in cases {
        let (blind, content_hash) = case;
        println!("VECTOR {} {} {}", blind, content_hash, commit(blind, content_hash));
    };
}
