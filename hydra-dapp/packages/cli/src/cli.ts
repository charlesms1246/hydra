#!/usr/bin/env node
/**
 * `hydra` — the messaging client, as a command.
 *
 * A CLI first and a GUI later, deliberately. The desktop build's binding constraint is
 * reproducible builds from the first release, which decides the toolchain; nothing about that
 * decision changes what the client has to do, and doing it here first means the GUI is a
 * front-end to something already attacked rather than a place to reinvent the sequence.
 *
 * This file is argument parsing and printing. Everything it does lives in `commands.ts`, which
 * is what `cli-conversation.test.ts` drives — so the behaviour is tested and the parsing is
 * thin enough not to need it.
 *
 *     hydra init --vault URL --rpc URL --contract 0x… --account NAME --accounts-file PATH
 *     hydra bundle [--epoch N] [--one-time N]     > bundle.json   (give this to people)
 *     hydra open NAME bundle.json                 > prekey.json   (give this to them)
 *     hydra accept NAME prekey.json
 *     hydra send NAME "text"                      publishes the pointer, queues the upload
 *     hydra flush                                 uploads what is due
 *     hydra read NAME
 *     hydra status
 *
 * `send` and `flush` are separate because the upload has to come later than the chain event —
 * see `commands.ts`. Running `flush` on a timer is the intended use, and `status` says so.
 */

import { readFileSync } from "node:fs";
import {
  init, publishBundle, open, accept, sendMessage, flush, readChannel, fingerprint, vaultRootOf,
} from "./commands.ts";
import { starknet } from "./chain.ts";
import { load, save, exists, STATE_FILE } from "./state.ts";
import type { State } from "./state.ts";

const [command, ...rest] = process.argv.slice(2);

const flag = (name: string, fallback = ""): string => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));

/** Hex in, hex out: a bundle and a prekey message are transported as JSON with hex fields. */
const encode = (v: unknown): string => JSON.stringify(v, (_, x) =>
  x instanceof Uint8Array ? Buffer.from(x).toString("hex") : x, 2);

const decodeKeys = new Set([
  "identityKey", "signingKey", "signedPrekey", "signedPrekeySignature", "oneTimePrekey",
  "ephemeralKey", "wrapped",
]);
const decode = (text: string): any => JSON.parse(text, (k, v) =>
  decodeKeys.has(k) && typeof v === "string" ? new Uint8Array(Buffer.from(v, "hex")) : v);

const chainFor = (state: State) => starknet({
  rpcUrl: state.rpcUrl, contract: state.contract, fromBlock: state.fromBlock,
  accountsFile: state.accountsFile, account: state.account, network: state.network,
});

const usage = () => {
  console.error(readFileSync(new URL(import.meta.url), "utf8")
    .split("\n").slice(3, 25).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
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
      invites: flag("invites").split(",").filter(Boolean),
    });
    save(state);
    console.log(`identity written to ${STATE_FILE}`);
    console.log(`fingerprint ${fingerprint(publishBundle(state))}`);
    console.log("\nthat file holds your root key in the clear. it is mode 0600 and that is all.");
    break;
  }

  case "bundle": {
    const state = load();
    const oneTime = flag("one-time");
    console.log(encode(publishBundle(state, Number(flag("epoch", "0")),
      oneTime === "" ? undefined : Number(oneTime))));
    break;
  }

  case "open": {
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

  case "send": {
    const state = load();
    const [name, ...words] = positional;
    if (!name || !words.length) usage();
    const result = await sendMessage(state, chainFor(state), name, words.join(" "));
    save(state);
    console.log(`published ${result.txHash}`);
    console.log(`upload due at ${new Date(result.uploadAt).toISOString()} with ${result.decoys} decoys`);
    console.log("run `hydra flush` then, or on a timer. uploading now would undo the timing defence.");
    console.log("");
    console.log("NOTE: that transaction was signed by your own account, so the chain shows that");
    console.log("YOU published a message, and its nonce shows which one. the timing defence hides");
    console.log("which upload holds the text; it does not hide that you sent it. see");
    console.log("claude-docs/decisions/0011-cli-client.md.");
    break;
  }

  case "flush": {
    const state = load();
    const { uploaded, waiting } = await flush(state);
    save(state);
    console.log(`uploaded ${uploaded}, ${waiting} still waiting`);
    break;
  }

  case "read": {
    const state = load();
    const [name] = positional;
    if (!name) usage();
    for (const m of await readChannel(state, chainFor(state), name)) {
      console.log(`${String(m.seq).padStart(3)}  ${m.text}`);
    }
    break;
  }

  case "status": {
    const state = load();
    console.log(`state      ${STATE_FILE}`);
    console.log(`vault      ${state.vaultUrl}`);
    console.log(`chain      ${state.contract || "(unset)"} via ${state.rpcUrl}`);
    console.log(`fingerprint ${fingerprint(publishBundle(state))}`);
    console.log(`channels   ${Object.keys(state.channels).join(", ") || "(none)"}`);
    console.log(`pending    ${state.pending.length} uploads, ${state.invites.length} invites left`);
    console.log("");
    console.log("what this client does NOT do:");
    console.log("  - it keeps your root key in a plaintext file (mode 0600, nothing else)");
    console.log("  - prekeys are derived, so that key opens every past conversation too");
    console.log("  - it publishes pointers from your own account, so the chain shows that YOU");
    console.log("    sent each message and in what order. every time.");
    console.log("it is for a devnet and a testnet. see claude-docs/decisions/0009 and 0011.");
    // Touch the root so a corrupt seed fails here rather than at the first send.
    vaultRootOf(state);
    break;
  }

  default:
    usage();
}
