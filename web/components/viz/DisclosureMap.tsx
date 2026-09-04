import { statement } from "../../../hydra-dapp/packages/claims/src/statement.ts";
import { Figure, INK, Tick } from "./Figure.tsx";

/**
 * Every claim the statement produces, one cell each, in its three bands.
 *
 * **The asymmetry is the argument.** Forty things somebody can see, seven partial guarantees with
 * measurements attached, eleven things nobody can. A page can describe that in a sentence and a
 * reader will not feel it; forty cells against eleven is felt before it is read.
 *
 * Generated in full — the cell count, the band sizes, the labels and the totals all come from
 * `statement()`. **Nothing here is a number somebody typed**, which is what makes it safe to put a
 * picture on a page whose whole argument is that its claims are computed. If a disclosure is added
 * upstream, a cell appears here without anybody drawing one.
 */

const COLS = 20;
const CELL = 9;
const GAP = 3;
const BAND_GAP = 26;

export function DisclosureMap() {
  const s = statement();
  const bands = [
    { key: "see", label: "WHAT THEY CAN SEE", claims: s.whoCanSeeWhat, ink: INK.accent },
    { key: "partial", label: "PROTECTED, WITH A NUMBER", claims: s.whatIsPartial, ink: INK.g64 },
    { key: "cannot", label: "WHAT THEY CANNOT SEE", claims: s.whatWeCannotSee, ink: INK.g32 },
  ];

  let y = 18;
  const rendered = bands.map((b) => {
    const rows = Math.ceil(b.claims.length / COLS);
    const top = y;
    y += 12 + rows * (CELL + GAP) + BAND_GAP;
    return { ...b, top, rows };
  });

  const width = COLS * (CELL + GAP) - GAP;

  return (
    <Figure
      viewBox={`0 0 ${width} ${y - BAND_GAP + 4}`}
      /*
       * ⛔ This label is prose a person wrote, and the forbidden-word check reads it — it caught
       * an earlier draft ending "and 11 things nobody can see", which is an unmeasured absolute
       * about unnamed parties. The bands are named after the statement's own sections instead, so
       * the label describes the document rather than asserting a property of the system. A
       * figure's accessible name is copy like any other.
       */
      label={
        `The disclosure statement as one cell per claim, in its three sections: `
        + `${s.whoCanSeeWhat.length} under what they can see, `
        + `${s.whatIsPartial.length} partial guarantees published with their measurement, and `
        + `${s.whatWeCannotSee.length} under what they cannot see.`
      }
      /*
       * The caption has to be true on both pages this figure appears on. An earlier version said
       * "every cell is a line on this page" — true on `/about/disclosure/`, false on the landing
       * page, where the claims deliberately are not. A shared component's copy is copy for every
       * context it is dropped into, and the one that catches this is a person looking, because no
       * check knows where a component will be used.
       */
      caption={
        <>
          {s.whoCanSeeWhat.length + s.whatIsPartial.length + s.whatWeCannotSee.length} claims,
          generated. Every cell is one line of the disclosure statement, carrying the file that
          makes it true.
        </>
      }
    >
      {rendered.map((b) => (
        <g key={b.key}>
          <Tick x={0} y={b.top}>{b.label}</Tick>
          {/* The count is data and has to be legible over the backdrop; the band's colour is
              carried by its cells, which is where it means something. */}
          <Tick x={width} y={b.top} anchor="end" fill={INK.g80}>{String(b.claims.length)}</Tick>
          {b.claims.map((c, i) => (
            <rect
              key={c.from + i}
              x={(i % COLS) * (CELL + GAP)}
              y={b.top + 8 + Math.floor(i / COLS) * (CELL + GAP)}
              width={CELL}
              height={CELL}
              fill={b.ink}
              /* The partial band is drawn hollow: a guarantee with a number attached is not the
                 same object as one without, and the palette has no fourth colour to say so. */
              fillOpacity={b.key === "partial" ? 0 : 1}
              stroke={b.ink}
              strokeWidth={b.key === "partial" ? 1 : 0}
            />
          ))}
        </g>
      ))}
    </Figure>
  );
}
