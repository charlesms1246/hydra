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
 *     hydra publish NAME "text"                   signed: only you could have written it
 *     hydra flush                                 uploads what is due
 *     hydra read NAME
 *
 *   the public class — anonymous posts, readable by anyone who has the id:
 *     hydra post REASON "text"                    > a pub: id   (there is no feed and no index)
 *     hydra fetch ID…                             read public posts back
 *     hydra audit ID ROOT                         check a removal against a published commitment
 *     hydra lookup 0xADDRESS                      > their bundle, off chain, without asking them
 *     hydra forget NAME [--before EVENT]          delete messages; the key is already gone
 *     hydra disclose [--cite]                     what everyone involved can see
 *     hydra status
 *
 *     hydra-tui                                   the same client as a terminal interface
 *
 * `send` and `flush` are separate because the upload has to come later than the chain event —
 * see `commands.ts`. Running `flush` on a timer is the intended use, and `status` says so.
 */

import { describePost, describeFetch } from "../../client/src/public.ts";
import { SIGNED, DENIABLE, RECORD_NOT_WRITTEN, SECOND_CLIENT }
  from "../../claims/src/warnings.ts";
import { verifyProof } from "../../vault-server/src/root.ts";
import { readFileSync } from "node:fs";
import {
  init, publishBundle, open, accept, openAndSend, collect, sendMessage, flush, readChannel,
  fingerprint, vaultRootOf, rotatePrekey, nextOneTime, foreignSends, forget, attributionLabel,
  myRecord, anchorPeer, anchorOf, recordFelts, drain, linkabilityOf, post, fetchPosts,
  bundleFromChain,
  encodeWire as encode, decodeWire as decode,
} from "./commands.ts";
import { chainFor } from "./chain.ts";
import { statement } from "../../claims/src/statement.ts";
import { describe } from "../../channel/src/crowd.ts";
import { load, save, exists, STATE_FILE } from "./state.ts";

const [command, ...rest] = process.argv.slice(2);

const flag = (name: string, fallback = ""): string => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));

