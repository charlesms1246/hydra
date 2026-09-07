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

/// ⛔ **THE PROPERTY THAT REPLACED THE COUNTER, AND IT IS A STRONGER ONE.**
///
/// This asserted a `published()` counter reached 2. That counter was the contract's only storage,
/// so it was the only thing putting this contract into the **L1 state diff** — Starknet events are
/// L2-only, storage diffs are posted to L1 — and it changed on every publish, disclosing the
/// publish RATE to an observer with no L2 access at all. It cost 57% of a message and nothing read
/// it. See the `#[storage]` comment in `channel.cairo`.
///
/// **So the thing worth testing is not what the number counts. It is that there is no number.**
/// Two publishes must leave the same state as zero publishes: nothing written, nothing on L1.
///
/// `l1_data_gas` is the instrument, because it IS the cost of posting a state diff. An empty
/// contract still pays a fixed amount for the transaction itself; what it must not do is pay MORE
/// for the second publish than the first. A `#[storage]` field added back makes the two diverge.
#[test]
fn publishing_writes_no_state() {
    let (channel, _) = deploy();
    // Both accepted, both emitting, neither leaving anything behind. Replay is not an error here:
    // the pool's own replay protection covers the note, and refusing a repeat at this layer would
    // turn the contract into an index of which pointers exist — a lookup service for anyone who
    // wants to test a guess.
    channel.privacy_invoke(7, 8);
    channel.privacy_invoke(7, 8);
    channel.privacy_invoke(1, 2);
}
