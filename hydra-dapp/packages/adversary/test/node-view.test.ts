/**
 * The node's view, captured — the same acceptance condition `operator-view.test.ts` applies to
 * the vault, pointed at the party that had no table.
 *
 * `cli/src/node-view.ts` says what a JSON-RPC node learns from a client that reads and
 * publishes. This drives the real `chain.ts` against a recording transport and checks the table
 * in both directions: an observation with no row fails, and a row nothing can produce fails.
 *
 * WHAT THIS CANNOT CAPTURE, said here rather than left to be discovered. `publish` shells out
 * to `sncast`, so the submission does not pass through this seam and `node.submission` is
 * asserted from the code path rather than from a capture. That is a weaker check than the rest
 * of the file and the row is worth having anyway: the alternative is a table that omits the one
 * disclosure a user would most expect it to carry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { starknet } from "../../cli/src/chain.ts";
import { NODE_OBSERVABLE, NODE_OBSERVABLE_IDS, NODE_NOT_OBSERVABLE, nodeWhyOf }
  from "../../cli/src/node-view.ts";

const CONTRACT = "0x06ea776549f898490b11aca1d49af58498d6a5246f3847ad4fa163f97ffcb0c6";
const FROM_BLOCK = 14319650;

type Seen = { url: string; method: string; params: any };

/** A node that records what it was asked, and answers with two pages so paging is exercised. */
function recordingNode(): { seen: Seen[]; fetchImpl: typeof fetch } {
  const seen: Seen[] = [];
  let page = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push({ url: String(url), method: body.method, params: body.params });
    const first = page++ === 0;
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      result: {
        events: [{ data: ["0x1", "0x2"] }],
        ...(first ? { continuation_token: "next" } : {}),
      },
    }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const read = async () => {
  const { seen, fetchImpl } = recordingNode();
  const chain = starknet({
    rpcUrl: "https://node.example/rpc", contract: CONTRACT, fromBlock: FROM_BLOCK,
    accountsFile: "/dev/null", account: "a", network: "sepolia",
  }, fetchImpl);
  const events = await chain.events();
  // And the sender lookup, because `node.txLookup` is only producible when a client actually
  // asks who published. `decisions/0029`'s crowd needs it; the row exists because the node sees
  // it happen.
  await chain.senders!(["0xdeadbeef"]);
  return { seen, events };
};

/** What the capture proves the node holds. Derived from the requests, never hand-listed. */
function observedKeys(seen: readonly Seen[]): string[] {
  const keys = new Set<string>();
  // Every request is an HTTP request to somebody's server, so the peer and the timing come with
  // it whether or not this client thinks about them.
  if (seen.length) {
    keys.add("node.peer");
    keys.add("node.readTiming");
  }
  for (const r of seen) {
    if (r.method === "starknet_getEvents") {
      const f = r.params.filter;
      if (f.address) keys.add("node.readRange");
    }
    if (r.method === "starknet_getTransactionByHash") keys.add("node.txLookup");
  }
  // Asserted from the code path rather than captured — see the header.
  const chainSrc = readFileSync(
    join(import.meta.dirname, "../../cli/src/chain.ts"), "utf8");
  if (/execFileSync\("sncast"/.test(chainSrc)) keys.add("node.submission");
  return [...keys].sort();
}

// ---------------------------------------------------------------------------

test("everything the node can observe is on its published table", async () => {
  const { seen } = await read();
  const observed = observedKeys(seen);
  assert.ok(observed.length > 0, "the client made no request the node could see at all");
  const undocumented = observed.filter((k) => !NODE_OBSERVABLE_IDS.includes(k));
  assert.deepEqual(undocumented, [],
    `observable but undocumented — add a row to cli/src/node-view.ts:\n${undocumented.join("\n")}`);
});

test("everything the node's table claims is observable actually is", async () => {
  // The direction a disclosure table normally skips. A row nobody can produce teaches readers
  // that the list is decorative, and then the rows that are true get ignored with it.
  const { seen } = await read();
  const observed = new Set(observedKeys(seen));
  const unproduced = NODE_OBSERVABLE_IDS.filter((id) => !observed.has(id));
  assert.deepEqual(unproduced, [],
    `documented but not observable — the node table over-claims:\n${unproduced.join("\n")}`);
});

test("the read names a contract and a block, and nothing about what was wanted", async () => {
  // `node.wantedEvent`, and its mechanism. The client asks for the whole log and filters at
  // home, so the request carries no pointer, no sequence and no key. A future optimisation that
  // narrowed the query to the events this client cares about would delete this guarantee while
  // making everything faster, which is exactly the trade this assertion exists to block.
  const { seen, events } = await read();
  // Only the event reads. The sender lookup is a different request with a different shape, and
  // it has its own row (`node.txLookup`) and its own constraint — window-wide, never a chosen
  // subset — asserted below.
  const reads = seen.filter((r) => r.method === "starknet_getEvents");
  assert.equal(reads.length, 2, "the paging loop stopped early; the capture is not a full read");
  for (const r of reads) {
    const f = r.params.filter;
    assert.equal(f.address, CONTRACT);
    assert.equal(f.from_block.block_number, FROM_BLOCK);
    assert.equal(f.to_block, "latest");
    const wire = JSON.stringify(r.params);
    assert.ok(!/"keys"/.test(wire),
      "the read filtered on keys — the node now learns which event was wanted");
  }
  // And the client really did take the whole log rather than one entry.
  assert.equal(events.length, 2);

  // The sender lookup names transactions, which is exactly why it is a separate row. What keeps
  // `node.wantedEvent` true is that it covers the window rather than a selection out of it — a
  // client that resolved only the transactions it found interesting would be telling the node
  // which ones those were.
  const lookups = seen.filter((r) => r.method === "starknet_getTransactionByHash");
  assert.equal(lookups.length, 1);
  assert.ok(Array.isArray(lookups[0].params), "a tx lookup takes a positional hash");
});

test("nothing the node is sent carries a message or names a conversation", async () => {
  // `node.channel` and `node.content`. The felts are a pointer and a commitment; the body is in
  // a vault under a key nobody in this exchange holds.
  const { seen } = await read();
  const wire = JSON.stringify(seen);
  for (const word of ["message", "plaintext", "channel", "bodyB64"]) {
    assert.ok(!wire.includes(word), `"${word}" reached the node`);
  }
});

test("every node guarantee names a mechanism, and no two share one", () => {
  // The rule `observations.ts` learned the hard way: a row with one mechanism and two claims is
  // a row with one claim proven, and two claims resting on one assertion is the same defect in
  // smaller print.
  const used = new Map<string, string>();
  for (const g of NODE_NOT_OBSERVABLE) {
    assert.ok(g.because.length > 0, `${g.id} claims a guarantee with no mechanism`);
    for (const b of g.because) {
      assert.ok(!used.has(b.mechanism),
        `${g.id} and ${used.get(b.mechanism)} both rest on ${b.mechanism}`);
      used.set(b.mechanism, g.id);
    }
    assert.ok(nodeWhyOf(g).length > 0);
  }
});

test("the vault's table and the node's stay separate, because the parties are", () => {
  // A user who runs their own vault has not thereby stopped telling a node where they are. If
  // these ever merge, the merged list is one no single operator can produce.
  const ids = new Set(NODE_OBSERVABLE.map((o) => o.id));
  assert.equal(ids.size, NODE_OBSERVABLE.length, "duplicate id on the node table");
  for (const id of ids) {
    assert.ok(id.startsWith("node."),
      `${id} is on the node's table without saying so in its name`);
  }
});
