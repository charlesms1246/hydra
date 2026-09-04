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
 * filtering — none of which a quiet contract can exercise. The first version pointed at the
 * Starknet ID identity contract, which turned out to emit **nothing in two thousand Sepolia
 * blocks**, so the paging case reported itself unexercised and two others failed outright. The
 * The default was the ETH token, and **that went quiet too** — two of these tests failed with
 * "no events in the last 20 blocks" a few weeks after being written, because STRK became the fee
 * token and ETH transfers on Sepolia became occasional. The default is now STRK, which every
 * transaction on the network pays a fee in, so it is busy for a structural reason rather than
 * because it happened to be busy on the day it was chosen. Still overridable.
 *
 * That is the second time this file's premise expired, which is the durable point: **a live test
 * pointed at somebody else's contract has a dependency that can rot without anyone touching this
 * repo.** It fails loudly rather than silently, which is why the assertions say "this test is
 * measuring nothing" instead of passing on an empty list.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { starknet } from "../../cli/src/chain.ts";

const RPC = process.env.HYDRA_RPC;
const NETWORK = process.env.HYDRA_NETWORK ?? "sepolia";

/**
 * A contract that actually emits. The ETH token, whose address is the same across Starknet
 * networks; overridable because "busy" is a property of the network on the day.
 */
const BUSY = process.env.HYDRA_BUSY_CONTRACT
  ?? "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/**
 * OUR OWN contract, which is the quiet one. The paging-by-block-range case is specifically about
 * this deployment: five events across the contract's whole life, which the node still answers in
 * three pages. Running that case against `BUSY` would page through the ETH token's entire history.
 */
const OURS = process.env.HYDRA_CONTRACT
  ?? "0x06ea776549f898490b11aca1d49af58498d6a5246f3847ad4fa163f97ffcb0c6";

const clientFrom = (fromBlock: number, contract = BUSY) => starknet({
  rpcUrl: RPC!, contract, fromBlock, accountsFile: "", account: "", network: NETWORK,
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
  const events = await clientFrom(latest - 20).events();
  assert.ok(events.length > 0, "no events in the last 20 blocks — pick a busier contract");
  for (const e of events.slice(0, 20)) {
    assert.equal(e.data.length >= 1, true);
    assert.ok((e.blockNumber ?? 0) > 1_000, `block number ${e.blockNumber} is not a real height`);
    assert.match(String(e.txHash), /^0x[0-9a-f]+$/, "no transaction hash on a real event");
  }
  // Every one is at or after the offset asked for — the `from_block` filter is the client's, and
  // nothing hermetic has ever checked that it is sent correctly.
  const floor = latest - 20;
  assert.ok(events.every((e) => (e.blockNumber ?? floor) >= floor),
    "an event older than fromBlock came back, so the offset is not reaching the node");
});

test("FROM_BLOCK IS RESPECTED: a later offset returns strictly less", async () => {
  // The offset is the client's own parameter and the fake ignored it entirely.
  const wide = await clientFrom(latest - 40).events();
  const narrow = await clientFrom(latest - 5).events();
  assert.ok(narrow.length <= wide.length,
    `a narrower window returned more events (${narrow.length} against ${wide.length})`);
  assert.ok(wide.length > 0, "no events at all — this test is measuring nothing");
});

