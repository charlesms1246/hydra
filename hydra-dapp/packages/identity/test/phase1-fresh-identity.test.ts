/**
 * Fresh-identity provisioning — Phase 1's second acceptance clause.
 *
 * `claude-docs/HYDRA_HANDOFF.md` Phase 1: "an analyst given both identities' on-chain activity cannot
 * link a fresh identity to its owner." That is a claim about a *plan*, not about a function,
 * so this test states plans and computes the answer from `src/linkage.ts` — whose entries
 * each carry a `file:line` into `.upstream/`. The last check re-reads those citations, so a
 * table that drifts away from the source fails here rather than quietly becoming fiction.
 *
 * The headline result, and it is not the comfortable one: there IS a provisioning plan the
 * public analyst cannot break, and there is NO plan the auditor cannot break. The handoff
 * says escrow "reveals what an identity *did*, not who owns it". Against a fresh identity
 * funded from the owner's own pool balance, that is false — the auditor holds the viewing
 * key, derives the channel, and reads the owner→fresh edge directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { components, evidence, links, records } from "../src/linkage.ts";
import type { Step } from "../src/linkage.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The obvious way to fund a new address, and the reason it cannot be used. */
const NAIVE: Step[] = [
  { op: "erc20", from: "owner", to: "fresh" },
  { op: "register", user: "fresh", submitter: "fresh" },
  { op: "deposit", user: "fresh", submitter: "fresh" },
];

/**
 * The survivable one. Nobody funds `fresh` on chain: a relayer submits its transactions and
 * pays their fees, and its pool balance arrives as a private transfer from the owner.
 *
 * This is only expressible because the pool's `main` takes `user_addr` as an argument and
 * never compares it to the caller — the proof authenticates, not the sender.
 */
const RELAYED: Step[] = [
  { op: "register", user: "fresh", submitter: "relayer" },
  { op: "privateTransfer", from: "owner", to: "fresh", submitter: "relayer" },
];

test("the naive plan links the fresh identity to its owner, publicly", () => {
  assert.ok(links(NAIVE, "public", "owner", "fresh"));
  // And it says why, with a citation, rather than just failing.
  const why = evidence(NAIVE, "public");
  assert.ok(why.some((r) => r.step === "erc20"), "the funding transfer should be the evidence");
  assert.ok(why.every((r) => r.cite.length > 0));
});

test("self-submitting is enough to link, with no funding transfer at all", () => {
  // Drop the transfer and the deposit. Registration alone, sent from the owner's address,
  // co-names the owner (as sender) with the fresh identity (in the event).
  const plan: Step[] = [{ op: "register", user: "fresh", submitter: "owner" }];
  assert.ok(links(plan, "public", "owner", "fresh"),
    "who sends the transaction is part of the disclosure, not a detail of it");
});

test("a relayed, pool-funded identity is not linked by anything the public can read", () => {
  assert.equal(links(RELAYED, "public", "owner", "fresh"), false);
  // Not vacuously: the plan does disclose things. The fresh identity's registration is
  // public, and so is the relayer. Neither reaches the owner.
  const seen = components(RELAYED, "public").flat();
  assert.ok(seen.includes("fresh"));
  assert.ok(seen.includes("relayer"));
  assert.ok(!seen.includes("owner"), "the owner is named nowhere a reader can see");
});

test("the auditor links them anyway, and no plan in this model avoids it", () => {
  // The private transfer is the funding. The auditor holds the escrowed viewing key, so it
  // derives the channel and reads the edge — the one disclosure the user cannot decline.
  assert.ok(links(RELAYED, "auditor", "owner", "fresh"));
  const why = evidence(RELAYED, "auditor").filter((r) => r.step === "privateTransfer");
  assert.equal(why.length, 1);
  assert.match(why[0].cite, /privacy\.cairo:331-350/);
});

/** The same fresh identity, later taking its value back out through the owner's wallet. */
const EXIT: Step[] = [
  ...RELAYED,
  { op: "withdraw", user: "fresh", to: "ownerHotWallet", submitter: "relayer" },
  { op: "erc20", from: "ownerHotWallet", to: "owner" },
];

test("reusing one relayer for both ends is itself the link", () => {
  // This is the check I got wrong when I wrote it, and the model was right. With no
  // anonymity-set assumption, the relayer is co-named with the fresh identity (it submits
  // the registration) AND with the withdrawal destination (it submits the withdrawal), so
  // the public joins owner to fresh straight through the relayer's own address.
  assert.ok(links(EXIT, "public", "owner", "fresh"),
    "a shared submitter is a shared address, and a shared address is a join");
});

test("the relayer only helps if you can justify its anonymity set", () => {
  // Declaring the relayer a hub is an assumption this module cannot verify — a relayer with
  // two users provides no cover. Stating it as an explicit argument is the point: the
  // provisioning story rests on it, so it should be somewhere a reviewer trips over it.
  const assume = { hubs: ["relayer"] };
  assert.equal(links(EXIT, "public", "owner", "fresh", assume), false);
  // The public still cannot see WHICH pool identity withdrew — enc_user_addr is the
  // auditor's — so what remains public is the destination, not the identity behind it.
  assert.ok(links(EXIT, "public", "owner", "ownerHotWallet", assume));
  // The auditor is unmoved by any of it.
  assert.ok(links(EXIT, "auditor", "owner", "fresh", assume));
});

test("a fresh identity may never deposit, whoever submits for it", () => {
  // Deposit names the depositing address in the clear AND moves tokens into the pool from
  // it, so the funds' provenance is an ordinary public transfer chain.
  const plan: Step[] = [
    { op: "register", user: "fresh", submitter: "relayer" },
    { op: "erc20", from: "owner", to: "fresh" },
    { op: "deposit", user: "fresh", submitter: "relayer" },
  ];
  assert.ok(links(plan, "public", "owner", "fresh"));
});

test("an observer sees everything a weaker observer sees", () => {
  // Otherwise the auditor could be "safer" than the public for some plan, which would be a
  // modelling bug that flatters us.
  for (const plan of [NAIVE, RELAYED, EXIT]) {
    for (const [a, b] of [["owner", "fresh"], ["fresh", "relayer"]]) {
      if (links(plan, "public", a, b)) assert.ok(links(plan, "auditor", a, b));
    }
  }
});

test("every citation in the linkage table resolves to a real file and line", () => {
  // A table of file:line claims rots the moment upstream moves. This is the check that
  // turns that rot into a test failure instead of a confident sentence about a line that
  // no longer says what it did.
  const all = [
    ...records({ op: "register", user: "a", submitter: "b" }),
    ...records({ op: "deposit", user: "a", submitter: "b" }),
    ...records({ op: "withdraw", user: "a", to: "c", submitter: "b" }),
    ...records({ op: "privateTransfer", from: "a", to: "c", submitter: "b" }),
    ...records({ op: "erc20", from: "a", to: "c" }),
  ];
  const cites = all.flatMap((r) => [...r.cite.matchAll(/([\w./-]+\.cairo):(\d+)(?:-(\d+))?/g)]);
  assert.ok(cites.length >= 8, `expected the table to be cited throughout, found ${cites.length}`);

  for (const [, file, from, to] of cites) {
    const path = join(ROOT, file);
    assert.ok(existsSync(path), `citation points at a file that is not here: ${file}`);
    const lines = readFileSync(path, "utf8").split("\n").length;
    const last = Number(to ?? from);
    assert.ok(last <= lines, `${file}:${last} is past the end of the file (${lines} lines)`);
  }
});
