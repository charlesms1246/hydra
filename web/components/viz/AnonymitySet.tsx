import { MEASURED } from "../../../hydra-dapp/packages/claims/src/statement.ts";
import { Figure, INK, Tick } from "./Figure.tsx";

/**
 * How many identical objects your message is hiding among.
 *
 * ⛔ **It was two rings of dots and nobody could read it.** The rings were accurate — one crowd
 * seven times the other — and a reader had no way in: a dot is not a message, a ring is not a
 * crowd, and "set of 5" is this project's word for a thing the reader has no word for yet.
 *
 * What replaced it is the literal picture: a row of identical objects with one marked as yours.
 * That is what the defence actually is, and it needs no key — a person looking at five boxes with
 * one circled understands "one in five" before reading anything, and the sentence under it says
 * the same thing in words rather than in notation.
 *
 * **The unflattering number is still the one in the accent.** A figure that made the good case
 * visually louder would do with layout what the copy is forbidden from doing with words.
 */
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A row of identical objects, one of them yours. The whole idea, drawn literally. */
function Row({ n, y, mark, ink }: { n: number; y: number; mark: number; ink: string }) {
  const w = 9;
  const gap = 3;
  const shown = Math.min(n, 18);
  return (
    <g>
      {Array.from({ length: shown }, (_, i) => (
        <rect
          key={i}
          x={i * (w + gap)}
          y={y}
          width={w}
          height={16}
          fill={i === mark ? "none" : INK.g12}
          stroke={i === mark ? ink : INK.g20}
        />
      ))}
      {n > shown && (
        <Tick x={shown * (w + gap) + 4} y={y + 12} fill={INK.g48}>{`+${n - shown} more`}</Tick>
      )}
    </g>
  );
}

export function AnonymitySet() {
  const isolated = MEASURED.coverRate + 1;
  const clustered = Math.round(1 / MEASURED.clusteredMessageIdentified);

  return (
    <Figure
      viewBox="0 0 320 150"
      label={
        `Sent on its own, a message is one of ${isolated} objects that look the same, and is `
        + `identified about ${pct(MEASURED.isolatedMessageIdentified)} of the time. Sent close to `
        + `others it is one of about ${clustered}, and the rate falls to about `
        + `${pct(MEASURED.clusteredMessageIdentified)}.`
      }
      caption={<>Both numbers are published. The site quotes the worse one.</>}
    >
      <Tick x={0} y={10} fill={INK.g64}>ONE MESSAGE, SENT ON ITS OWN</Tick>
      <Row n={isolated} y={18} mark={2} ink={INK.accent} />
      <Tick x={0} y={52} fill={INK.accent}>
        {`yours is 1 of ${isolated} — picked out ${pct(MEASURED.isolatedMessageIdentified)} of the time`}
      </Tick>

      <Tick x={0} y={86} fill={INK.g64}>SEVERAL, SENT CLOSE TOGETHER</Tick>
      <Row n={clustered} y={94} mark={7} ink={INK.g80} />
      <Tick x={0} y={128} fill={INK.g64}>
        {`yours is 1 of about ${clustered} — picked out ${pct(MEASURED.clusteredMessageIdentified)} of the time`}
      </Tick>
    </Figure>
  );
}
