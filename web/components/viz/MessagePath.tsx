import { MEASURED } from "../../../hydra-dapp/packages/claims/src/statement.ts";
import { Figure, INK, Tick } from "./Figure.tsx";

/**
 * Where a message goes, with every number taken from `MEASURED`.
 *
 * The prose says a pointer goes on chain and the body goes to a server that cannot read it. The
 * figure says the same thing and adds the shape the prose cannot carry without becoming a list.
 *
 * ⛔ **The labels are in a reader's words, not the project's.** They said `2 FELTS`, `sealed,
 * size-padded`, `1 + 4 DECOYS`. A felt is a Starknet type, padding is our word for a defence, and
 * a decoy is jargon a reader meets here first — the figure was accurate and unreadable, which is
 * the failure mode a diagram has that a paragraph does not, because nobody rereads a diagram.
 *
 * **Not one number here is typed.** `noteFelts`, `buckets.length`, `jitterBlocks` and `coverRate`
 * are read from the same constants the disclosure statement quotes, so a change to a default
 * redraws the diagram rather than dating it.
 */
export function MessagePath() {
  const decoys = MEASURED.coverRate;
  const total = decoys + 1;

  return (
    <Figure
      /*
       * ⛔ **380 wide, not 320, and the right-hand labels are why.**
       *
       * `sealed, size-padded` is 19 monospace characters starting at x=266. At the 7-unit tick
       * size that ends at 362; at the 8-unit size `.fig-tick` switches to below 48rem it ends at
       * 375 — so at 320 the label ran past its own viewBox at every width, and below 1024px the
       * page margin stopped absorbing it and the screen edge cut it to `sealed, size…`, losing
       * exactly the word that distinguishes this leg from the public one.
       *
       * Widening rather than moving the labels: end-anchoring them at the right edge pulls the
       * long one back over the leader line at y=116, and shortening the string spends the
       * qualification to save the layout. The box was the thing that was wrong.
       */
      viewBox="0 0 396 150"
      label={
        `A message splits in two: ${MEASURED.noteFelts} values go on chain as a pointer, and the `
        + `body goes to a storage server as a sealed blob padded to one of `
        + `${MEASURED.buckets.length} fixed sizes, delayed by up to ${MEASURED.jitterBlocks} `
        + `blocks and uploaded alongside ${decoys} decoys.`
      }
      /*
       * ⛔ The caption may not say the server "cannot tell which is the message". It can — about
       * `isolatedMessageIdentified` of the time, which the statement publishes and the next figure
       * draws. An earlier draft said exactly that, and it is the same over-claim the prose is
       * guarded against, arriving in a place the guards reach less well: a figure caption is
       * rendered text, so the forbidden-word check reads it, but the list has no entry for this
       * phrasing and the numeral guard only scans `content.ts`.
       */
      caption={
        <>
          The chain gets {MEASURED.noteFelts} values. The server gets {total} objects — and how
          often it picks the right one is measured rather than assumed.
        </>
      }
    >
      {/* the message */}
      <rect x={0} y={62} width={54} height={22} fill="none" stroke={INK.g64} />
      <Tick x={27} y={76} anchor="middle" fill={INK.fg}>MESSAGE</Tick>

      {/* split */}
      <path d="M54 73 L86 73 M86 73 L86 30 L118 30 M86 73 L86 116 L118 116"
        stroke={INK.g32} fill="none" />

      {/* chain leg */}
      <rect x={118} y={18} width={90} height={24} fill="none" stroke={INK.g48} />
      <Tick x={163} y={33} anchor="middle" fill={INK.g80}>{`${MEASURED.noteFelts} numbers`}</Tick>
      <path d="M208 30 L262 30" stroke={INK.g32} />
      <Tick x={266} y={27} fill={INK.g64}>ON THE CHAIN</Tick>
      <Tick x={266} y={38} fill={INK.g32}>anyone can read it</Tick>

      {/* vault leg — the message and its decoys, indistinguishable */}
      {Array.from({ length: total }, (_, i) => (
        <rect
          key={i}
          x={118 + i * 13}
          y={104}
          width={10}
          height={24}
          /* Drawn identically apart from the accent outline, which is the READER's knowledge
             and not the operator's. The objects themselves are the same shape and the same size
             band — that is what the padding buys. */
          fill={INK.g20}
          stroke={i === 2 ? INK.accent : INK.g32}
        />
      ))}
      <path d="M188 116 L262 116" stroke={INK.g32} />
      <Tick x={266} y={113} fill={INK.g64}>TO A SERVER</Tick>
      <Tick x={266} y={124} fill={INK.g32}>it cannot read it</Tick>

      {/* ⛔ These two are two units apart on y and both start inside the same span on x, which is
          how `YOURS` came to be printed through `DECOYS` in accent red at every width — a
          viewBox-unit collision, so no viewport escaped it. The caption sits above the row and
          `YOURS` sits between it and the rects, centred on the one it names.

          Space below is not available: y=142 is `padded to one of N sizes` and the rects occupy
          104-128. */}
      <Tick x={118} y={86} fill={INK.g48}>
        {`yours + ${decoys} fakes, sent minutes late`}
      </Tick>
      <Tick x={118} y={142} fill={INK.g32}>
        {`all the same size, so size says nothing`}
      </Tick>
      <Tick x={149} y={99} anchor="middle" fill={INK.accent}>YOURS</Tick>
    </Figure>
  );
}
