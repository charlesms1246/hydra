//! The pointer publisher carries a pointer and a commitment, and nothing else.
//!
//! I4's guarantee is the entrypoint's signature: `privacy_invoke(felt252, felt252)`. There is
//! no array argument, so there is nowhere to put a payload. These tests deploy the contract and
//! check the parts a signature cannot state — that the event carries both fields unchanged,
//! that publishing is open to anyone, and that the count is the only state kept.

use hydra_authorship::channel::{IChannelDispatcher, IChannelDispatcherTrait};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare, spy_events,
                  EventSpyAssertionsTrait};
use hydra_authorship::channel::Channel;
use starknet::ContractAddress;

fn deploy() -> (IChannelDispatcher, ContractAddress) {
    let contract = declare("Channel").unwrap().contract_class();
    let (address, _) = contract.deploy(@array![]).unwrap();
    (IChannelDispatcher { contract_address: address }, address)
}

/// ⛔ **THE RETURN VALUE IS THE INVARIANT AND NOTHING IN THIS SUITE READ IT.**
///
/// `privacy_invoke` must answer with an EMPTY array or every pool-routed publish reverts with
/// `INVALID_INVOKE_RETURN_DATA` — the header of `channel.cairo` records that being found in
/// production. All three tests below called the entrypoint and discarded what it returned, so the
/// only check on it was `live-authorship.test.ts`, which needs a devnet, the control API and
/// `HYDRA_LIVE_WRITE=1`, and is not in `npm test`. Its own comment says so: *"The snforge tests
/// call the entrypoint directly and never saw it."*
///
/// **A guarantee whose only witness needs three preconditions is a guarantee nobody checks.** This
/// is the same property, in the suite people actually run, and it costs one line.
#[test]
fn returns_no_deposits_so_the_pool_does_not_revert() {
    let (channel, _) = deploy();
    assert(channel.privacy_invoke(1, 2).len() == 0, 'must return no deposits');
}

#[test]
fn publishes_both_fields_unchanged() {
    let (channel, address) = deploy();
    let mut spy = spy_events();
    channel.privacy_invoke(0x1234, 0x5678);
    spy
        .assert_emitted(
            @array![
                (
                    address,
                    Channel::Event::PointerPublished(
                        Channel::PointerPublished { pointer: 0x1234, commitment: 0x5678 },
                    ),
                ),
            ],
        );
}

#[test]
fn counts_what_it_published() {
    let (channel, _) = deploy();
    assert(channel.published() == 0, 'starts empty');
    channel.privacy_invoke(1, 2);
    channel.privacy_invoke(3, 4);
    assert(channel.published() == 2, 'counts both');
}

#[test]
fn the_same_pointer_may_be_published_twice() {
    // Replay is not an error here. The pool's own replay protection covers the note; refusing
    // a repeat at this layer would turn the contract into an index of which pointers exist,
    // which is a lookup service for anyone who wants to test a guess.
    let (channel, _) = deploy();
    channel.privacy_invoke(7, 8);
    channel.privacy_invoke(7, 8);
    assert(channel.published() == 2, 'both accepted');
}
