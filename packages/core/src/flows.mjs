/**
 * Saved run flows.
 *
 * Kept in `$HYDRA_HOME/flows.json` and NOT in `state.json`, which `clearState()`
 * deletes on `hydra down` — a flow you built is yours, and losing it because you
 * stopped a devnet would be absurd.
 *
 * A flow stores enum members and strings only: an action type, account names, a
 * token symbol, a whole-token amount. Never a function and never a command string,
 * because this file is read back and executed against a live chain, and a saved
 * shell fragment is an obvious way to turn a config file into an exploit.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
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
  return {
    ok: true,
    flow: {
      id: input?.id ?? `f${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name,
      type,
      from: String(input?.from ?? "").trim().slice(0, 40) || null,
      to: String(input?.to ?? "").trim().slice(0, 40) || null,
      token: String(input?.token ?? "STRK").trim().slice(0, 10),
      amount: amount || null,
      runnable: RUNNABLE.includes(type),
    },
  };
}

export async function listFlows() {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8"));
    const flows = Array.isArray(parsed?.flows) ? parsed.flows : [];
    return { available: true, flows, file: file() };
  } catch {
    return { available: true, flows: [], file: file() };
  }
}

export async function saveFlow(input) {
  const v = validate(input);
  if (!v.ok) return v;
  const { flows } = await listFlows();
  const next = [v.flow, ...flows.filter((f) => f.id !== v.flow.id)].slice(0, 50);
  try {
    await mkdir(process.env.HYDRA_HOME ?? HYDRA_HOME, { recursive: true });
    await writeFile(file(), JSON.stringify({ version: 1, flows: next }, null, 2));
    return { ok: true, flow: v.flow, flows: next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function forgetFlow(id) {
  const { flows } = await listFlows();
  if (!flows.some((f) => f.id === id)) return { ok: false, error: "no such flow" };
  const next = flows.filter((f) => f.id !== id);
  try {
    await writeFile(file(), JSON.stringify({ version: 1, flows: next }, null, 2));
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
