/**
 * A `fetch` that can reach this machine's fixtures and nothing else.
 *
 * **A TEST MAY TALK TO A FIXTURE THIS MACHINE STARTED. IT MAY NOT TALK TO THE INTERNET.** That is
 * the whole property. Loopback is allowed rather than "no I/O" because several suites here serve
 * over a real socket deliberately — the vault needs a process boundary that only a real one has,
 * and `tui-conversation.test.ts` now runs a real JSON-RPC node too.
 *
 * A DURATION BUDGET WOULD BE THE PROXY; THIS IS THE PROPERTY. A ceiling catches a network call
 * only because network calls are usually slow, so it fires late, blames the wrong test and goes
 * flaky on a loaded machine. Refusing the network states the thing actually wanted: it fails at
 * the call, names the host, and cannot be satisfied by a fast network.
 *
 * ---
 *
 * **WHAT THIS FILE WAS FIRST WRITTEN TO FIX, IT DID NOT FIX. Recorded rather than quietly
 * corrected, because a guard credited with a repair it did not make is a guard nobody removes
 * when it stops earning its place.**
 *
 * `ensureFromBlock` moved into the shared command path, the TUI began calling it, and the suite
 * went from about a minute to three minutes twenty-two with every test still passing. The first
 * version of this file said the cause was three tests bisecting a public Sepolia node at 42
 * seconds each, and refusing the network was the fix.
 *
 * Measured, three ways, and none of it held:
 *
 *   - Every fetch those tests make is loopback. Nineteen calls, zero non-loopback attempts. The
 *     setup page defaults `rpc` to `http://127.0.0.1:5050` and no test overrode it, so a live
 *     chain was never reachable from that path — and this guard permits 127.0.0.1 anyway.
 *   - Guard in: 199,666 ms. Guard swapped back for the bare global: 199,677 ms. Eleven
 *     milliseconds across two hundred seconds.
 *   - The real cost was the dead port. Nothing listens on 5050 during a test run, and on this
 *     machine that connection is not refused — it hangs for undici's ten-second connect timeout.
 *     One timeout measured alone: 10,516 ms. Seven tests paying one and three paying four is
 *     nineteen calls and 200 seconds, which is the whole of it.
 *
 * **The fix was `fixture-node.ts`** — a real node on a real loopback socket, answering the two
 * methods the discovery uses. That file is 4.2 seconds now.
 *
 * The diagnosis was wrong and the property is still worth holding, which is why this file exists
 * and why its reason is stated in terms of what it refuses rather than what it once saved.
 *
 * **IT IS A FLOOR, NOT A CEILING.** On a never-fatal path the throw is caught by the code under
 * test — `ensureFromBlock` swallows by design — so the refusal surfaces as whatever the caller
 * asserts next rather than as the message below. Proven that way: pointing the TUI tests at a
 * public node fails `A TUI-CREATED IDENTITY STARTS AT THE DEPLOYMENT BLOCK` in 22 ms, with no
 * traffic leaving the machine, and the developer reads "fromBlock is 0" rather than "you tried to
 * reach the internet". The guard still stops the call; it does not guarantee it explains itself.
 */

/** Hosts a test is allowed to reach: its own fixtures, on this machine. */
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class NetworkInTest extends Error {}

/**
 * Wrap a fetch so that anything off this machine throws.
 *
 * Takes the implementation to wrap so a test can layer this over its own fake rather than being
 * forced to choose between the two.
 */
export function loopbackOnly(inner: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === "string" ? input
      : input instanceof URL ? input.href
        : (input as Request).url;
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      // Not a URL this can judge. Refusing is the safe direction: an unparseable target in a
      // hermetic test is not something to pass through on the assumption it is harmless.
      throw new NetworkInTest(`a test fetched ${raw}, which is not a URL this guard can check`);
    }
    if (!LOCAL.has(host)) {
      throw new NetworkInTest(
        `a hermetic test tried to reach ${host} (${raw}).\n\n`
        + "Tests may talk to fixtures this machine started and nothing else. If this path needs a "
        + "chain or a vault, inject a double; if it is genuinely a live test, it belongs in the "
        + "live suite behind HYDRA_RPC. This guard exists because a real fetch leaking into the "
        + "TUI tests cost three and a half minutes a run and failed nothing.");
    }
    return inner(input, init);
  }) as typeof fetch;
}
