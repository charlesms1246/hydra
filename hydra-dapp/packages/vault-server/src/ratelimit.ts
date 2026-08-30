/**
 * Rate limiting, and what it costs in disclosure.
 *
 * A public vault needs one. Reads are unauthenticated by design — the blob id *is* the
 * capability — so there is nothing to charge a quota against, and without a limit one client
 * can exhaust the service for everyone.
 *
 * THE TENSION, which is the whole reason this file has a header. Rate limiting per client
 * requires knowing which client, and "which client" is exactly the thing the vault otherwise
 * refuses to know. `observations.ts` says the operator cannot see who uploaded an object,
 * because there are no accounts and an invite is destroyed at redemption. Turning on per-peer
 * limiting makes that less true: for the length of a window, requests from one address are
 * linkable to each other. Not to a person, and not across windows — but linkable.
 *
 * So the mode is a deliberate choice with a documented cost, not a default someone inherits:
 *
 *   none        no limiting. Honest for a private instance; irresponsible for a public one.
 *   global      one bucket for everyone. Keeps no per-client state at all, and one abusive
 *               client degrades the service for all of them. The trade is real either way.
 *   per-peer    a counter keyed by a salted hash of the source address, decaying with the
 *               window. Effective, and it adds `rate.peerBucket` to the disclosure table.
 *
 * The salt is generated per process and never persisted. That is deliberate: a stable salt
 * would make the key a durable pseudonym for an address, and a restart would no longer clear
 * it. It also means the counter cannot survive a restart, which is a real cost — a restart
 * resets everyone's quota — accepted because the alternative is a file of hashed addresses.
 */

import { createHmac, randomBytes } from "node:crypto";

export type RateLimitConfig =
  | { readonly mode: "none" }
  | { readonly mode: "global"; readonly perMinute: number }
  | { readonly mode: "per-peer"; readonly perMinute: number };

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { mode: "global", perMinute: 600 };

const WINDOW_MS = 60_000;

/**
 * A fixed-window counter.
 *
 * Fixed rather than sliding, because a sliding window has to remember individual request
 * timestamps and a fixed one remembers a count. Fewer bytes about a client is the point, and
 * the cost — a client can send two windows' worth across a boundary — is one this service can
 * absorb and a privacy claim cannot.
 */
export class RateLimiter {
  readonly #config: RateLimitConfig;
  readonly #salt: Buffer;
  readonly #counts = new Map<string, { window: number; n: number }>();
  readonly #now: () => number;

  constructor(config: RateLimitConfig = DEFAULT_RATE_LIMIT, now: () => number = () => Date.now()) {
    this.#config = config;
    // Per process, never written down. A stable salt would turn this key into a durable
    // pseudonym for an address, which is what the mode is trying not to be.
    this.#salt = randomBytes(32);
    this.#now = now;
  }

  get mode(): RateLimitConfig["mode"] {
    return this.#config.mode;
  }

  /** True when this limiter keeps anything that distinguishes one client from another. */
  get keyedByPeer(): boolean {
    return this.#config.mode === "per-peer";
  }

  /**
   * The key a request counts against.
   *
   * For `per-peer`, a truncated HMAC of the address rather than the address: the operator
   * reading memory sees a 16-hex-character token, not an IP. That is a smaller disclosure and
   * emphatically not none — the token is stable for the process's lifetime, so requests from
   * one address remain linkable to each other.
   */
  #key(peer: string): string {
    if (this.#config.mode !== "per-peer") return "*";
    return createHmac("sha256", this.#salt).update(peer).digest("hex").slice(0, 16);
  }

  /** Consume one request. Returns false when the caller should be refused. */
  allow(peer: string): boolean {
    if (this.#config.mode === "none") return true;
    const window = Math.floor(this.#now() / WINDOW_MS);
    const key = this.#key(peer);
    const entry = this.#counts.get(key);
    if (!entry || entry.window !== window) {
      // Replacing rather than accumulating is what makes the window decay: last window's
      // count is gone, not archived.
      this.#counts.set(key, { window, n: 1 });
      this.#sweep(window);
      return true;
    }
    entry.n += 1;
    return entry.n <= this.#config.perMinute;
  }

  /** Drop stale windows, so the map is not a growing list of everyone who ever connected. */
  #sweep(window: number): void {
    for (const [key, entry] of this.#counts) {
      if (entry.window < window) this.#counts.delete(key);
    }
  }

  /** What an operator reading this limiter's memory would find. */
  observe(): { mode: string; keys: string[] } {
    return { mode: this.#config.mode, keys: [...this.#counts.keys()] };
  }
}