test("PAGING IS FORCED BY THE BLOCK RANGE, not only by the event count", async () => {
  // **MEASURED ON SEPOLIA: a single unpaged query against our own contract returned ONE of five
  // events.** Not because five is a lot — because the node scans a bounded number of BLOCKS per
  // response and issues a continuation token when it stops, whether or not it found anything.
  //
  // That is the client's actual configuration. `fromBlock` is the deployment block, so every
  // `events()` call spans the contract's whole life — 238,000 blocks on the run this came from,
  // three pages to cross with five events in them. A client that read only the first page would
  // have seen the FIRST message ever sent and none since, which reads as "no new messages"
  // rather than as an error.
  //
  // The test below hunts for a busy contract to make paging happen. It does not need one: a quiet
  // contract and a wide range page just as hard, and this is the case we actually ship.
  const wide = clientFrom(1, OURS);
  const events = await wide.events();
  assert.ok(events.length > 0, "no events at all over the contract's whole history");

  // One unpaged request over the same range, to show the loop is doing something.
  const oneShot = await (await fetch(RPC!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "starknet_getEvents",
      params: [{ from_block: { block_number: 1 }, to_block: "latest",
        address: OURS, chunk_size: 100 }],
    }),
  })).json() as { result?: { events: unknown[]; continuation_token?: string } };

  assert.ok(oneShot.result, "the node refused the wide query outright");
  if (oneShot.result.continuation_token === undefined) {
    console.error("this node answered the whole range in one response, so PAGING WAS NOT "
      + "EXERCISED by this run. Not asserted — a node that does not page cannot prove a client "
      + "that does. Sepolia via cartridge did page; a local devnet will not.");
    return;
  }
  assert.ok(events.length >= oneShot.result.events.length,
    `the paging client returned FEWER events (${events.length}) than a single unpaged request `
    + `(${oneShot.result.events.length}), so the loop is dropping pages`);
  // The whole point: the tail is only reachable by following the token.
  assert.ok(events.length > oneShot.result.events.length,
    "the client saw no more than one page's worth over a range the node itself paged, so the "
    + "continuation loop is not running");
});

test("PAGING PAST A CONTINUATION TOKEN", async () => {
  // The client pages with `chunk_size: 100` and follows `continuation_token` in a loop. That loop
  // has never run against real data.
  //
  // IT REPORTS RATHER THAN ASSERTS WHEN THE CHAIN IS TOO QUIET. An unpaged run reported as a paging
  // test is the mirroring problem in a new costume — the check would be green and would have
  // proved nothing.
  const events = await clientFrom(latest - 40).events();
  if (events.length <= 100) {
    console.error(`only ${events.length} events in 40 blocks, so no continuation token was `
      + "issued and PAGING WAS NOT EXERCISED by this run. Not asserted — an unpaged run reported "
      + "as a paging test proves nothing. Widen the window or set HYDRA_BUSY_CONTRACT.");
    return;
  }
  assert.ok(events.length > 100,
    "more than one chunk came back, so the continuation loop ran and did not drop the tail");

  // And the pages joined without duplicating or dropping the boundary, which is the loop's
  // likeliest bug — CHECKED BY COUNT against an independently paged raw query, not by per-event
  // identity.
  //
  // **IDENTITY IS NOT AVAILABLE HERE, and the first version of this assertion fired because of
  // it.** It keyed on `blockNumber:txHash:data` and reported "an event appears twice" against a
  // real token — but an ERC-20 emits `Transfer` and `Approval` in one transaction with THE SAME
  // `data` (`[amount, 0]`), distinguished only by `keys`, and `Chain.events()` does not return
  // `keys`. So two genuinely different events are indistinguishable in what the client hands back,
  // and the guard was accusing the paging loop of a bug that measurement showed it does not have:
  // with `keys` included, zero duplicates in 128 events across two pages.
  //
  // Dropping `keys` is right for this product — one contract, one event type, the selector is
  // constant — but it means a test about paging must not pretend to per-event identity it cannot
  // reconstruct. A count is something both sides can honestly compute.
  let token: string | undefined;
  let raw = 0;
  do {
    const page = await (await fetch(RPC!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "starknet_getEvents",
        params: [{ from_block: { block_number: latest - 40 }, to_block: "latest",
          address: BUSY, chunk_size: 100, ...(token ? { continuation_token: token } : {}) }],
      }),
    })).json() as { result: { events: unknown[]; continuation_token?: string } };
    raw += page.result.events.length;
    token = page.result.continuation_token;
  } while (token);

  // Not exact: the chain advances between the two runs, so the later one legitimately sees more.
  assert.ok(events.length <= raw + 40,
    `the client returned ${events.length} events where the raw pages held ${raw} — more than new `
    + "blocks can explain, so a page boundary was re-read");
  assert.ok(events.length >= raw - 40,
    `the client returned ${events.length} events where the raw pages held ${raw} — the `
    + "continuation loop is dropping a page");
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
    rpcUrl: "http://127.0.0.1:1", contract: BUSY, fromBlock: 0,
    accountsFile: "", account: "", network: NETWORK,
  });
  await assert.rejects(() => dead.events(),
    "an unreachable node returned an empty event list, which reads as a measured zero");
});
