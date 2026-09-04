/**
 * Corner letters and registration crosshairs — the reference's `PageFrame`, rewritten in CSS.
 *
 * It is the one component from Gestalt that ports directly: everything else there is an order
 * book, a chart or a trade panel. The letters are the first two and last two of the wordmark,
 * set in the only serif in the chrome, which is what makes them read as a printer's mark rather
 * than as interface.
 *
 * `aria-hidden` on the whole thing: "H Y R A + + + +" read aloud is noise, and none of it
 * carries information that is not elsewhere on the page.
 */
export function PageFrame({ word }: { word: string }) {
  const [tl, tr] = [word.at(0), word.at(1)];
  const [bl, br] = [word.at(-2), word.at(-1)];
  return (
    <div className="frame" aria-hidden>
      <div>
        <span className="tl">{tl}</span>
        <span className="tr">{tr}</span>
        <span className="bl">{bl}</span>
        <span className="br">{br}</span>
        <span className="cross ct">+</span>
        <span className="cross cb">+</span>
        <span className="cross cl">+</span>
        <span className="cross cr">+</span>
      </div>
    </div>
  );
}
