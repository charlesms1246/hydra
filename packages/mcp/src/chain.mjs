/**
 * Live, read-only reads against a public Starknet node.
 *
 * Same method as `experiments/06-live-corroboration/auditor-key.mjs`, which produced
 * findings/06: try each endpoint in order, take the first that answers `starknet_chainId`,
 * then `starknet_call` the pool's views. Makes no transaction and spends nothing.
 */

import { RpcProvider } from "starknet";
import { NETWORKS, POOL_VIEWS, feltEq, network } from "./networks.mjs";

/** Probes every candidate endpoint. Reports each result — a dead endpoint is the finding. */
export async function probeEndpoints(name) {
  const { rpc } = network(name);
  return Promise.all(
    rpc.map(async (url) => {
      try {
        const chainId = await new RpcProvider({ nodeUrl: url }).getChainId();
        return { url, ok: true, chainId };
      } catch (e) {
        return { url, ok: false, error: String(e.message).slice(0, 120) };
      }
    })
  );
}

/** First endpoint that answers, or null. */
export async function connect(name) {
  for (const url of network(name).rpc) {
    try {
      const provider = new RpcProvider({ nodeUrl: url });
      const chainId = await provider.getChainId();
      return { provider, url, chainId };
    } catch {
      /* try the next one */
    }
  }
  return null;
}

async function callView(provider, pool, entrypoint) {
  const res = await provider.callContract({ contractAddress: pool, entrypoint, calldata: [] });
  const vals = (Array.isArray(res) ? res : (res.result ?? [])).map(String);
  return vals.length === 1 ? vals[0] : vals;
}

/**
 * Reads the four pool views plus the deployed class hash.
 *
 * Every value is returned with the value findings/06 recorded on 2026-08-29 and a
 * `drift` flag. Governance can rotate the auditor key or replace the class
 * (`ReplaceabilityComponent`, upgrade_delay 0, packages/privacy/src/privacy.cairo:162),
 * and per findings/01 an auditor rotation strands every prior registration's escrow with
 * the outgoing auditor — so drift is reported, not silently accepted.
 */
export async function readPoolState(name) {
  const net = network(name);
  const conn = await connect(name);
  if (!conn) {
    return {
      network: name,
      error: "no working RPC endpoint",
      endpointsTried: net.rpc,
      note: "Live state UNKNOWN. Do not substitute the recorded values below for a live read.",
      recorded: net.recorded,
    };
  }

  const views = {};
  for (const view of Object.keys(POOL_VIEWS)) {
    try {
      views[view] = await callView(conn.provider, net.pool, view);
    } catch (e) {
      views[view] = { error: String(e.message).slice(0, 120) };
    }
  }

  const classHash = await conn.provider
    .getClassHashAt(net.pool)
    .catch((e) => ({ error: String(e.message).slice(0, 120) }));

  return { network: name, rpcUsed: conn.url, chainId: conn.chainId, pool: net.pool, views, classHash };
}

/** Compares a live value with what findings/06 recorded. */
export function drift(live, recorded) {
  if (live === undefined || live === null || typeof live === "object") return "UNREAD";
  return feltEq(live, recorded) ? "matches findings/06" : `DRIFT — findings/06 recorded ${recorded}`;
}

export const KNOWN_NETWORKS = Object.keys(NETWORKS);
