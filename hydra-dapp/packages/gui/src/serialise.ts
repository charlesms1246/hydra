/**
 * One state-mutating operation at a time, across every caller in this process.
 *
 * **A CORRECTNESS RULE, NOT A NICETY, and it is the TUI's.** `app.ts` states it: every effect
 * mutates `State` and then persists it, so two in flight interleave two writes to one file and
 * *"the loser's channel, sequence number or spent invite would silently vanish."*
 *
 * The TUI gets this free from a reducer that refuses to emit a second effect while `busy`. **An
 * HTTP server is concurrent by construction and refuses nothing for you** — two `POST …/send` a
 * millisecond apart are exactly the interleaving that rule exists to prevent. This is the same
 * class as every parity defect in this repository, with one difference worth naming: the others
 * were rules that COULD have been inherited and were not. This one cannot be inherited at all, so
 * it is built deliberately or it is absent, and it presents as a vanished invite rather than as an
 * error.
 *
 * IT COVERS THE FLUSH TICKER TOO. A resident `hydra gui` flushes due uploads on a timer the way
 * the TUI does, and a flush landing mid-send is the same interleaving from the other direction.
 * One lock, shared, rather than one per entry point.
 *
 * **REFUSES RATHER THAN QUEUES.** A queue turns a slow chain publish into a backlog that fires at
 * once when it drains — the burst `upload.burst` exists to prevent — so it would defeat the timing
 * defence while looking like good engineering. Refusing lets the page say "still sending" and ask
 * again.
 *
 * ---
 *
 * **THE INVARIANT A CALLER HAS TO KEEP: NO `await` BETWEEN TAKING THE STATE SNAPSHOT AND CALLING
 * THIS.** `held` is set synchronously below, before the first `await`, so on a single-threaded
 * loop nothing can interleave across the acquisition — *provided the caller's own gap contains no
 * yield.* With one, this lock serialises EXECUTION over state that has already moved, which is not
 * serialisation of anything that matters.
 *
 * That is not hypothetical and the lock did not prevent it. `server.ts` took its snapshot at
 * dispatch and then `await`ed the request body before arriving here; a whole competing send ran in
 * that gap, and the handler went on to save a state that never contained it — **a message
 * published to the chain, answered 200, and absent from history.** The fix was to move the
 * snapshot inside `fn`, and this paragraph is here because the code that broke the rule looked
 * completely correct: it held the lock over every line that touched the state.
 *
 * **AND THIS LOCK IS IN-PROCESS ONLY.** It cannot see `hydra tui` running beside `hydra gui`,
 * which is a configuration `main.ts` explicitly expects. `decisions/0048`.
 */

/** Returned instead of a result when something else holds the lock. */
export const BUSY = Symbol("busy");

export type Exclusive = {
  /** Run `fn` alone, or return {@link BUSY} at once if another operation holds the lock. */
  <T>(what: string, fn: () => Promise<T>): Promise<T | typeof BUSY>;
  /** What is running, so a refusal can name it. */
  readonly running: () => string | null;
};

export function serialise(): Exclusive {
  let held: string | null = null;
  const run = async <T>(what: string, fn: () => Promise<T>): Promise<T | typeof BUSY> => {
    if (held !== null) return BUSY;
    held = what;
    try {
      return await fn();
    } finally {
      // **RELEASED EVEN WHEN THE OPERATION THREW.** A publish that fails while holding a lock
      // released only on success bricks the client until it is restarted — a worse failure than
      // the one that caused it, and one the user cannot diagnose.
      held = null;
    }
  };
  return Object.assign(run, { running: () => held }) as Exclusive;
}
