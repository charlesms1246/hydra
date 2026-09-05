/**
 * A vault that ANSWERS badly, which is a different failure from one that refuses.
 *
 * **THE HANDLER BUILT FOR AN ABSENT VAULT DOES NOT COVER A BROKEN ONE.** `effects.ts:describeFailure`
 * keys on `e.cause?.code` — `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT` —
 * all TRANSPORT failures. A vault that completes the connection and returns a 500, a 413, or an
 * nginx page has no `cause`, so it passes through untouched, and the "leave every other error
 * alone" rule that is right for an ENOENT naming its own path is wrong for this.
 *
 * Driven before it was fixed, and this is what a user got:
 *
 *     the vault refused the inbox read: <html><head><title>502 Bad Gateway</title></head><body…
 *     the vault refused the inbox read:                       ← a 503 with an empty body
 *     Unexpected token '<', "<html>hello</html>" is not valid JSON
 *
 * **REAL SERVERS, NOT STUBBED RESPONSES.** A `fetch` fake returning an object shaped like a
 * `Response` shares its assumptions with the code under test. These are `node:http` servers on
 * loopback answering the way a full disk, a proxy and a size limit actually answer.
 *
 * The states here are ordinary operations, not exotic ones: a full disk, an expired invite, a
 * proxy in front returning HTML, a body that stops halfway.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { httpTransport } from "../../handshake/src/inbox.ts";
import { render } from "../../tui/src/view.ts";
import { start } from "../../tui/src/app.ts";

/** A vault that answers however the test says, on a real socket. */
async function answering(reply: (res: import("node:http").ServerResponse) => void) {
  const server: Server = createServer((_req, res) => reply(res));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, server };
}

/** What a one-row TUI log actually shows at the default xterm width. */
function atEightyColumns(text: string): string {
  const m = start(null, 0);
  const frame = render({ ...m, log: [{ text, tone: "warn", at: 0 }] } as never,
    { rows: 24, cols: 80 });
  return frame.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

const CASES = [
  { name: "a full disk", status: 500, body: "", says: /failing rather than refusing/ },
  { name: "a proxy in front", status: 502, says: /failing rather than refusing/,
    body: "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway"
      + "</h1></center><hr><center>nginx/1.24.0</center></body></html>" },
  { name: "an expired invite", status: 401, body: "", says: /did not accept the invite/ },
  { name: "the operator's size limit", status: 413, body: "", says: /too large/ },
  { name: "rate limiting", status: 429, body: "", says: /rate-limiting/ },
];

for (const c of CASES) {
  test(`${c.name.toUpperCase()} — the status is named, and it survives 80 columns`, async () => {
    const v = await answering((res) => { res.writeHead(c.status); res.end(c.body); });
    try {
      const err = await httpTransport(v.url, []).get(["enc:1"]).then(() => null, (e) => e as Error);
      assert.ok(err, `a ${c.status} was treated as a successful read`);
      const said = err.message;

      assert.match(said, c.says, `a ${c.status} does not say what it means:\n  ${said}`);
      assert.ok(!said.includes("<"),
        `markup from the response body reached the user:\n  ${said}`);
      assert.ok(said.includes(String(c.status)),
        `the status code is missing, and it is the only part that tells a 413 from a 401 from a `
        + `503:\n  ${said}`);
      // The meaning has to be in the part that is not truncated away.
      const shown = atEightyColumns(said);
      assert.match(shown, c.says,
        `at 80 columns the meaning is cut off and the reader keeps only the address:\n  ${said}`);
    } finally { v.server.close(); }
  });
}

test("A 200 THAT IS NOT JSON is a diagnosis, not a parser error", async () => {
  // The captive-portal and half-written-body case. `JSON.parse`'s message names neither the vault
  // nor the fact that one was involved.
  for (const body of ["<html>hello</html>", '{"found":{"a":"AAA']) {
    const v = await answering((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    try {
      const err = await httpTransport(v.url, []).get(["enc:1"]).then(() => null, (e) => e as Error);
      assert.ok(err, "a body that is not JSON was treated as a successful read");
      assert.ok(!/Unexpected token|Unterminated string/.test(err.message),
        `a JavaScript parser error was shown to a user:\n  ${err.message}`);
      assert.match(atEightyColumns(err.message), /something is answering for the vault/,
        `the diagnosis does not survive 80 columns:\n  ${err.message}`);
    } finally { v.server.close(); }
  }
});

test("A REFUSED UPLOAD DOES NOT SPEND AN INVITE — the client threw its own credential away",
  async () => {
    // The sharpest of these, because it is silent and it is not recoverable. `put` did
    // `invites.shift()` BEFORE the request, so three uploads against a vault that stored nothing
    // took a client from five invites to two.
    //
    // The server spends nothing in these cases: a bad size bucket returns before `#invites` is
    // touched, and a bad code fails the delete. So the loss was entirely this client's doing.
    //
    // An invite is what a source asks an organisation for before their first message, cover spends
    // them at the cover rate, and running out stops the timing defence rather than the messaging.
    for (const status of [500, 401, 413, 429]) {
      const v = await answering((res) => { res.writeHead(status); res.end(""); });
      try {
        const invites = ["i1", "i2", "i3", "i4", "i5"];
        const t = httpTransport(v.url, invites);
        for (let i = 0; i < 3; i++) {
          assert.equal(await t.put(`enc:${i}`, new Uint8Array([1, 2, 3])), false,
            `a ${status} was reported to the caller as a successful upload`);
        }
        assert.equal(invites.length, 5,
          `three uploads the vault refused with ${status} cost ${5 - invites.length} invite(s). `
          + "Nothing was stored and the codes are gone.");
      } finally { v.server.close(); }
    }
  });

test("AND AN ACCEPTED UPLOAD STILL SPENDS ONE", async () => {
  // The other half: not spending on failure must not have turned into never spending. A code is
  // single-use, and a client that kept them would replay one the vault has already destroyed.
  const v = await answering((res) => { res.writeHead(201); res.end(""); });
  try {
    const invites = ["i1", "i2", "i3"];
    const t = httpTransport(v.url, invites);
    assert.equal(await t.put("enc:1", new Uint8Array([1])), true);
    assert.equal(await t.put("enc:2", new Uint8Array([1])), true);
    assert.deepEqual(invites, ["i3"], "an accepted upload did not spend its invite");
  } finally { v.server.close(); }
});
