/**
 * Saved run flows.
 *
 * Kept in `$HYDRA_HOME/flows.json` and NOT in `state.json`, which `clearState()`
 * deletes on `hydra-dev down` — a flow you built is yours, and losing it because you
 * stopped a devnet would be absurd.
 *
 * A flow stores enum members and strings only: an action type, account names or
 * addresses, a token symbol, a whole-token amount. Never a function and never a
 * command string, because this file is read back and executed against a live chain,
 * and a saved shell fragment is an obvious way to turn a config file into an exploit.
 */

import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { HYDRA_HOME } from "./state.mjs";
import { ACTION_TYPES } from "../../leak/src/facts.mjs";

/**
 * Resolved per call, not once at import.
 *
 * `HYDRA_HOME` is read from the environment when state.mjs is first evaluated, so a
 * caller that sets it later — the sandbox does, and so does any test — would have
 * been writing to the wrong directory while believing otherwise. A path is cheap;
 * a file written somewhere nobody looks is not.
 */
const file = () => join(process.env.HYDRA_HOME ?? HYDRA_HOME, "flows.json");

/** The action types this stack can actually submit, as opposed to reason about. */
export const RUNNABLE = ["register", "deposit", "transfer"];

/** A felt address, as opposed to one of the stack's account names. */
const isAddress = (v) => /^0x[0-9a-fA-F]{1,64}$/.test(String(v ?? "").trim());

/**
 * Why a flow cannot be submitted, or null when it can.
 *
 * Two reasons, and they are different in kind. A type with no control endpoint is a
 * gap in this stack; a pasted address is a gap in what a local devnet can be asked
 * to do at all — `control.mjs:41` keys its accounts by NAME, and no amount of API
 * surface makes a party whose key nobody holds able to sign.
 */
export function whyNotRunnable(flow) {
  if (!RUNNABLE.includes(flow.type)) return "no control endpoint — preview only";
  if (isAddress(flow.from)) return "from is an address — this stack holds no key for it";
  if (isAddress(flow.to)) return "to is an address — the control API takes account names";
  return null;
}

/**
 * Validate a flow. Returns `{ok, flow}` or `{ok:false, error}`.
 *
 * `withdraw` and `invoke` are real members of ACTION_TYPES — the leak module models
 * both — but the control API exposes no endpoint for either, so a flow of that type
 * can be built and previewed and cannot be run. That is recorded on the flow rather
 * than hidden, because "you may look at this one but not run it" is a fact about
 * this stack, not a validation failure.
 */
