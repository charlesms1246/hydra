/**
 * Where a client starts reading, and what that cost.
 *
 * **MEASURED AGAINST LIVE SEPOLIA: the read took 102,643 ms and 178 RPC round trips to return six
 * events.** `init` defaults `fromBlock` to 0, nothing ever advances it, and `readChannel` asks for
 * the contract's whole log — so every read scanned **14.3 million blocks that existed before the
 * contract was deployed**. With `fromBlock` at the deployment: **1,002 ms and 3 calls, same six
 * events.** End to end, `hydra read` went from **97 seconds to 1.6**.
 *
 * **THE PART THAT MATTERED WAS DECIDING IT IS NOT A PRIVACY TRADE.** The obvious "fix" — advance
 * `fromBlock` as you read — IS one: it tells the node **when you last synchronised**, a fact about
 * the reader with no row on any table. Moving the START to the deployment is different in kind. It
 * is the same contiguous range, unfiltered, `to_block` still `latest`, and nothing before a
 * contract exists can hold an event anyone wanted. `node.wantedEvent` and `whole-log-read` are
 * exactly as true afterwards.
 *
 * A guard on the shape, not just the number, because the tempting version of this optimisation is
 * the one that deletes the guarantee — as `node-view.test.ts` says, *"a future optimisation that
 * narrowed the query to the events this client cares about would delete this guarantee while
 * making everything faster"*. This one narrows the range and not the query.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deploymentBlock, blockHeight, starknet } from "../../cli/src/chain.ts";

/** A node where the contract appears at `at`, recording every block it was asked about. */
function nodeWithDeployment(at: number, latest: number) {
  const asked: number[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: any };
    if (body.method === "starknet_blockNumber") {
      return { json: async () => ({ result: latest }) } as unknown as Response;
    }
    const block = body.params[0].block_number as number;
    asked.push(block);
    return {
      json: async () => (block >= at
        ? { result: "0xclass" }
        : { error: { code: 20, message: "Contract not found" } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, asked };
}

test("THE DEPLOYMENT BLOCK IS FOUND EXACTLY, and in a couple of dozen calls rather than hundreds",
  async () => {
    const latest = 14_538_000;
    const at = 14_319_650;
    const node = nodeWithDeployment(at, latest);
    assert.equal(await deploymentBlock("http://node", "0xc", latest, node.impl), at);

    // log2(14.5M) ≈ 24, plus the one probe at the tip. The whole point is that this is not a scan.
    assert.ok(node.asked.length < 30,
      `bisection took ${node.asked.length} calls; a scan is what this replaces`);
    // And it is paid ONCE, at init, against a cost of 178 calls on EVERY read — so it pays for
    // itself before the first read finishes, and the saving is unbounded thereafter.
    assert.ok(node.asked.length < 178,
      `the one-time discovery costs ${node.asked.length} calls against 178 per read, so it does `
      + "not pay for itself in a single read");
  });

test("a contract absent at the tip is refused, rather than starting from 0 forever", async () => {
  // The wrong address, or the wrong network, produces an empty inbox that looks like no messages.
  // Saying so at `init` is the only cheap moment.
  const latest = 100;
  const node = nodeWithDeployment(latest + 1, latest);
  await assert.rejects(() => deploymentBlock("http://node", "0xc", latest, node.impl),
    /not deployed at block 100/);
});

test("a contract in block 0 is found, and the bisection does not run off the bottom", async () => {
  const node = nodeWithDeployment(0, 500);
  assert.equal(await deploymentBlock("http://node", "0xc", 500, node.impl), 0);
});

test("blockHeight refuses a node that answers with no height", async () => {
  const impl = (async () => ({ json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(() => blockHeight("http://node", impl), /did not report a block height/);
});

test("THE REQUEST SHAPE IS UNCHANGED — a later start is still the whole log", async () => {
  // The disclosure, not the speed. `node.wantedEvent` rests on the request naming no pointer, no
  // key and no sequence, and on the range being a range rather than a selection. A non-zero
  // `fromBlock` must change the number in `from_block` and NOTHING else.
  const seen: any[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)).params);
    return { json: async () => ({ result: { events: [] } }) } as unknown as Response;
  }) as unknown as typeof fetch;

  const cfg = { rpcUrl: "http://node", contract: "0xc", accountsFile: "", account: "" };
  await starknet({ ...cfg, fromBlock: 0 }, impl).events();
  await starknet({ ...cfg, fromBlock: 14_319_650 }, impl).events();

  const [genesis, deployed] = seen;
  assert.equal(genesis.filter.from_block.block_number, 0);
  assert.equal(deployed.filter.from_block.block_number, 14_319_650);
  // Everything else identical: same contract, still open-ended, still no key filter.
  assert.equal(deployed.filter.to_block, "latest");
  assert.equal(deployed.filter.address, genesis.filter.address);
  assert.ok(!("keys" in deployed.filter),
    "the read filtered on keys — the node now learns which event was wanted");
  assert.deepEqual(
    { ...deployed.filter, from_block: null },
    { ...genesis.filter, from_block: null },
    "starting later changed something other than where the range starts");
});
