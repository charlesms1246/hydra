/**
 * The interface, driven by keystrokes, with no terminal.
 *
 * `cli-conversation.test.ts` drives `commands.ts`. This drives the thing on top of them — the
 * modal reducer, the effect runner and the renderer — because the platform's only front end is
 * now a TUI, and a front end that is only checked by a person looking at it is a front end whose
 * regressions ship.
 *
 * Two properties are worth more than the rest here.
 *
 * ONE: the frame cannot outgrow its terminal. A line wider than the screen wraps, every box
 * below it shifts by a row, and the interface becomes unreadable rather than merely wrong. It is
 * checked at a width where the text does not comfortably fit, because that is when it happens.
 *
 * TWO: the costs stay next to the actions. `hydra send` prints four lines saying the chain shows
 * that you sent something; `hydra invite` prints six saying the vault operator learns you are
 * reachable. A GUI is exactly where that text quietly becomes a help page nobody opens, so the
 * words are asserted to be on the page that performs the act.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DENIABLE } from "../../claims/src/warnings.ts";
import { decode } from "../../tui/src/keys.ts";
import { start, update, PAGES, selected } from "../../tui/src/app.ts";
import type { Model, Event } from "../../tui/src/app.ts";
import { render } from "../../tui/src/view.ts";
import { perform } from "../../tui/src/effects.ts";
import type { Deps } from "../../tui/src/effects.ts";
import { width } from "../../tui/src/screen.ts";
import { memoryChain } from "../../cli/src/chain.ts";
import { publishBundle, encodeWire } from "../../cli/src/commands.ts";
import { Vault } from "../../vault-server/src/server.ts";
import { serve } from "../../vault-server/src/http.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { MIN_JITTER_BLOCKS } from "../../channel/src/schedule.ts";

const BLOCK = 30_000;
const T0 = 1_800_000_000_000;
const SIZE = { rows: 24, cols: 100 };

/** A fake filesystem, so `export` and `invite` exchange a file without touching a disk. */
function harness(url: string, invites: string[], chain = memoryChain()) {
  const files = new Map<string, string>();
  let now = T0;
  const deps: Deps = {
    save: () => {},
    readFile: (p) => {
      const f = files.get(p);
      if (f === undefined) throw new Error(`no such file: ${p}`);
      return f;
    },
    writeFile: (p, text) => { files.set(p, text); },
    chain: () => chain,
    fetchImpl: fetch,
    now: () => now,
  };
  return { deps, files, chain, invites, url, at: (t: number) => { now = t; } };
}

/** Apply one event, then whatever its effects produce. Recursion ends because effects do not. */
async function step(m: Model, deps: Deps, event: Event): Promise<Model> {
  const s = update(m, event);
  let next = s.model;
  for (const e of s.effects) next = await step(next, deps, await perform(e, next.state, deps));
  return next;
}

const feed = async (m: Model, deps: Deps, keys: string): Promise<Model> => {
  for (const k of decode(keys)) m = await step(m, deps, { t: "key", key: k });
  return m;
};

const text = (m: Model, size = SIZE) => render(m, size).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The frame as readable prose: colours gone, box drawing gone, whitespace collapsed.
 *
 * For asserting that a sentence is on screen. A frame wraps at the terminal width and puts a
 * border between the halves, so any sentence worth checking will straddle one sooner or later —
 * matching against the raw frame passes until the wording changes length by a word.
 */
const prose = (m: Model, size = SIZE) =>
  text(m, size).replace(/[\u2500-\u257f]/g, " ").replace(/\s+/g, " ");

async function vault(n = 400) {
  const invites = Array.from({ length: n }, (_, i) => `tui-${i}`);
  const v = new Vault({ invites: [...invites], buckets: BUCKETS });
  const { url, server } = await serve(v);
  return { v, url, server, invites };
}

/** A model that already has an identity, built through the setup page rather than around it. */
async function created(h: ReturnType<typeof harness>, extra: Partial<Record<string, string>> = {}): Promise<Model> {
  let m = start(null, T0);
  assert.equal(m.page, "setup");
  m = { ...m, fields: { ...m.fields, vault: h.url, contract: "0x1", invites: h.invites.join(","), ...extra } };
  m = await step(m, h.deps, { t: "key", key: { t: "enter" } });
  assert.equal(m.page, "chats", "creating an identity did not leave the first-run page");
  return { ...m, state: { ...m.state!, blockMs: BLOCK } };
}

// ---------------------------------------------------------------------------

