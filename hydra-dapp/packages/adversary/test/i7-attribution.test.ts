/**
 * I7 — displayed attribution is signature-backed, or displayed as unverifiable.
 *
 * The rule that stops a forgery borrowing the interface's authority. Content authenticated only
 * by a key both participants hold is a supported mode — it is what `decisions/0026` calls
 * deniable, and it is chosen per message — but a product that renders it as "from alice"
 * indistinguishably from a signed message has lent its own credibility to something it cannot
 * support. A screenshot of that screen is evidence, and it should not be.
 *
 * A reader's belief about who they are talking to is still theirs to hold, so the name stays.
 * What the name may never appear without is the basis for it.
 *
 * CHECKED IN BOTH DIRECTIONS, and the second one matters as much as the first: a signed message
 * displayed as unverifiable is the same defect wearing the other face. Hiding provenance the
 * product HAS is as dishonest as inventing provenance it does not, and it teaches users to
 * ignore the mark.
 *
 * These render the real frames through the real renderer. A test that checked
 * `attributionLabel` alone would pass while a page drew names some other way, which is exactly
 * how `read.target` was false for months — see `not-observable-mechanisms.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { render } from "../../tui/src/view.ts";
import { start } from "../../tui/src/app.ts";
import type { Model } from "../../tui/src/app.ts";
import { attributionLabel, SIGNED_MARK, UNVERIFIABLE_MARK } from "../../cli/src/commands.ts";
import type { ReceivedMessage, State } from "../../cli/src/state.ts";

const SIZE = { rows: 26, cols: 100 };

const plain = (m: Model) => render(m, SIZE).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

/** A model showing one channel's transcript, with nothing else on screen to confuse the check. */
function showing(messages: readonly ReceivedMessage[], anchor?: string): Model {
  const state = {
    vaultUrl: "", rpcUrl: "", contract: "", fromBlock: 0, accountsFile: "", account: "",
    blockMs: 30_000, seedHex: "00".repeat(32),
    prekeys: { epoch: 0, signed: { 0: "11".repeat(32) }, oneTime: {}, nextOneTime: 0 },
    invites: [], pending: [],
    channels: {
      alice: {
        peer: "p", role: "initiator" as const,
        peerSigningKeyHex: "22".repeat(32),
        addressSendHex: "33".repeat(32), addressRecvHex: "44".repeat(32),
        send: { chainHex: "55".repeat(32), next: 0, skipped: {} },
        recv: { chainHex: "66".repeat(32), next: 0, skipped: {} },
        nextSeq: 0, readTo: 0, history: [...messages], foreignSeen: 0, refusedSeen: 0,
        ...(anchor ? { anchor } : {}),
      },
    },
  } as unknown as State;
  return { ...start(state, 0), page: "chats", transcript: { alice: messages } };
}

const message = (
  seq: number, text: string, attribution: ReceivedMessage["attribution"], mine = false,
): ReceivedMessage => ({ id: `enc:${seq}`, seq, text, mine, at: seq, attribution });

// ---------------------------------------------------------------------------

test("a deniable message is never shown as though it were proven", () => {
  const frame = plain(showing([message(0, "bring the money", "unverifiable")]));
  assert.match(frame, /bring the money/, "the message is not on screen at all");

  // The name may appear — the reader's own belief is theirs — but never without the mark.
  for (const line of frame.split("\n")) {
    if (!line.includes("bring the money")) continue;
    assert.ok(line.includes(UNVERIFIABLE_MARK),
      `a line names an author with nothing to back it: ${line.trim()}`);
    assert.ok(!line.includes(SIGNED_MARK),
      `a deniable message is marked as signed: ${line.trim()}`);
  }
});

test("and a signed message is not hidden either, which is the same rule", () => {
  // The other direction. A product that marks everything "unverifiable" satisfies the letter of
  // I7 and teaches its users that the mark means nothing.
  const frame = plain(showing([message(0, "on the record", "signed")]));
  for (const line of frame.split("\n")) {
    if (!line.includes("on the record")) continue;
    assert.ok(line.includes(SIGNED_MARK),
      `provable authorship was displayed as unverifiable: ${line.trim()}`);
  }
});

