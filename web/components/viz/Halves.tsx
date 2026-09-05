import { Figure, INK, Tick } from "./Figure.tsx";

/**
 * Content against pattern: the easy half beside the hard one.
 *
 * The prose says encryption is solved and what survives it is the pattern. A figure can carry that
 * in one glance — a small sealed box next to a much larger open one — where the paragraph needs
 * four sentences. **The areas are the argument**: the pattern block is deliberately several times
 * the size of the content block, because the claim is about proportion.
 */
export function Halves() {
  return (
    <Figure
      viewBox="0 0 320 150"
      label={
        "The contents of a message are sealed and are the smaller problem. What survives encryption "
        + "— who contacted whom, when, how often — is larger and is what an adversary works from."
      }
      caption={<>The sealed half is the small one.</>}
    >
      <rect x={4} y={30} width={92} height={62} fill="none" stroke={INK.g48} />
      <Tick x={50} y={58} anchor="middle" fill={INK.fg}>CONTENT</Tick>
      <Tick x={50} y={72} anchor="middle" fill={INK.g48}>sealed</Tick>
      <Tick x={4} y={108} fill={INK.g32}>solved</Tick>

      <rect x={124} y={12} width={192} height={98} fill="none" stroke={INK.accent} />
      <Tick x={220} y={44} anchor="middle" fill={INK.accent}>THE PATTERN</Tick>
      <Tick x={220} y={62} anchor="middle" fill={INK.g64}>who, when, how often</Tick>
      <Tick x={220} y={76} anchor="middle" fill={INK.g64}>and from where</Tick>
      <Tick x={124} y={126} fill={INK.g32}>what a chain keeps, permanently</Tick>
    </Figure>
  );
}