test("every page renders inside its terminal, at a width where it does not fit", async () => {
  const { url, server, invites } = await vault();
  try {
    const h = harness(url, invites);
    const m = await created(h);
    for (const size of [{ rows: 24, cols: 100 }, { rows: 12, cols: 46 }, { rows: 40, cols: 200 }]) {
      for (const page of PAGES) {
        const lines = render({ ...m, page: page.id }, size);
        assert.ok(lines.length <= size.rows,
          `${page.id} at ${size.cols}x${size.rows} drew ${lines.length} rows`);
        for (const [i, line] of lines.entries()) {
          assert.ok(width(line) <= size.cols,
            `${page.id} row ${i} is ${width(line)} wide in a ${size.cols}-column terminal`);
        }
      }
    }
  } finally { server.close(); }
});

test("the costs are on the page that performs the act, not in a help screen", async () => {
  const { url, server, invites } = await vault();
  try {
    const h = harness(url, invites);
    const m = await created(h);
    // Sending: the chain names the author. Every published guarantee in this repo is about
    // WHICH upload holds the text, never about whether you sent one.
    assert.match(prose({ ...m, page: "chats" }), /chain shows that YOU published/);
    // Inviting: the vault operator learns the recipient is reachable, and can count what is
    // waiting. `observations.ts` DERIVABLE carries the rows.
    assert.match(prose({ ...m, page: "connect" }), /reachable/);
    assert.match(prose({ ...m, page: "connect" }), /90%/);
    // The identity page says where the root key is and what protects it, which is `0600`.
    // PINS A CLAIM THAT IS ABOUT TO BECOME FALSE. The user has decided to encrypt the seed at
    // rest, and when that lands "in the clear" is wrong — and this line would require the TUI to
    // keep saying it. Left in place deliberately, because removing it now would drop the check
    // that the identity page discloses what protects the key at all; it is recorded here so the
    // key-at-rest work changes the CLAIM and this assertion together, from one source.
    assert.match(prose({ ...m, page: "identity" }), /in the clear/);
    // Publishing a signing key is its own page because it is its own act: it is the only thing
    // in the product that deliberately puts a permanent, public link between the messaging
    // identity and a chain address. It went on Identity first and pushed the line above off the
    // bottom of the frame, which is how this assertion earned its neighbour.
    assert.match(prose({ ...m, page: "record" }), /CANNOT BE UNDONE/);
    assert.match(prose({ ...m, page: "record" }), /joins to your conversations/);
    // And the disclosure page is the generated statement, not prose.
    assert.match(prose({ ...m, page: "disclosure" }), /generated from the code/);
  } finally { server.close(); }
});

test("modal: letters act in command mode and type in typing mode", async () => {
  const { url, server, invites } = await vault();
  try {
    const h = harness(url, invites);
    let m = await created(h);
    // A digit in command mode is a page.
    m = await feed(m, h.deps, "5");
    assert.equal(m.page, "disclosure");
    m = await feed(m, h.deps, "2");
    assert.equal(m.page, "connect");
    // `i` starts typing; the same digit now goes into the field.
    m = await feed(m, h.deps, "i4");
    assert.equal(m.page, "connect", "a digit switched pages while the user was typing");
    assert.equal(m.fields.peerName, "4");
    // Escape leaves, and the digit is a page again.
    m = await feed(m, h.deps, "\x1b3");
    assert.equal(m.page, "identity");
  } finally { server.close(); }
});

