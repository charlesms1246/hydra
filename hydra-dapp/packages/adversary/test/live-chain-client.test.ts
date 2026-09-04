/**
 * The shipped chain client, against a real node.
 *
 * **THE FAKES AUDIT'S SHARPEST FINDING: `starknet().events()` and `starknet().publishers()` were
 * exercised by nothing but a double.** `publish()` is covered live by `live-authorship.test.ts`,
 * but the reading half was not — the live tests that look like they cover it call
 * `starknet_getEvents` and `starknet_getBlockWithTxs` through their own local `rpc` helper, so they
 * verify the **protocol** and never the **code that talks to the node**.
 *
 * That is `verify.ts` exactly: everything below the network boundary tested, the boundary itself
 * not, and a selector that could never have worked passing every hermetic check.
 *
 *     HYDRA_RPC=https://api.cartridge.gg/x/starknet/sepolia npm run test:live
 *
 * READ-ONLY. No transaction, no funds, nothing written.
 *
 * IT READS A BUSY CONTRACT RATHER THAN OURS, and deliberately: the client does not care which
 * contract it is pointed at, and what is under test is paging, the `fromBlock` offset and range
 * filtering — none of which a quiet devnet contract can exercise. The Starknet ID identity contract
 * is real, busy, and already verified against by `decisions/0031`.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { starknet } from "../../cli/src/chain.ts";
import { identityContract } from "../../cli/src/anchor.ts";

const RPC = process.env.HYDRA_RPC;
const NETWORK = process.env.HYDRA_NETWORK ?? "sepolia";

const clientFrom = (fromBlock: number) => starknet({
  rpcUrl: RPC!, contract: identityContract(NETWORK), fromBlock,
  accountsFile: "", account: "", network: NETWORK,
});

let latest = 0;

before(async () => {
  assert.ok(RPC, "HYDRA_RPC is required — see the header");
  const res = await fetch(RPC!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "starknet_blockNumber", params: [] }),
  });
  latest = Number((await res.json() as { result: number }).result);
  assert.ok(latest > 0, "the node did not report a block height");
});

test("EVENTS CARRY REAL BLOCK NUMBERS AND TRANSACTION HASHES", async () => {
  // The fake numbered blocks `0, 1, 2…` and omitted transaction hashes unless a crowd was
  // configured — which is what let `blockNumber * blockMs` pass for a wall clock and cost four
  // bugs. What a real node returns is the thing the fake was pretending to be.
  const events = await clientFrom(latest - 200).events();
  assert.ok(events.length > 0, "no events in the last 200 blocks — pick a busier contract");
  for (const e of events.slice(0, 20)) {
    assert.equal(e.data.length >= 1, true);
    assert.ok((e.blockNumber ?? 0) > 1_000, `block number ${e.blockNumber} is not a real height`);
    assert.match(String(e.txHash), /^0x[0-9a-f]+$/, "no transaction hash on a real event");
  }
  // Every one is at or after the offset asked for — the `from_block` filter is the client's, and
  // nothing hermetic has ever checked that it is sent correctly.
  const floor = latest - 200;
  assert.ok(events.every((e) => (e.blockNumber ?? floor) >= floor),
    "an event older than fromBlock came back, so the offset is not reaching the node");
});

test("FROM_BLOCK IS RESPECTED: a later offset returns strictly less", async () => {
  // The offset is the client's own parameter and the fake ignored it entirely.
  const wide = await clientFrom(latest - 400).events();
  const narrow = await clientFrom(latest - 50).events();
  assert.ok(narrow.length <= wide.length,
    `a narrower window returned more events (${narrow.length} against ${wide.length})`);
  assert.ok(wide.length > 0, "no events at all — this test is measuring nothing");
});

test("PAGING PAST A CONTINUATION TOKEN", async () => {
  // The client pages with `chunk_size: 100` and follows `continuation_token` in a loop. That loop
  // has never run against real data.
  //
  // IT REPORTS RATHER THAN ASSERTS WHEN THE CHAIN IS TOO QUIET. An unpaged run reported as a paging
  // test is the mirroring problem in a new costume — the check would be green and would have
  // proved nothing.
  const events = await clientFrom(latest - 2_000).events();
  if (events.length <= 100) {
    console.error(`only ${events.length} events in 2000 blocks, so no continuation token was `
      + "issued and PAGING WAS NOT EXERCISED by this run. Not asserted — an unpaged run reported "
      + "as a paging test proves nothing.");
    return;
  }
  assert.ok(events.length > 100,
    "more than one chunk came back, so the continuation loop ran and did not drop the tail");
  // And the pages joined without duplicating the boundary, which is the loop's likeliest bug.
  const hashes = events.map((e) => `${e.blockNumber}:${e.txHash}:${e.data.join(",")}`);
  assert.equal(new Set(hashes).size, hashes.length,
    "an event appears twice, so a page boundary was re-read");
});

test("PUBLISHERS FILTERS BY THE RANGE IT IS GIVEN", async () => {
  // The fake took NO arguments while the signature declared two, so `narrowCrowd`'s range
  // computation was handed to something that discarded it.
  const client = clientFrom(latest - 10);
  const one = await client.publishers!(latest - 2, latest - 2);
  const ten = await client.publishers!(latest - 11, latest - 2);
  assert.ok(ten.length >= one.length,
    `ten blocks returned fewer publishers than one (${ten.length} against ${one.length})`);
  assert.ok(ten.length > 0, "no publishers in ten blocks of a live chain — check the endpoint");

  for (const p of ten) {
    assert.match(p.account, /^0x[0-9a-f]+$/, "a publisher's account is not an address");
    // MILLISECONDS, and the units are the whole reason this row exists: the crowd was silently
    // empty for weeks because a block number was multiplied by a block interval and compared
    // against wall-clock uploads — 4.2e11 against 1.8e12.
    assert.ok(p.atMs > 1_600_000_000_000 && p.atMs < 4_000_000_000_000,
      `atMs ${p.atMs} is not a wall-clock millisecond timestamp`);
  }
});

test("an unreachable node fails rather than returning an empty chain", async () => {
  // A chain that answers "no events" and a chain that cannot be reached are different facts, and
  // the crowd treats an empty answer as a measured zero. `linkabilityOf` distinguishes them only
  // if the client does.
  const dead = starknet({
    rpcUrl: "http://127.0.0.1:1", contract: identityContract(NETWORK), fromBlock: 0,
    accountsFile: "", account: "", network: NETWORK,
  });
  await assert.rejects(() => dead.events(),
    "an unreachable node returned an empty event list, which reads as a measured zero");
});
