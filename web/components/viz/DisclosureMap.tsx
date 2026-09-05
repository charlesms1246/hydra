import { statement } from "../../../hydra-dapp/packages/claims/src/statement.ts";
import { Figure, INK, Tick } from "./Figure.tsx";

/**
 * The three sections of the disclosure statement, as three proportional bars.
 *
 * ⛔ **It was a grid of fifty-eight identical squares and nobody could read it.** The asymmetry
 * was there — forty cells against eleven — but a reader has to count squares to find it, and a
 * square carries no information about what it stands for. A row with a number, a plain label and a
 * bar the length of that number is the same fact in a form somebody takes in without being taught
 * the notation.
 *
 * The rule this is an instance of: **a diagram that needs its own key is a diagram that has not
 * finished being designed.** The old one was arranged by the data rather than for the reader.
 *
 * Generated in full — the cell count, the band sizes, the labels and the totals all come from
 * `statement()`. **Nothing here is a number somebody typed**, which is what makes it safe to put a
 * picture on a page whose whole argument is that its claims are computed. If a disclosure is added
 * upstream, a cell appears here without anybody drawing one.
 */

const BAR_W = 300;
const ROW = 34;
const TOP = 14;

export function DisclosureMap() {
  const s = statement();
  const bands = [
    { label: "they can see", claims: s.whoCanSeeWhat, ink: INK.accent },
    { label: "protected, with a measurement", claims: s.whatIsPartial, ink: INK.g64 },
    { label: "they cannot see", claims: s.whatWeCannotSee, ink: INK.g32 },
  ];
  const max = Math.max(...bands.map((b) => b.claims.length));
  const total = bands.reduce((n, b) => n + b.claims.length, 0);
  const height = TOP + bands.length * ROW + 22;

  return (
    <Figure
      viewBox={`0 0 ${BAR_W + 56} ${height}`}
      label={
        `The disclosure statement as three sections: `
        + `${s.whoCanSeeWhat.length} under what they can see, `
        + `${s.whatIsPartial.length} partial guarantees published with their measurement, and `
        + `${s.whatWeCannotSee.length} under what they cannot see.`
      }
      caption={<>{total} lines, generated, on one page.</>}
    >
      {bands.map((b, i) => {
        const y = TOP + i * ROW;
        const w = (b.claims.length / max) * BAR_W;
        return (
          <g key={b.label}>
            {/* The count first and largest — it is the thing being compared. */}
            <text x={0} y={y + 13} fill={b.ink} className="fig-count">
              {b.claims.length}
            </text>
            <Tick x={40} y={y + 11} fill={INK.g64}>{b.label}</Tick>
            <rect x={40} y={y + 17} width={w} height={7} fill={b.ink} />
            {/* The full extent, so a short bar reads as short rather than as small. */}
            <rect x={40} y={y + 17} width={BAR_W} height={7} fill="none" stroke={INK.g12} />
          </g>
        );
      })}
    </Figure>
  );
}