test("a whole conversation, typed", async () => {
  const { url, server, invites, v } = await vault();
  try {
    const chain = memoryChain();
    const ha = harness(url, invites, chain);
    const hb = harness(url, invites, chain);
    let alice = await created(ha);
    let bob = await created(hb);

    // Bob writes his bundle to a file and it reaches alice by some route this program is not.
    bob = await feed(bob, hb.deps, "2e");
    const bundleFile = "bob.json";
    ha.files.set(bundleFile, hb.files.get("bundle.json")!);

    // Alice names him, points at the file, and presses Enter. That opens the channel AND
    // delivers the prekey message through the vault — no second command.
    alice = await feed(alice, ha.deps, "2i");
    alice = await feed(alice, ha.deps, "bob\t");
    alice = await feed(alice, ha.deps, `${bundleFile}\r`);
    assert.deepEqual(Object.keys(alice.state!.channels), ["bob"]);
    assert.match(alice.log.at(-1)!.text, /check that fingerprint/);

    // Bob collects. The channel is named after the fingerprint, because that is all he knows.
    bob = await feed(bob, hb.deps, "c");
    const [name] = Object.keys(bob.state!.channels);
    assert.match(name, /^from-[0-9a-f]{12}$/);

    // Alice types a message and sends it.
    const stored = v.observe().rows.length;
    alice = await feed(alice, ha.deps, "1i");
    alice = await feed(alice, ha.deps, "meet me at the usual place\r");
    assert.equal(alice.fields.compose, "", "the compose line kept the message after sending");
    assert.equal(chain.published.length, 1);
    // Not zero: the invite's prekey message is already in the vault. What must not have moved
    // is the object count, because `send` publishing and uploading in one act is the whole of
    // what the timing defence prevents.
    assert.equal(v.observe().rows.length, stored, "send uploaded — the timing defence is gone");

    // Time passes, and the ticks upload. Nobody pressed anything.
    //
    // ONE OBJECT PER TICK, which is the burst defence and not an accident of the harness. A tick
    // that uploaded everything due would put a message and its four decoys in one instant, and
    // `upload.burst` is what the vault operator reads off that. So five objects take five ticks,
    // and the count is asserted rather than looped away — if a change makes a tick upload the lot
    // again, this is where it shows.
    const queued = alice.state!.pending.length;
    const uploadAt = Math.max(...alice.state!.pending.map((p) => p.uploadAt));
    let ticks = 0;
    while (alice.state!.pending.length > 0 && ticks < queued + 5) {
      ha.at(uploadAt + MIN_JITTER_BLOCKS * BLOCK);
      alice = await step(alice, ha.deps, { t: "tick", now: uploadAt + MIN_JITTER_BLOCKS * BLOCK });
      ticks++;
    }
    assert.equal(alice.state!.pending.length, 0, "the resident ticks did not upload what was due");
    assert.equal(ticks, queued,
      `${queued} objects took ${ticks} ticks — one per tick is the burst defence`);
    assert.ok(v.observe().rows.length > stored + 1, "the message went up with no cover");

    // Bob reads it.
    bob = { ...bob, channel: 0 };
    assert.equal(selected(bob), name);
    bob = await feed(bob, hb.deps, "1r");
    assert.deepEqual(bob.transcript[name]!.map((x) => x.text), ["meet me at the usual place"]);
    assert.match(prose(bob), /meet me at the usual place/);
  } finally { server.close(); }
});

test("one effect at a time, because two would race the state file", async () => {
  const { url, server, invites } = await vault();
  try {
    const h = harness(url, invites);
    const m = await created(h);
    // Not driven through `perform`: the point is what the reducer does while one is in flight.
    const busy = { ...m, busy: "send" };
    const again = update(busy, { t: "key", key: { t: "char", value: "f" } });
    assert.equal(again.effects.length, 0, "a second effect was emitted while one was running");
    assert.match(again.model.log.at(-1)!.text, /still running/);
    // And the tick does not queue behind it either — it skips, so a slow publish cannot build
    // up a backlog of flushes that all fire at once when it finishes.
    const ticked = update({ ...busy, state: { ...busy.state!, pending: [
      { channel: "x", id: "enc:1", bodyB64: "", uploadAt: T0 - 1, real: true },
    ] } }, { t: "tick", now: T0 });
    assert.equal(ticked.effects.length, 0);
  } finally { server.close(); }
});

test("rotation asks first, and says what it destroys", async () => {
  const { url, server, invites } = await vault();
  try {
    const h = harness(url, invites);
    let m = await created(h);
    const epoch = m.state!.prekeys.epoch;

    m = await feed(m, h.deps, "3R");
    assert.ok(m.confirm, "R rotated without asking");
    assert.match(prose(m), /can no longer reach you/);
    assert.equal(m.state!.prekeys.epoch, epoch, "the prekey was destroyed before the answer");

    m = await feed(m, h.deps, "n");
    assert.equal(m.state!.prekeys.epoch, epoch);

    m = await feed(m, h.deps, "Ry");
    assert.equal(m.state!.prekeys.epoch, epoch + 1);
    assert.match(m.log.at(-1)!.text, /destroyed/);
  } finally { server.close(); }
});

test("an effect that fails becomes a log line, not an exit", async () => {
  const { url, server, invites } = await vault();
  try {
    const h = harness(url, invites);
    let m = await created(h);
    m = await feed(m, h.deps, "2i");
    m = await feed(m, h.deps, "nobody\tmissing.json\r");
    assert.match(m.log.at(-1)!.text, /no such file/);
    assert.equal(m.busy, null, "a failed effect left the interface busy forever");
    assert.deepEqual(Object.keys(m.state!.channels), [],
      "a failed invite left a channel the other side will never know about");
  } finally { server.close(); }
});

