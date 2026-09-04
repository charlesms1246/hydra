import { MEASURED } from "../../../hydra-dapp/packages/claims/src/statement.ts";
import { Figure, INK, Tick } from "./Figure.tsx";

/**
 * The number this project is proudest of publishing, drawn.
 *
 * A message sent well apart from any other hides only among its own decoys. Messages sent close
 * together hide among each other's too. The site prints both figures; this shows why they differ,
 * which is the part a percentage cannot carry.
 *
 * **The unflattering number is the one drawn in the accent.** A figure that made the good case
 * visually louder would be doing with layout what the copy is forbidden from doing with words.
 */
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function AnonymitySet() {
  const isolated = MEASURED.coverRate + 1;
  /** Derived from the published rate, not chosen: the set the clustered figure implies. */
  const clustered = Math.round(1 / MEASURED.clusteredMessageIdentified);

  /* Radius tracks set size rather than being uniform: the point of the pair is that one crowd is
     seven times the other, and two rings of equal size would say the opposite of the numbers
     underneath them. */
  const dot = (n: number, cx: number, cy: number, r: number, marked: boolean) =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      return (
        <circle
          key={i}
          cx={cx + Math.cos(a) * r}
          cy={cy + Math.sin(a) * r}
          r={3}
          fill={i === 0 && marked ? INK.accent : INK.g32}
        />
      );
    });

  return (
    <Figure
      viewBox="0 0 320 128"
      label={
        `Sent alone, a message hides among its ${MEASURED.coverRate} decoys — a set of `
        + `${isolated}, identified about ${pct(MEASURED.isolatedMessageIdentified)} of the time. `
        + `Sent in quick succession, messages hide among each other's decoys too, and the rate `
        + `falls to about ${pct(MEASURED.clusteredMessageIdentified)}.`
      }
      caption={
        <>
          Both figures are published. The site quotes the worse one, because a conversation is
          allowed to be slow.
        </>
      }
    >
      <g>
        {dot(isolated, 62, 58, 20, true)}
        <Tick x={62} y={104} anchor="middle" fill={INK.accent}>
          {`${pct(MEASURED.isolatedMessageIdentified)} IDENTIFIED`}
        </Tick>
        <Tick x={62} y={116} anchor="middle" fill={INK.g48}>
          {`sent alone · set of ${isolated}`}
        </Tick>
      </g>

      <g>
        {dot(clustered, 232, 58, 44, true)}
        <Tick x={232} y={104} anchor="middle" fill={INK.g64}>
          {`${pct(MEASURED.clusteredMessageIdentified)} IDENTIFIED`}
        </Tick>
        <Tick x={232} y={116} anchor="middle" fill={INK.g48}>
          {`in quick succession · set of ~${clustered}`}
        </Tick>
      </g>
    </Figure>
  );
}
