# archive/

Work that is parked, not deleted.

## `gui/` — the disclosure-matrix web UI

A local page rendering `packages/leak`'s report: a parties × fields matrix, each cell
clickable for the mechanism and its `file:line` citations. It worked, and the design note in
its README is worth keeping — the first version coloured "not disclosed" green, which rendered
as a wall of green and read as *"mostly private"*, the exact overclaim the project exists to
prevent.

Archived because hydra's developer surface is the TUI (`packages/tui`), and a second,
disconnected web surface was the thing that made the GUI feel wrong: it was a findings viewer,
not developer tooling.

To bring it back:

```bash
git mv archive/gui packages/gui
cd packages/gui && node src/server.mjs
```

It depends only on `packages/leak`, so it still runs as-is. The disclosure matrix is genuinely
better in a browser than a terminal — wide table, click-through citations — so this is a
"for now" decision, not a verdict.