test("forgetting asks first, and takes the messages off the screen as well as out of the file", async () => {
  const { url, server, invites } = await vault();
  try {
    const chain = memoryChain();
    const ha = harness(url, invites, chain);
    const hb = harness(url, invites, chain);
    let alice = await created(ha);
    let bob = await created(hb);

    bob = await feed(bob, hb.deps, "2e");
    ha.files.set("bob.json", hb.files.get("bundle.json")!);
    alice = await feed(alice, ha.deps, "2i");
    alice = await feed(alice, ha.deps, "bob\t");
    alice = await feed(alice, ha.deps, "bob.json\r");
    alice = await feed(alice, ha.deps, "1i");
    alice = await feed(alice, ha.deps, "something regrettable\r");

    // It is in the transcript from send time — a client knows what it said.
    alice = await feed(alice, ha.deps, "r");
    assert.match(prose(alice), /something regrettable/);

    alice = await feed(alice, ha.deps, "D");
    assert.ok(alice.confirm, "D deleted without asking");
    const flat = prose(alice);
    assert.match(flat, /keys were destroyed when they were read/);
    assert.match(flat, /the other end keeps its own copy/);
    assert.equal(alice.state!.channels.bob.history.length, 1, "it was deleted before the answer");

    alice = await feed(alice, ha.deps, "y");
    assert.equal(alice.state!.channels.bob.history.length, 0);
    assert.doesNotMatch(prose(alice), /something regrettable/,
      "the message is off the disk and still on the screen");
  } finally { server.close(); }
});

test("which of the two things Enter will do is on the screen before it is pressed", async () => {
  // I7's precondition on the sending side. A user who cannot see whether the next message is
  // signed has neither deniability nor attribution — they have whatever the default was, and the
  // whole point of `decisions/0026` is that there is no default.
  const { url, server, invites } = await vault();
  try {
    const h = harness(url, invites);
    let m = await created(h);

    assert.equal(m.signing, false, "the client starts out signing without being asked");
    assert.match(prose(m), /deniable/);
    // ASSERTED VIA THE CLAIM SOURCE, not as a literal. A test that pins a claim's WORDING is on
    // the claim's side: when the wording is wrong, the test defends it. This file already did that
    // once — it required the compose line to say "anyone holding your bundle can prove it" after
    // the CLI had been corrected out of exactly that.
    assert.match(prose(m), new RegExp(DENIABLE.short.split(" — ")[0]));
    assert.doesNotMatch(prose(m), /SIGNED/);

    m = await feed(m, h.deps, "s");
    assert.equal(m.signing, true);
    assert.match(prose(m), /SIGNED/);
    // THIS ASSERTION USED TO PIN A FALSE CLAIM, which is how the claim survived: the CLI had
    // already been corrected to say signing alone buys no third-party proof, and this test
    // required the TUI to keep saying the opposite. Both now render `claims/src/warnings.ts`.
    assert.match(prose(m), /only THEY can check it until you anchor/);
    assert.doesNotMatch(prose(m), /anyone can prove it/,
      "the compose line claims third-party proof that signing alone does not buy");

    // And it toggles back, so the mode is a state the user drives rather than a trap.
    m = await feed(m, h.deps, "s");
    assert.equal(m.signing, false);
  } finally { server.close(); }
});

test("the send effect carries the choice, and the log says which happened", async () => {
  const { url, server, invites } = await vault();
  try {
    const chain = memoryChain();
    const ha = harness(url, invites, chain);
    const hb = harness(url, invites, chain);
    let alice = await created(ha);
    let bob = await created(hb);

    bob = await feed(bob, hb.deps, "2e");
    ha.files.set("bob.json", hb.files.get("bundle.json")!);
    alice = await feed(alice, ha.deps, "2i");
    alice = await feed(alice, ha.deps, "bob\t");
    alice = await feed(alice, ha.deps, "bob.json\r");

    alice = await feed(alice, ha.deps, "1i");
    alice = await feed(alice, ha.deps, "off the record\r");
    assert.match(alice.log.at(-1)!.text, /deniable/);
    assert.equal(alice.state!.channels.bob.history.at(-1)!.attribution, "unverifiable");

    alice = await feed(alice, ha.deps, "s");
    alice = await feed(alice, ha.deps, "i");
    alice = await feed(alice, ha.deps, "on the record\r");
    assert.match(alice.log.at(-1)!.text, /signed/);
    assert.equal(alice.state!.channels.bob.history.at(-1)!.attribution, "signed");
  } finally { server.close(); }
});
