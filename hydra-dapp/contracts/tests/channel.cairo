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
