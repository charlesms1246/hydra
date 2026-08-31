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
  init, publishBundle, openAndSend, collect, sendMessage, flush, readChannel, rotatePrekey,
  fingerprint, nextOneTime, encodeWire, decodeWire, foreignSends, forget,
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
      const r = await flush(state, deps.now(), deps.fetchImpl);
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
    default:
      return { t: "error", text: `no such effect: ${(effect as { t: string }).t}` };
  }
}
