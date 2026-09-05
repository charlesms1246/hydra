/**
 * The side of the interface that touches the world.
 *
 * `app.ts` decides WHAT should happen and this decides how, by calling `commands.ts` — the same
 * functions the CLI calls, deliberately. Two front ends over two implementations would be two
 * clients, and the second one would not be the one the conversation tests drive.
 *
 * Every dependency is injected, so `adversary/test/tui-conversation.test.ts` runs the whole interface against a
 * memory chain, a stub fetch and an object pretending to be a filesystem. That is the only way
 * to check the sequence a user actually performs — open, send, wait, flush, read — without a
 * node and a vault process.
 *
 * ERRORS BECOME EVENTS. Nothing here throws: a failed effect is an `error` event, the log line
 * shows it, and the interface keeps running. A TUI that dies on a refused upload takes its
 * pending queue's schedule with it.
 */

import {
  init, publishBundle, openAndSend, collect, sendMessage, flush, FLUSH_LIMIT, readChannel, rotatePrekey,
  fingerprint, nextOneTime, encodeWire, decodeWire, foreignSends, forget,
  myRecord, anchorPeer, recordFelts, ensureFromBlock,
} from "../../cli/src/commands.ts";
import { resolve } from "node:path";
import type { State } from "../../cli/src/state.ts";
import type { Chain } from "../../cli/src/chain.ts";
import type { Effect, Event } from "./app.ts";

export type Deps = {
  readonly save: (state: State) => void;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, text: string) => void;
  readonly chain: (state: State) => Chain;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  /**
   * Scratch that lives as long as one TUI session and is not written anywhere.
   *
   * IT WAS A MODULE-LEVEL VARIABLE FIRST, AND A TEST CAUGHT IT. One test drove an unreachable
   * node, the memo outlived it, and the next test's identity creation silently skipped discovery
   * and asserted the wrong thing. A process-scoped memo in a module two front ends import is not
   * session scope, it just looks like it until something else in the process disagrees.
   */
  readonly session: { discoveryFailedFor: string | null };
};

const clock = (t: number) => new Date(t).toISOString().slice(11, 19);

/**
 * What to show when an effect throws, which for a network failure is not what it threw.
 *
 * **`c` AGAINST A VAULT THAT IS NOT RUNNING WAITED TEN SECONDS AND SAID `fetch failed`.** Found by
 * driving the real interface through a pty on a machine with nothing else running — which is the
 * state a first-time user is in, and the one no test was in. Two words, after a long stall, naming
 * neither the host that did not answer nor the thing to do about it. That is the difference
 * between a product that is not set up and a product that is broken, and only one of those gets
 * reported.
 *
 * **KEYED ON `cause.code`, NOT ON THE STRING `fetch failed`.** The first version matched that
 * message exactly. It is undici's, not this product's — undocumented, unversioned, and free to
 * change on a Node bump — so a rename would have made this branch dead, silently, and the product
 * would have gone back to saying the worst sentence it says to anyone with nothing turning red.
 * A guard keyed to a string somebody else owns is a guard with an expiry date nobody wrote down.
 *
 * `cause` is where `fetch` puts the underlying system error, and its `code` — `ECONNREFUSED`,
 * `ECONNRESET`, `ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT` — is the contractual part and the only part
 * that distinguishes refused from timed out from unresolvable.
 *
 * NOTHING ELSE IS TOUCHED. No error raised in this repository sets a `cause` (checked), and every
 * one of them was written for a reader — a missing bundle file already names its own path. A
 * handler that reworded those would substitute a guess for a sentence somebody chose.
 */
function describeFailure(e: unknown, state: State | null): string {
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  if (!code) return e instanceof Error ? e.message : String(e);
  // NO POINTER AT STATUS HERE, unlike the block-0 warning. That one points because the sentence it
  // needs does not fit on one row; this one NAMES THE ADDRESS, so sending the reader to a page to
  // look up a string already in front of them is the padding that pushes the remedy off the right
  // edge at 80 columns. Measured in a pty: the two together are 79.
  return `${state?.vaultUrl ?? "the vault"} did not answer (${code}) — is it running?`;
}

export async function perform(effect: Effect, state: State | null, deps: Deps): Promise<Event> {
  try {
    return await run(effect, state, deps);
  } catch (e) {
    return { t: "error", text: describeFailure(e, state) };
  }
}

