import { Figure, INK, Tick } from "./Figure.tsx";

/**
 * The three verbs, drawn.
 *
 * ⛔ `send` is deniable, `publish` is signed and **still private to one conversation**, and `post`
 * is the public one. `cli.ts:448` records that this exact collision is why the public feature
 * shipped with no client path and nobody noticed — so the figure separates them by geometry, not
 * only by label: the first two stay inside the conversation box and the third leaves it.
 *
 * The drawing carries the distinction the prose beside it makes, which is the only reason a figure
 * earns its place on a slide.
 */
export function Verbs() {
  return (
    <Figure
      /* 160, not 190: at 600px wide the slide stacks the figure under the copy and 30 units of empty
         box below the last label was enough to push the slide over. The drawing ends at y=148. */
      viewBox="0 0 320 132"
      label={
        "Two people share a conversation. Inside it a message is either sent, which carries no "
        + "signature, or published, which carries one and cannot be taken back. Separately, a post "
        + "leaves the conversation and is readable by strangers."
      }
      caption={<>Two verbs stay inside. The third is the one that leaves.</>}
    >
      {/* The conversation: everything inside this box is between two people. */}
      <rect x={4} y={26} width={210} height={104} fill="none" stroke={INK.g32} strokeDasharray="3 3" />
      <Tick x={10} y={40} fill={INK.g48}>ONE CONVERSATION</Tick>

      <rect x={22} y={54} width={64} height={22} fill="none" stroke={INK.g48} />
      <Tick x={54} y={68} anchor="middle" fill={INK.fg}>YOU</Tick>
      <rect x={132} y={54} width={64} height={22} fill="none" stroke={INK.g48} />
      <Tick x={164} y={68} anchor="middle" fill={INK.fg}>THEM</Tick>

      {/* send — deniable, so the arrow carries no mark. */}
      <path d="M86 62 L132 62" stroke={INK.g32} />
      <Tick x={109} y={58} anchor="middle" fill={INK.g64}>send</Tick>
      <Tick x={109} y={86} anchor="middle" fill={INK.g48}>no signature</Tick>
      <Tick x={109} y={97} anchor="middle" fill={INK.g48}>either of you</Tick>

      {/* publish — signed, and the accent marks the one irreversible thing on the drawing. */}
      <path d="M86 112 L132 112" stroke={INK.accent} />
      <Tick x={109} y={108} anchor="middle" fill={INK.accent}>publish</Tick>
      <Tick x={109} y={123} anchor="middle" fill={INK.g48}>signed, permanent</Tick>

      {/* post — the only line that crosses the boundary. */}
      <path d="M214 78 L262 78" stroke={INK.g32} />
      <rect x={240} y={54} width={76} height={48} fill="none" stroke={INK.g48} />
      <Tick x={278} y={72} anchor="middle" fill={INK.fg}>STRANGERS</Tick>
      <Tick x={278} y={88} anchor="middle" fill={INK.g48}>post</Tick>
      <Tick x={278} y={120} anchor="middle" fill={INK.g32}>one at a time</Tick>
    </Figure>
  );
}
