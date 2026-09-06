/**
 * The opt-in that stands between `npm run test:live` and a transaction nobody asked for.
 *
 * ## WHY THIS IS A MODULE AND NOT A CONSTANT IN EACH FILE
 *
 * `live-record-anchor.test.ts` had a gate — `HYDRA_ANCHOR_SEND` — and its neighbour
 * `live-authorship.test.ts` published five transactions with none. **A rule enforced on one
 * surface and absent on the one beside it** is the defect this repository has spent the week
 * recording, and the fix for it is never a second copy of the rule.
 *
 * It matters because of where the command is written. `npm run test:live` appears in
 * `scripts/redeploy.ts` as the thing to run once a stack is up, and in two test headers as
 * `source ~/.hydra/live-env.sh && npm run test:live`. Somebody following any of those got chain
 * writes as a side effect of a command that reads like a test run.
 *
 * ## ONE NAME, AND THE OLD ONE IS GONE RATHER THAN ALIASED
 *
 * `HYDRA_LIVE_WRITE`. `HYDRA_ANCHOR_SEND` was renamed rather than kept working alongside it:
 * two spellings of one gate is the same drift one layer up, and the only thing referencing the
 * old name was a runbook that has been updated with it. An alias would have been the kinder
 * choice for exactly one reader and a permanent second answer to "what turns writes on".
 *
 * ## THE MESSAGE SAYS WHAT IT WOULD DO, NOT THAT IT WAS SKIPPED
 *
 * A skip that reads *"skipped"* is a line people scroll past; a skip that names the variable and
 * the cost is a decision the reader can make. Node prints the string beside the test, so this is
 * the only place that sentence is ever seen.
 */

/** True when the operator has explicitly asked for chain writes this run. */
export const LIVE_WRITE = process.env.HYDRA_LIVE_WRITE === "1";

/**
 * The `skip` option for a test that writes to a chain.
 *
 * `costs` is the specific damage, in the operator's terms — testnet funds, a permanent public
 * record, a devnet that has to be rebuilt. Written per call site because the cost genuinely
 * differs, and a generic "this writes to a chain" would let the expensive case hide behind the
 * cheap one.
 */
export const writesToChain = (costs: string): string | false =>
  LIVE_WRITE ? false : `set HYDRA_LIVE_WRITE=1 to run this — it ${costs}`;