/**
 * The node that would not answer the deployment-block discovery, so this session stops asking.
 *
 * **NEVER-FATAL PLUS A LOOP IS A COST PAID FOREVER.** `ensureFromBlock` leaves `fromBlock` at 0
 * when it fails, so the next send asks again, and the next read after that. A CLI process asks
 * once and exits; a resident client asks on every action. Where the node is unreachable rather
 * than refusing — a firewall, a dead port, a laptop that slept — each of those is a full connect
 * timeout, measured here at 10.5 seconds, in front of an operation that was going to fail anyway.
 * Before the repair moved into the shared path this surface made no such call at all, so the fix
 * introduced a cost on a path that had none.
 *
 * KEYED ON THE URL, NOT A BARE FLAG. A user who edits the RPC in the setup page has changed the
 * thing that failed, and should get an attempt rather than a session that has given up. It also
 * keeps the memo from leaking between tests that stand up different fixtures.
 *
 * NOTHING PERSISTED AND NO WINDOW. A timestamp in the state file would need a retry interval, and
 * any number chosen for one would be invented rather than measured. A restart is the retry, which
 * is what a user does anyway when the node was down, and `view.ts` puts that sentence on the
 * status line so it is a stated condition rather than a silent slow client.
 */
/** `ensureFromBlock`, at most one attempt per node per session. Returns true when it changed state. */
async function ensureFromBlockOnce(
  state: State,
  deps: Deps,
  onFail: (e: Error) => void = () => {},
): Promise<boolean> {
  if (deps.session.discoveryFailedFor === state.rpcUrl) return false;
  return ensureFromBlock(state, deps.fetchImpl, (e) => {
    deps.session.discoveryFailedFor = state.rpcUrl;
    onFail(e);
  });
}