test("a mixed transcript marks each line for itself, not the conversation", () => {
  // The realistic case and the one a per-channel flag would get wrong: the mode is per message,
  // so one signed line among deniable ones must be the only line marked.
  const frame = plain(showing([
    message(0, "off the record one", "unverifiable"),
    message(1, "ON THE RECORD", "signed"),
    message(2, "off the record two", "unverifiable"),
  ]));
  const lineFor = (text: string) => frame.split("\n").find((l) => l.includes(text))!;
  assert.ok(lineFor("ON THE RECORD").includes(SIGNED_MARK));
  assert.ok(!lineFor("off the record one").includes(SIGNED_MARK));
  assert.ok(!lineFor("off the record two").includes(SIGNED_MARK));
  assert.ok(lineFor("off the record two").includes(UNVERIFIABLE_MARK));
});

test("every message on screen carries exactly one mark, including your own", () => {
  // Your own messages too. You know you wrote them; a screenshot of your screen does not, and
  // the product should not claim otherwise on your behalf.
  const messages = [
    message(0, "mine deniable", "unverifiable", true),
    message(1, "mine signed", "signed", true),
    message(2, "theirs deniable", "unverifiable"),
    message(3, "theirs signed", "signed"),
  ];
  const frame = plain(showing(messages));
  for (const m of messages) {
    const line = frame.split("\n").find((l) => l.includes(m.text));
    assert.ok(line, `${m.text} is not on screen`);
    const marks = [...line].filter((c) => c === SIGNED_MARK || c === UNVERIFIABLE_MARK);
    assert.equal(marks.length, 1, `${m.text} carries ${marks.length} marks: ${line.trim()}`);
    assert.equal(marks[0], m.attribution === "signed" ? SIGNED_MARK : UNVERIFIABLE_MARK);
  }
});

test("the screen says WHERE a signature's key came from, not just that there was one", () => {
  // I7 is about naming the basis, and after `anchorPeer` the basis is different: the key is on
  // chain, checkable by anyone, instead of having arrived over the handshake. A frame that drew
  // the same sentence in both cases would be over-claiming in the unanchored one — which is
  // what it did until a record existed to compare against.
  const loose = plain(showing([message(0, "on the record", "signed")]));
  assert.match(loose, /key from the handshake/);
  assert.doesNotMatch(loose, /0xfeed/);

  const anchored = plain(showing([message(0, "on the record", "signed")], "0xfeed"));
  assert.match(anchored, /0xfeed/, "the anchor is not on screen, so checking it changed nothing");
  // And it must not upgrade a deniable message: the anchor is about the key, the mark is about
  // whether this message was signed with it.
  const deniable = plain(showing([message(0, "bring the money", "unverifiable")], "0xfeed"));
  for (const line of deniable.split("\n")) {
    if (!line.includes("bring the money")) continue;
    assert.ok(line.includes(UNVERIFIABLE_MARK) && !line.includes(SIGNED_MARK),
      `an anchor upgraded a deniable message: ${line.trim()}`);
  }
});

test("the marks mean something on screen, because the screen says what", () => {
  // A glyph nobody can decode is decoration. The legend is on the same page as the transcript,
  // not in a help screen somebody has to know to open.
  const frame = plain(showing([message(0, "hello", "signed")]));
  assert.match(frame, new RegExp(`${SIGNED_MARK} signed`));
  assert.match(frame, new RegExp(`\\${UNVERIFIABLE_MARK} unverifiable`));
});

test("the two marks are distinct, and the label names its own basis", () => {
  assert.notEqual(SIGNED_MARK, UNVERIFIABLE_MARK);
  const signed = attributionLabel({ mine: false, attribution: "signed" }, "alice");
  const deniable = attributionLabel({ mine: false, attribution: "unverifiable" }, "alice");
  assert.equal(signed.name, "alice");
  assert.equal(deniable.name, "alice", "a deniable message hid the name rather than marking it");
  assert.notEqual(signed.mark, deniable.mark);
  assert.match(deniable.basis, /either of you/);
  // A signed message names WHERE its key came from, and the two sources are not the same claim.
  // Unanchored, the key arrived over the handshake: the signature proves whoever answered that
  // handshake wrote this, which is a real guarantee and a weaker one than a tick alone suggests.
  // Anchored, the key is on chain under a signature naming the address. The label used to say
  // "provable to anyone holding their bundle" in both cases, which was true of the second and
  // wishful about the first.
  assert.match(signed.basis, /not published/);
  const chained = attributionLabel({ mine: false, attribution: "signed" }, "alice", "0xbeef");
  assert.equal(chained.mark, SIGNED_MARK, "an anchor must not change the mark, only the basis");
  assert.match(chained.basis, /0xbeef/);
  assert.notEqual(chained.basis, signed.basis, "the anchor made no difference to what is shown");
  // Your own messages are labelled as yours, whichever mode they were sent in.
  assert.equal(attributionLabel({ mine: true, attribution: "signed" }, "alice").name, "you");
});