const usage = () => {
  // DERIVED FROM THE COMMENT'S OWN END, not a hardcoded line range. It used to be `slice(3, 30)`,
  // so adding commands pushed the last ones past the cut and the help silently stopped listing
  // them — which is how `post`, `fetch`, `audit` and `lookup` came to be missing from the only
  // place a user finds out what exists. A magic number that has to be updated in step with the
  // text above it is a number nobody updates.
  const lines = readFileSync(new URL(import.meta.url), "utf8").split("\n");
  const end = lines.findIndex((l) => l.trim() === "*/");
  console.error(lines.slice(3, end).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
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
    // WAS FALSE UNTIL THIS LINE. It told users the identity contract's data ABI is "not verified
    // anywhere in this repo" — `decisions/0031` verified it against the deployed class and landed
    // a record on Sepolia, so the client was reporting less confidence than it had, in a message
    // whose whole job is to help somebody decide. A stale user-facing string is a claim, and this
    // one was wrong in the direction that talks a user out of a thing that works.
    for (const line of RECORD_NOT_WRITTEN.full) console.error(line);
    console.error("");
    console.error("see claude-docs/decisions/0031 and 0027.");
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

  case "lookup": {
    // The step `decisions/0038` found had no path. A bundle could only reach a stranger out of
    // band, so a source needed a prior relationship with the organisation they were anonymously
    // contacting — a prerequisite sitting in front of the surface, undoing its premise.
    const state = load();
    const [where] = positional;
    if (!where) usage();
    const bundle = await bundleFromChain(state, BigInt(where));
    console.log(encode(bundle));
    console.error("");
    console.error(`bundle for ${where}, fingerprint ${fingerprint(bundle)}`);
    console.error("the record's signature names that address, so this is their key and not");
    console.error("somebody else's under their name. what it does NOT tell you is that the");
    console.error("address is the organisation you mean — that is still a question you answer");
    console.error("somewhere else.");
    console.error("");
    console.error("NO ONE-TIME PREKEY. those stay in the vault, so a conversation opened from a");
    console.error("chain record alone has no replay resistance: someone who records your prekey");
    console.error("message can present it again. ask them for a bundle if that matters.");
    console.error("");
    console.error("WHO SAW THIS: the RPC node you are configured against, which now knows your");
    console.error("address asked about theirs. that is better than fetching from their vault —");
    console.error("which would tell THEM you were considering it — and it is not nothing. you");
    console.error("choose the node; they do not. see `hydra disclose` and decisions/0038.");
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
    // RENDERED FROM `claims/src/warnings.ts`, not written here. These sentences existed twice —
    // once in this file and once in the TUI — and drifted in both directions. Standing rule 3:
    // privacy claims are generated, never asserted.
    for (const line of (signed ? SIGNED : DENIABLE).full) console.log(line);
    if (signed) {
      // STANDING RULE 7: publishing is an act, so what the act commits you to belongs in it.
      //
      // The appeal path (`decisions/0035` §5) proves authorship by signing with the account that
      // published. That instrument is the only identity in this system — and the anonymity design
      // pushes the other way: the value-free route works once per account, and the shape it
      // encourages is publish-once-and-never-return. So the more correctly someone follows it, the
      // less able they are to contest a removal later. That trade cannot be made by somebody who
      // was never told about it.
      console.log("KEEP THE ACCOUNT KEY IF YOU MIGHT EVER NEED TO CONTEST THIS. Signing with the");
      console.log("account that just published is the only way to prove you wrote this or to");
      console.log("appeal a takedown. Discarding it is a reasonable choice — it is one less thing");
      console.log("linking you to this — but it is permanent, and it forecloses both.");
      console.log("");
    }
    // The crowd, on the page that performs the act — the same rule the disclosure text above
    // follows. `decisions/0029`: it is a cost, in the past tense, and it only goes down.
    for (const line of describe(linkabilityOf(state, name))) console.log(line);
    console.log("");
    console.log("NOTE: that transaction was signed by your own account, so the chain shows that");
    console.log("YOU published a message, and its nonce shows which one. the timing defence hides");
    console.log("which upload holds the text; it does not hide that you sent it. see");
    console.log("claude-docs/decisions/0011-cli-client.md.");
    break;
  }

  case "post": {
    // NOT `publish`. That word is taken by signed channel messages — a claim about attribution
    // inside an encrypted conversation — and the collision is part of why nobody noticed the
    // public class had no client path at all.
    const state = load();
    const [reason, ...words] = positional;
    if (!reason || !words.length) {
      console.error("hydra post <reason> <text…>   — the reason is recorded as your intent");
      usage();
    }
    for (const line of describePost()) console.log(line);
    console.log("");
    const { id, invitesLeft } = await post(state, words.join(" "), reason);
    save(state);
    console.log(`posted ${id}`);
    console.log(`${invitesLeft} invite(s) left`);
    console.log("");
    console.log("that id is how anyone fetches it, and it is the only way — there is no feed and");
    console.log("no index. give it to whoever should read this and to nobody else.");
    break;
  }

  case "audit": {
    // THE CONSUMER OF THE COMMITMENT, and it belongs in a CLIENT rather than in the operator's
    // tool: the whole claim of `decisions/0039` is that anybody can check a removal without the
    // operator's cooperation. A verifier only the operator runs is a verifier nobody has.
    const state = load();
    const [blobId, root] = positional;
    if (!blobId || !root) {
      console.error("hydra audit <blobId> <root>   — the root from a published report");
      usage();
    }
    const res = await fetch(`${state.vaultUrl}/v1/pub/proof`, {
      method: "POST", body: JSON.stringify({ id: blobId }),
    });
    const { proof } = await res.json() as { proof: { index: number; path: string[] } | null };
    if (!proof) {
      console.log(`this vault holds no proof for ${blobId} — it is not in the tree it is`);
      console.log("committing to right now.");
      console.log("");
      console.log("if it WAS in an earlier published root, it was removed, and that root plus a");
      console.log("proof you kept is what shows it. if it was never in one, nothing here says it");
      console.log("ever existed — which is the limit of what this can tell you.");
      process.exitCode = 1;
      break;
    }
    const ok = verifyProof(root, blobId, proof);
    console.log(ok
      ? `${blobId} is committed to under root ${root.slice(0, 16)}…`
      : `THE PROOF DOES NOT VERIFY against that root. Either the root is not this vault's, or\n`
        + "the vault produced a proof that does not check out — which is the operator failing\n"
        + "the audit, not you failing to run it.");
    if (!ok) process.exitCode = 1;
    console.log("");
    console.log("this says nothing about WHO published it or whether it should have been removed.");
    console.log("it says the vault's own published commitment either does or does not contain it.");
    break;
  }

  case "fetch": {
    const state = load();
    if (!positional.length) usage();
    for (const line of describeFetch(positional)) console.log(line);
    console.log("");
    const { text, missing, substituted } = await fetchPosts(state, positional);
    for (const [id, body] of text) console.log(`${id}\n${body}\n`);
    for (const id of missing) {
      console.log(`${id} — not here. it may have been removed, expired, or never posted; the`);
      console.log("  vault answers those identically on purpose.");
    }
    for (const id of substituted) {
      console.error(`${id} — THE VAULT RETURNED BYTES THAT DO NOT HASH TO THIS ID. That is a`);
      console.error("  substitution, not corruption: a public object needs no key, so serving one");
      console.error("  object's bytes under another's id costs the operator nothing and would read");
      console.error("  as genuine. Nothing was shown. Fetch it from somewhere else and compare.");
      process.exitCode = 1;
    }
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
    // SAVED EVEN WHEN THE DRAIN THROWS. `flush` spends an invite per successful upload and now
    // commits its own progress in a `finally`, but that progress only reaches the disk if this
    // saves too — otherwise a vault that refuses the fourth object leaves three burnt codes on
    // disk looking unspent, and the next flush presents them again.
    try {
      const { uploaded, waiting } = await drain(state);
      console.log(`uploaded ${uploaded}, ${waiting} still waiting`);
    } finally {
      save(state);
    }
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
    // REMOVED UNDER PROCESS, said plainly and every time. `read.hit` makes a miss
    // indistinguishable from an object that expired or was never sent, which is what makes decoy
    // padding free — and if that held here too, a compelled removal would be invisible to the
    // people it happened to. See DECISIONS-NEEDED.md D6.
    const taken = state.channels[name]?.removedUnderProcess ?? [];
    if (taken.length) {
      console.error("");
      console.error(`${taken.length} message(s) in this conversation were REMOVED FROM THE VAULT`);
      console.error("UNDER LEGAL PROCESS. that is not expiry and it is not deletion by either of");
      console.error("you — an outside party required the operator to remove them, and the operator");
      console.error("could not read what they were removing.");
      console.error("");
      console.error("what this does and does not tell you: the objects are gone from that vault,");
      console.error("so neither of you can fetch them again. it says nothing about who asked, on");
      console.error("what grounds, or whether anyone read them — the operator cannot know the last");
      console.error("one either. if you still hold the plaintext locally, you still hold it.");
      for (const id of taken) console.error(`  ${id}`);
    }
    const foreign = foreignSends(state, name);
    if (foreign) {
      console.error("");
      for (const line of SECOND_CLIENT.full) console.error(line);
    }
    break;
  }

  case "forget": {
    const state = load();
    const [name] = positional;
    if (!name) usage();
    const before = flag("before");
    // `--force` accepts that the vault's copies stay. Without it a failed remote delete refuses,
    // because the ids being dropped ARE the capability to remove them — see `forget`.
    const r = await forget(state, name, before === "" ? undefined : Number(before),
      fetch, rest.includes("--force"));
    const gone = r.forgotten;
    console.log(`removed ${r.removed} of ${r.forgotten} from the vault`);
    if (r.notYours) {
      console.log(`${r.notYours} were signed messages someone else wrote — only their author can `
        + "withdraw those, which is what signing means.");
    }
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