async function run(effect: Effect, state: State | null, deps: Deps): Promise<Event> {
  if (effect.t === "init") {
    const f = effect.fields;
    const next = init({
      vaultUrl: f.vault, rpcUrl: f.rpc, contract: f.contract,
      accountsFile: f.accountsFile, account: f.account,
      network: f.network || undefined,
      invites: f.invites.split(",").map((s) => s.trim()).filter(Boolean),
    });
    // **THE RESIDENT CLIENT READ FROM BLOCK 0 FOREVER AND NOBODY NOTICED**, because the repair
    // lived in `cli.ts` and this file never called it. Measured on a genuinely TUI-created state
    // against Sepolia: 108 seconds and 178 RPC round trips to return seven events, on every read.
    // The CLI had been repairing itself since the fix landed; the surface `0022` makes primary
    // had not. Same defect `chainFor` was moved to `chain.ts` to prevent — two front ends, one
    // of which picks differently.
    // RESTORED ON BOTH SURFACES, not just the one that had it. The CLI used to print three lines
    // when discovery failed and the move into `commands.ts` dropped them; putting them back in
    // `cli.ts` alone would rebuild the asymmetry this file's whole finding was about. A TUI has no
    // stderr to print at, so it goes where a TUI says things: on the line the user just caused.
    // **SHORT, AND IT POINTS.** The first version said the whole thing here and the log line is
    // ONE ROW, truncated at the terminal width: driven through a pty at 100 columns it came out
    // as "…but the node did not answer (fetc…", so the half naming the problem survived and the
    // half naming the remedy did not. That is the same defect as the status row two files over,
    // and worse than silence. The full sentence lives on Status, which wraps; this says go there.
    let unreached = "";
    await ensureFromBlockOnce(next, deps, () => { unreached = "node unreachable — see Status (6) · "; });
    deps.save(next);
    // **THE WARNING GOES FIRST, AND THAT ORDERING IS THE FIX.** Shortening it was not enough: a
    // 32-character fingerprint plus "identity created" is already 62 columns, so at 80 the
    // warning fell off the end whatever it said. Truncation eats the tail, so the tail has to be
    // the part you can afford to lose — and the fingerprint is on Identity (3) permanently while
    // this line is the only place the failure is ever mentioned.
    return { t: "ok", state: next,
      text: `${unreached}identity created — fingerprint ${fingerprint(publishBundle(next))}` };
  }

  if (!state) return { t: "error", text: "no identity yet" };

  switch (effect.t) {
    case "send": {
      if (await ensureFromBlockOnce(state, deps)) deps.save(state);
      const r = await sendMessage(
        state, deps.chain(state), effect.channel,
        effect.signed ? "signed" : "ephemeral", effect.text, deps.now());
      deps.save(state);
      return {
        t: "ok", state,
        text: `${effect.signed ? "signed" : "deniable"} · ${r.txHash.slice(0, 12)}… — upload at `
          + `${clock(r.uploadAt)} with ${r.decoys} decoys`,
      };
    }
    case "read": {
      // A state file created before the repair existed still says 0. Once, then persisted.
      if (await ensureFromBlockOnce(state, deps)) deps.save(state);
      const messages = await readChannel(state, deps.chain(state), effect.channel, deps.fetchImpl);
      return {
        t: "messages", channel: effect.channel, messages,
        foreign: foreignSends(state, effect.channel),
      };
    }
    case "flush": {
      // ONE OBJECT PER TICK, not everything due. The one-second tick is the pacing, so a client
      // that has fallen behind trickles rather than dumping — see `FLUSH_LIMIT`. Sleeping inside
      // the effect would stall every other effect behind it; the timer already does the job.
      // Saved in a `finally` for the reason the CLI is: `flush` spends an invite per successful
      // upload and commits its own progress, and that only reaches disk if this runs. Without it
      // a partial flush leaves spent codes looking unspent and uploaded objects still queued.
      try {
        const r = await flush(state, deps.now(), deps.fetchImpl, FLUSH_LIMIT);
        return { t: "ok", state, text: `uploaded ${r.uploaded}, ${r.waiting} still scheduled` };
      } finally {
        deps.save(state);
      }
    }
    case "collect": {
      const r = await collect(state, deps.fetchImpl);
      deps.save(state);
      const text = r.accepted.length
        ? `accepted ${r.accepted.join(", ")}`
        : r.rejected ? `${r.rejected} slot(s) held something that did not open` : "nothing waiting";
      return { t: "ok", state, text };
    }
    case "rotate": {
      const r = rotatePrekey(state);
      deps.save(state);
      return {
        t: "ok", state,
        text: `epoch ${r.retired} destroyed; ${r.oneTimeLeft} one-time prekeys — anyone holding `
          + "the old bundle who has not been collected can no longer reach you",
      };
    }
    case "invite": {
      const bundle = decodeWire(deps.readFile(effect.path));
      const { slot } = await openAndSend(state, effect.name, bundle, deps.fetchImpl);
      deps.save(state);
      return {
        t: "ok", state,
        // The fingerprint is in the confirmation because it is the only thing that makes the
        // channel mean anything, and it has to be checked by some route that is not this one.
        text: `${effect.name} opened with ${fingerprint(bundle)} → slot ${slot} — check that `
          + "fingerprint with them by some other means",
      };
    }
    case "forget": {
      const r = await forget(state, effect.channel, undefined, deps.fetchImpl);
      const gone = r.forgotten;
      deps.save(state);
      return {
        t: "ok", state, clear: effect.channel,
        text: `${gone} message(s) gone from this device — the vault keeps the ciphertext until `
          + "it expires, and the other end keeps its own copy",
      };
    }
    case "export": {
      const index = nextOneTime(state);
      deps.writeFile(effect.path, encodeWire(publishBundle(state, index)));
      // **RESOLVED, BECAUSE `wrote bundle.json` DOES NOT SAY WHERE.** The field's default is a
      // bare relative name, so the file lands in whatever directory the program was started from
      // — and the same line tells the user to go and give that file to somebody. Driving this
      // through a pty from a checkout put a stray `bundle.json` in the repository, which is how
      // it was noticed. A path the reader can act on costs the same number of rows.
      const where = resolve(effect.path);
      return {
        t: "ok", state,
        text: index === undefined
          ? `wrote ${where} — WITH NO ONE-TIME PREKEY, so it has no replay resistance; press R`
          : `wrote ${where} — give it to whoever wants to reach you`,
      };
    }
    case "record": {
      // The client writes the felts; it does not write them to chain. The identity contract's
      // data ABI is not verified anywhere in this repo, and publishing under a guessed
      // entrypoint puts a record where nobody looks. `decisions/0027` says so and says what
      // would close it.
      const { felts, fingerprint: fp } = myRecord(state, BigInt(effect.address));
      deps.writeFile(effect.path, felts.map((f) => `0x${f.toString(16)}`).join(" "));
      return {
        t: "ok", state,
        text: `wrote ${felts.length} felts to ${effect.path} for ${fp} — publishing them at `
          + `${effect.address} is a separate act this client does not perform`,
      };
    }
    case "anchor": {
      const felts = deps.readFile(effect.path).trim().split(/\s+/).filter(Boolean).map((f) => BigInt(f));
      if (felts.length !== recordFelts) {
        return { t: "error", text: `a record is ${recordFelts} felts; ${effect.path} holds ${felts.length}` };
      }
      const at = anchorPeer(state, effect.channel, BigInt(effect.address), felts);
      deps.save(state);
      return {
        t: "ok", state,
        text: `${effect.channel}'s signing key is published at ${at} and matches the handshake — `
          + "which does not say the address is the person you mean",
      };
    }
    default:
      return { t: "error", text: `no such effect: ${(effect as { t: string }).t}` };
  }
}
