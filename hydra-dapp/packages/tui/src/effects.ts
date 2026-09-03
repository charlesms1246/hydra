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
  myRecord, anchorPeer, recordFelts,
} from "../../cli/src/commands.ts";
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
};

const clock = (t: number) => new Date(t).toISOString().slice(11, 19);

export async function perform(effect: Effect, state: State | null, deps: Deps): Promise<Event> {
  try {
    return await run(effect, state, deps);
  } catch (e) {
    return { t: "error", text: e instanceof Error ? e.message : String(e) };
  }
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
    deps.save(next);
    return { t: "ok", state: next, text: `identity created — fingerprint ${fingerprint(publishBundle(next))}` };
  }

  if (!state) return { t: "error", text: "no identity yet" };

  switch (effect.t) {
    case "send": {
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
      const r = await flush(state, deps.now(), deps.fetchImpl, FLUSH_LIMIT);
      deps.save(state);
      return { t: "ok", state, text: `uploaded ${r.uploaded}, ${r.waiting} still scheduled` };
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
      const gone = forget(state, effect.channel);
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
      return {
        t: "ok", state,
        text: index === undefined
          ? `wrote ${effect.path} — WITH NO ONE-TIME PREKEY, so it has no replay resistance; press R`
          : `wrote ${effect.path} — give it to whoever wants to reach you`,
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
