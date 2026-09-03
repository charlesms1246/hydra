#!/usr/bin/env node
/**
 * `hydra` — the messaging client, as a command.
 *
 * The scriptable front end. The one people use is the TUI (`packages/tui/`), which is a resident
 * process and therefore the only one that can keep the upload schedule — see
 * `decisions/0022-tui-and-the-resident-client.md`. This stays because the live suites drive it,
 * because a shell script cannot drive a terminal interface, and because both call `commands.ts`,
 * so the two cannot disagree about anything that matters.
 *
 * This file is argument parsing and printing. Everything it does lives in `commands.ts`, which
 * is what `cli-conversation.test.ts` drives — so the behaviour is tested and the parsing is
 * thin enough not to need it.
 *
 *     hydra init --vault URL --rpc URL --contract 0x… --account NAME --accounts-file PATH
 *     hydra bundle [--epoch N] [--one-time N]     > bundle.json   (give this to people)
 *     hydra record 0xADDRESS                      > the felts to publish at that address
 *     hydra anchor NAME 0xADDRESS FELT…           check their record against the handshake
 *     hydra open NAME bundle.json                 > prekey.json   (give this to them)
 *     hydra invite NAME bundle.json               same, delivered through the vault
 *     hydra accept NAME prekey.json
 *     hydra collect                               accept whatever is waiting for you
 *     hydra rotate                                destroy the old prekey; mint fresh ones
 *     hydra send NAME "text"                      deniable: either of you could have written it
 *     hydra publish NAME "text"                   signed: only you could have, and it is provable
 *     hydra flush                                 uploads what is due
 *     hydra read NAME
 *     hydra forget NAME [--before EVENT]          delete messages; the key is already gone
 *     hydra disclose [--cite]                     what everyone involved can see
 *     hydra status
 *
 * `send` and `flush` are separate because the upload has to come later than the chain event —
 * see `commands.ts`. Running `flush` on a timer is the intended use, and `status` says so.
 */

import { readFileSync } from "node:fs";
import {
  init, publishBundle, open, accept, openAndSend, collect, sendMessage, flush, readChannel,
  fingerprint, vaultRootOf, rotatePrekey, nextOneTime, foreignSends, forget, attributionLabel,
  myRecord, anchorPeer, anchorOf, recordFelts, drain,
  encodeWire as encode, decodeWire as decode,
} from "./commands.ts";
import { chainFor } from "./chain.ts";
import { statement } from "../../claims/src/statement.ts";
import { load, save, exists, STATE_FILE } from "./state.ts";

const [command, ...rest] = process.argv.slice(2);

const flag = (name: string, fallback = ""): string => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));