export function validate(input) {
  const type = String(input?.type ?? "").trim();
  if (!ACTION_TYPES.includes(type)) return { ok: false, error: `type must be one of ${ACTION_TYPES.join(", ")}` };
  const name = String(input?.name ?? "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "a flow needs a name" };
  const amount = String(input?.amount ?? "").trim();
  if (amount && !/^\d+(\.\d+)?$/.test(amount)) return { ok: false, error: "amount must be a number" };
  const flow = {
    id: input?.id ?? `f${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    type,
    // 66 characters, because `from` and `to` may now be a full felt address and not
    // only a name. The old 40-character clamp would have stored a truncated address,
    // which is a different address.
    from: String(input?.from ?? "").trim().slice(0, 66) || null,
    to: String(input?.to ?? "").trim().slice(0, 66) || null,
    token: String(input?.token ?? "STRK").trim().slice(0, 10),
    amount: amount || null,
  };
  const reason = whyNotRunnable(flow);
  return { ok: true, flow: { ...flow, runnable: !reason, reason } };
}

/**
 * The saved flows, or a refusal to guess.
 *
 * "You have no flows yet" and "your flows file could not be read" are DIFFERENT FACTS and
 * this used to return the same value for both — `{ available: true, flows: [] }`. That is
 * not a display problem. `saveFlow` reads this and writes back what it gets, so an
 * unreadable file made the next save rewrite it with one flow, silently, exit 0. Twelve
 * saved flows for one keypress and no message.
 *
 * The file becomes unreadable the ordinary way: the write below is a single `writeFile`,
 * so a process killed mid-write leaves truncated JSON. `history.mjs:62-65` reasoned about
 * exactly this — a process killed mid-append is "the whole point of choosing JSONL over one
 * JSON array" — and that reasoning never reached the file whose own header says losing it
 * "would be absurd".
 *
 * ENOENT is the only error that means "none yet". Everything else, including JSON that
 * parses to the wrong shape, is `available: false` with the reason, and every caller that
 * writes must check it.
 */
export async function listFlows() {
  let text;
  try {
    text = await readFile(file(), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { available: true, flows: [], file: file() };
    return { available: false, flows: [], error: e.message, file: file() };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { available: false, flows: [], error: `not valid JSON: ${e.message}`, file: file() };
  }
  // A file that parses but carries no `flows` array is corrupt too, and reaches this the
  // same way — a torn write can land on a prefix that happens to be valid JSON.
  if (!Array.isArray(parsed?.flows)) {
    return { available: false, flows: [], error: "no flows array in the file", file: file() };
  }
  return { available: true, flows: parsed.flows, file: file() };
}

/**
 * Write the whole file by rename, never in place.
 *
 * `rename(2)` within one filesystem is atomic: a reader sees the old file or the new one and
 * never a prefix of the new one. The plain `writeFile` this replaces is what made a truncated
 * `flows.json` reachable at all — kill the process between `open(O_TRUNC)` and the last byte
 * and the user's flows are gone, which is the corruption `listFlows` above now refuses to
 * write over. Refusing was the urgent half; this is the half that stops it happening.
 *
 * The temp file is a sibling because a rename across filesystems is a copy, not a rename, and
 * `$HYDRA_HOME` can be anywhere. Named with the pid so two processes cannot collide on it.
 *
 * NOT fsync'd. The failure this defends against is a killed process, where the kernel still
 * holds the written bytes; surviving a power cut as well would cost an fsync of the file and
 * its directory on every save, and nothing here is worth that.
 */
async function writeFlows(next) {
  await mkdir(process.env.HYDRA_HOME ?? HYDRA_HOME, { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ version: 1, flows: next }, null, 2));
    await rename(tmp, file());
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Refuse rather than overwrite. `existing.flows` is empty for both causes; only this tells them apart. */
const unreadable = (existing) =>
  existing.available ? null : `${existing.file} could not be read (${existing.error}) — move or repair it first`;

export async function saveFlow(input) {
  const v = validate(input);
  if (!v.ok) return v;
  const existing = await listFlows();
  const why = unreadable(existing);
  if (why) return { ok: false, error: why };
  const next = [v.flow, ...existing.flows.filter((f) => f.id !== v.flow.id)].slice(0, 50);
  try {
    await writeFlows(next);
    return { ok: true, flow: v.flow, flows: next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function forgetFlow(id) {
  const existing = await listFlows();
  // Before the membership test, not after: an unreadable file has no members, so "no such
  // flow" would blame the id for a problem with the file.
  const why = unreadable(existing);
  if (why) return { ok: false, error: why };
  if (!existing.flows.some((f) => f.id === id)) return { ok: false, error: "no such flow" };
  const next = existing.flows.filter((f) => f.id !== id);
  try {
    await writeFlows(next);
    return { ok: true, flows: next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * The leak action a flow describes.
 *
 * `opensChannel` is deliberately absent: it is a chain fact, resolved by the caller
 * from the pool's public channel-count view, and defaulting it here would put the
 * reassuring branch back in by the side door.
 */
export function leakActionFor(flow) {
  if (!flow) return null;
  const base = { type: flow.type };
  if (flow.token) base.token = flow.token;
  if (flow.amount) base.amount = flow.amount;
  if (flow.to) base.counterparty = flow.to;
  return base;
}
