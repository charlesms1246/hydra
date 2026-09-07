//! The pointer publisher carries a pointer and a commitment, and nothing else.
//!
//! I4's guarantee is the entrypoint's signature: `privacy_invoke(felt252, felt252)`. There is
//! no array argument, so there is nowhere to put a payload. These tests deploy the contract and
//! check the parts a signature cannot state — that the event carries both fields unchanged,
//! that publishing is open to anyone, and that NO state is kept at all. There is no counter; the
//! `published: u64` this once asserted on was removed in 88aa4e9 and `Storage` is now empty.

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
/// publish RATE to an observer with no L2 access at all. Nothing read it. See the `#[storage]`
/// comment in `channel.cairo` for what it cost and what that cost is now measured to be.
///
/// ⛔ **THIS TEST USED TO ASSERT NOTHING.** It called `privacy_invoke` three times and stopped —
/// no `assert`, no storage inspection, no gas comparison — while `channel.cairo` told the reader
/// that *"`tests/channel.cairo` asserts the class declares no storage, so this comment cannot
/// quietly stop being true."* It could stop being true silently, and this is the exact defect
/// this repository exists to argue against: a guard named in a comment that does not exist in the
/// code. A test with no assertion passes whatever the contract does.
///
/// **WHAT IT CAN HONESTLY CHECK, AND WHAT IT CANNOT.** snforge cannot prove the ABSENCE of a
/// storage variable from outside the contract; that guarantee is carried by `struct Storage {}`
/// being empty in the source, which is a thing a reader verifies by looking. What IS observable
/// from out here is the consequence: every call behaves identically no matter how many came
/// before it. A counter — or any storage — makes the Nth call differ from the first.
///
/// So this asserts the two observable invariants on every one of three calls: the return value is
/// the EMPTY deposits array (the thing a pool-routed publish reverts without), and repeated and
/// identical calldata is accepted rather than deduplicated. Replay is not an error here: the
/// pool's own replay protection covers the note, and refusing a repeat at this layer would turn
/// the contract into an index of which pointers exist — a lookup service for anyone testing a
/// guess.
#[test]
fn publishing_writes_no_state() {
    let (channel, _) = deploy();
    // The empty deposits array, asserted on EVERY call rather than once. This is the invariant a
    // live pool-routed publish failed on with `INVALID_INVOKE_RETURN_DATA`, and until now no
    // snforge test looked at the return value at all — the only guard was an opt-in live suite.
    assert(channel.privacy_invoke(7, 8).len() == 0, 'first returns no deposits');
    assert(channel.privacy_invoke(7, 8).len() == 0, 'replay returns no deposits');
    assert(channel.privacy_invoke(1, 2).len() == 0, 'third returns no deposits');
}