const usage = () => {
  console.error(readFileSync(new URL(import.meta.url), "utf8")
    .split("\n").slice(3, 30).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
  process.exit(2);
};

switch (command) {
  case "init": {
    if (exists()) throw new Error(`${STATE_FILE} already exists — delete it to start over`);
    const state = init({
      vaultUrl: flag("vault", "http://127.0.0.1:8080"),
      rpcUrl: flag("rpc", "http://127.0.0.1:5050"),
      contract: flag("contract"),
      fromBlock: Number(flag("from-block", "0")),
      // Devnets mine on demand, so their 'block interval' is whatever you say it is. The jitter
      // window is eight of these, and on a devnet waiting four real minutes to see a message
      // arrive teaches nobody anything.
      blockMs: Number(flag("block-ms", "30000")),
      accountsFile: flag("accounts-file"),
      account: flag("account"),
      network: flag("network") || undefined,
      controlUrl: flag("control") || undefined,
      poolAccount: flag("pool-account") || undefined,
      invites: flag("invites").split(",").filter(Boolean),
    });
    save(state);
    console.log(`identity written to ${STATE_FILE}`);
    console.log(`fingerprint ${fingerprint(publishBundle(state))}`);
    console.log("\nthat file holds your root key in the clear. it is mode 0600 and that is all.");
    break;
  }

  case "bundle": {
    // The epoch is the store's, not the caller's: publishing one whose private you have deleted
    // would advertise a prekey you cannot answer. A one-time key is picked automatically unless
    // you name one, because a bundle without one has no replay resistance.
    const state = load();
    const named = flag("one-time");
    const index = named === "" ? nextOneTime(state) : Number(named);
    console.log(encode(publishBundle(state, index)));
    if (index === undefined) {
      console.error("no one-time prekeys left — this bundle has no replay resistance.");
      console.error("run `hydra rotate` to mint more.");
    }
    break;
  }

  case "record": {
    // The address is an argument because it is what the record commits to. `state.account` is a
    // name in an sncast accounts file, not an address, and guessing would produce a record that
    // verifies nowhere — a failure that would appear at a stranger's client rather than here.
    const state = load();
    const [where] = positional;
    if (!where) usage();
    const { felts, fingerprint: fp } = myRecord(state, BigInt(where));
    console.log(felts.map((f) => `0x${f.toString(16)}`).join(" "));
    console.log("");
    console.error(`fingerprint ${fp}`);
    console.error(`${felts.length} felts, to be written at ${where} where anyone can read them.`);
    console.error("");
    console.error("WHAT THIS COSTS, and it is the reason it is not done for you: the record");
    console.error("names your messaging identity and that address together, on chain, forever.");
    console.error("anything else that address ever does is joined to your conversations by");
    console.error("anyone reading the chain — see `hydra disclose`. what it buys is that a");
    console.error("stranger can check a signature you made without ever talking to you.");
    console.error("");
    console.error("this client does not write it. the identity contract's data ABI is not");
    console.error("verified anywhere in this repo, and publishing under a guessed entrypoint is");
    console.error("how a record ends up somewhere nobody looks. see claude-docs/decisions/0027.");
    break;
  }

  case "anchor": {
    // Reading rather than writing, and it is the half that matters to a user: the signing key a
    // channel verifies against arrived over the handshake, and this is what turns that into a
    // check against something published.
    const state = load();
    const [name, where, ...felts] = positional;
    if (!name || !where || felts.length !== recordFelts) {
      console.error(`a record is ${recordFelts} felts; got ${felts.length}`);
      usage();
    }
    const at = anchorPeer(state, name, BigInt(where), felts.map((f) => BigInt(f)));
    save(state);
    console.log(`${name}'s signing key is published at ${at}, and it is the one you handshook with`);
    console.log("");
    console.log("this does NOT say the address is the person you mean. it says the key you have");
    console.log("been verifying their signatures against is on chain under a signature naming");
    console.log("that address. who owns the address is still a fingerprint question.");
    break;
  }

  case "rotate": {
    const state = load();
    const { retired, oneTimeLeft } = rotatePrekey(state);
    save(state);
    console.log(`retired epoch ${retired}; the private for it is gone`);
    console.log(`${oneTimeLeft} one-time prekeys available`);
    console.log("");
    console.log("anyone who fetched your old bundle and has not had their prekey message");
    console.log("collected can no longer reach you on it. that is the point: the key that");
    console.log("would have opened those conversations does not exist any more.");
    break;
  }

  case "open": {
    // Prints the prekey message. Use `hydra invite` to deliver it through the vault instead.
    const state = load();
    const [name, file] = positional;
    if (!name || !file) usage();
    const bundle = decode(readFileSync(file, "utf8"));
    const message = open(state, name, bundle);
    save(state);
    console.error(`channel ${name} opened with ${fingerprint(bundle)}`);
    console.error("check that fingerprint with them by some other means. nothing here can.");
    console.log(encode(message));
    break;
  }

  case "invite": {
    const state = load();
    const [name, file] = positional;
    if (!name || !file) usage();
    const bundle = decode(readFileSync(file, "utf8"));
    const { slot } = await openAndSend(state, name, bundle);
    save(state);
    console.log(`channel ${name} opened with ${fingerprint(bundle)}, delivered to slot ${slot}`);
    console.log("check that fingerprint with them by some other means. nothing here can.");
    console.log("");
    console.log("the storage server can now see that they are reachable and count what is");
    console.log("waiting for them. that is unavoidable without accounts, and accounts would");
    console.log("disclose more. see claude-docs/decisions/0013-prekey-delivery.md.");
    console.log("");
    console.log("AND: this write is not scheduled the way message uploads are. if you `send`");
    console.log("in the next few minutes, the chain publish nearest this write is yours, and");
    console.log("anyone with both records reads it off. measured above 90%. see 0018.");
    break;
  }

  case "collect": {
    const state = load();
    const { accepted, rejected } = await collect(state);
    save(state);
    for (const n of accepted) console.log(`accepted ${n}`);
    if (rejected) console.log(`${rejected} slot(s) held something that did not open — discarded`);
    if (!accepted.length && !rejected) console.log("nothing waiting");
    break;
  }

  case "accept": {
    const state = load();
    const [name, file] = positional;
    if (!name || !file) usage();
    const { usedOneTimePrekey } = accept(state, name, decode(readFileSync(file, "utf8")));
    save(state);
    console.log(`channel ${name} accepted`);
    if (!usedOneTimePrekey) {
      console.log("no one-time prekey was used — this handshake has no replay protection.");
      console.log("publish a bundle with --one-time N and a fresh N each time.");
    }
    break;
  }

  case "send":
  case "publish": {
    // Two verbs rather than a flag, because the difference is not a setting. `send` is deniable
    // and `publish` is signed, and a user who cannot tell which they just did has neither.
    const state = load();
    const [name, ...words] = positional;
    if (!name || !words.length) usage();
    const signed = command === "publish";
    const result = await sendMessage(
      state, chainFor(state), name, signed ? "signed" : "ephemeral", words.join(" "));
    save(state);
    console.log(`published ${result.txHash}`);
    console.log(`upload due at ${new Date(result.uploadAt).toISOString()} with ${result.decoys} decoys`);
    console.log("run `hydra flush` then, or on a timer. uploading now would undo the timing defence.");
    console.log("");
    console.log(signed
      ? "SIGNED. anyone holding your bundle can prove you wrote this, including people you never\n"
        + "sent it to. that is what publishing means and it cannot be taken back."
      : "DENIABLE. the only thing authenticating this is a key you and they both hold, so either\n"
        + "of you could have written it and neither can prove which. use `publish` if you need\n"
        + "the other thing.");
    console.log("");
    console.log("NOTE: that transaction was signed by your own account, so the chain shows that");
    console.log("YOU published a message, and its nonce shows which one. the timing defence hides");
    console.log("which upload holds the text; it does not hide that you sent it. see");
    console.log("claude-docs/decisions/0011-cli-client.md.");
    break;
  }

  case "flush": {
    const state = load();
    // `drain`, not `flush`: one object at a time with a random gap between them. Uploading every
    // due object at once is a set the vault operator can group — `upload.burst` on the disclosure
    // table — and `coverRate + 1` objects arriving as a run is a message with its cover.
    //
    // So this command takes as long as it takes, and says so rather than looking hung.
    const due = state.pending.filter((p) => p.uploadAt <= Date.now()).length;
    if (due > 1) {
      console.log(
        `${due} objects are due. They go up one at a time, spread out on purpose: all of them at `
        + "once is a batch the vault operator can group as one client's message and its cover.");
    }
    const { uploaded, waiting } = await drain(state);
    save(state);
    console.log(`uploaded ${uploaded}, ${waiting} still waiting`);
    break;
  }

  case "read": {
    const state = load();
    const [name] = positional;
    if (!name) usage();
    // Direction, not just text. A channel is two one-way keys and a transcript that does not
    // say which one opened a line is a transcript that puts your words in their mouth.
    // I7: never a name without what backs it. `attributionLabel` is the only place either front
    // end turns a message into an author, so the rule cannot hold in one and not the other.
    const read = await readChannel(state, chainFor(state), name);
    const at = anchorOf(state, name);
    for (const m of read) {
      const who = attributionLabel(m, name, at);
      console.log(`${who.mark} ${who.name.padEnd(12)} ${String(m.seq).padStart(3)}  ${m.text}`);
    }
    console.log("");
    // The legend changes with the anchor because what a tick MEANS changes with it. A key that
    // came from the handshake proves the author is whoever answered it; a key on chain is
    // checkable by anyone. Printing the stronger sentence in both cases is the over-claim.
    console.log(at
      ? `✓ signed — their key is published at ${at}, so anyone can check this`
      : "✓ signed — under the key they handshook with; it is not published, so only you can check it");
    console.log("? unverifiable — a key you both hold, so either of you could have written it");
    if (!at) console.log(`  \`hydra anchor ${name} 0xADDRESS FELT…\` if they have published a record`);
    const foreign = foreignSends(state, name);
    if (foreign) {
      console.error("");
      console.error(`${foreign} message(s) in your own direction were not sent by this client.`);
      console.error("another client is running on this identity. two clients on one seed mint");
      console.error("identical cover, and an object uploaded twice is an object the storage");
      console.error("server knows is cover. use one client per identity.");
    }
    break;
  }

  case "forget": {
    const state = load();
    const [name] = positional;
    if (!name) usage();
    const before = flag("before");
    const gone = forget(state, name, before === "" ? undefined : Number(before));
    save(state);
    console.log(`${gone} message(s) removed from ${name}`);
    console.log("");
    console.log("their keys were destroyed when they were read, so this client cannot fetch");
    console.log("them again. what this does NOT reach: the ciphertext is in the vault until it");
    console.log("expires, the other end has its own copy, and this file has already been");
    console.log("written to a disk that may keep the old blocks.");
    break;
  }

  case "disclose": {
    // The disclosure statement was generated, tested and rendered nowhere. A statement no user
    // can read is a statement that exists for the test suite, and the whole point of computing
    // it rather than writing it is that a person can act on it.
    //
    // `--cite` prints the source of every line, because a claim you cannot chase is a claim you
    // have to take on trust, and this project's position is that you should not have to.
    const cite = rest.includes("--cite");
    const s = statement();
    const show = (title: string, claims: readonly { says: string; from: string }[]) => {
      console.log(`## ${title}
`);
      for (const c of claims) {
        console.log(`- ${c.says}`);
        if (cite) console.log(`  ${c.from}`);
      }
      console.log("");
    };
    show("What the people running this can see", s.whoCanSeeWhat);
    show("What is protected, and how well", s.whatIsPartial);
    show("What they cannot see", s.whatWeCannotSee);
    console.log("Every line above is generated from the code that makes it true.");
    console.log("Nothing here is a promise about what anyone will do with what they can see.");
    break;
  }

  case "status": {
    const state = load();
    console.log(`state      ${STATE_FILE}`);
    console.log(`vault      ${state.vaultUrl}`);
    console.log(`chain      ${state.contract || "(unset)"} via ${state.rpcUrl}`);
    console.log(`route      ${state.controlUrl ? `pool (${state.poolAccount || "alice"})` : "direct from your own account"}`);
    console.log(`fingerprint ${fingerprint(publishBundle(state))}`);
    console.log(`channels   ${Object.keys(state.channels).join(", ") || "(none)"}`);
    console.log(`pending    ${state.pending.length} uploads, ${state.invites.length} invites left`);
    console.log("");
    console.log("what this client does NOT do:");
    console.log("  - it keeps your root key in a plaintext file (mode 0600, nothing else)");
    console.log(`  - ${nextOneTime(state) === undefined ? "no" : "some"} one-time prekeys left; `
      + "a bundle without one has no replay resistance");
    console.log(state.controlUrl
      ? "  - the pool route hides your account from sender_address and leaves it in the\n"
        + "    calldata, and spends a little of your money per message"
      : "  - it publishes pointers from your own account, so the chain shows that YOU\n"
        + "    sent each message and in what order. every time.");
    console.log("it is for a devnet and a testnet. see claude-docs/decisions/0009 and 0011.");
    // Touch the root so a corrupt seed fails here rather than at the first send.
    vaultRootOf(state);
    break;
  }

  default:
    usage();
}
