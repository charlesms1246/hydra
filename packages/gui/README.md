# hydra-gui

Local surface for the leak report — see what a transaction discloses before signing.

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
cd packages/gui && node src/server.mjs      # http://127.0.0.1:4600
```

No framework, no build step, no dependencies. `HYDRA_GUI_PORT` overrides the port.

## What it shows

- **The disclosure matrix** — parties × fields for each action, computed by `packages/leak`.
  Click any cell for the mechanism and its `file:line` citations.
- **Anonymity sets, notes and problems** — carried through verbatim, including every UNKNOWN.
- **Environment** — `hydra doctor`'s checks, if `packages/cli` is present. The report does not
  need a running stack; this panel is a convenience, and the page works without it.

## Two design decisions

**Colour marks disclosure, not safety.** `CLEAR` is critical red, `DECRYPTABLE` serious orange,
`UNKNOWN` warning yellow — and `NOT_DISCLOSED_BY_THIS_TX` is deliberately **recessive**, an
outline rather than a fill.

The first version painted it green. Rendered, that produced a wall of green with three red rows,
and the honest reading of that image is "mostly private" — the exact overclaim this project
exists to prevent. Ink belongs where a party learns something. The screenshot is why this was
caught: it was not visible in the code.

**Colour never carries meaning alone.** Every cell pairs its colour with an icon and a text
label, the legend is always present, and the whole report is already a table. On the light
surface the warning and serious steps are sub-3:1 by design in the source palette; the icon +
label pairing is the documented mitigation.

## Scope

This is the leak-report surface that `HANDOFF.md` Phase H asks for. It does **not** inspect live
pool state, channels, notes or nullifiers — `IDEA.md` §4 wants that, and it needs a running
stack plus viewing keys to be meaningful. Not built rather than half-built.
