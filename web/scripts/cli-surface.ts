/**
 * The command surface, captured by running the real CLI at build time.
 *
 * **A demo is a claim in a format the guards cannot read.** Every string a terminal recording
 * shows is copy on this site, and none of it is text the forbidden-word check can scan. A
 * recording of a warning the product no longer prints is exactly as wrong as a stale claim, and
 * it is wearing a costume the instruments cannot see through.
 *
 * For the command list there is a way out of that entirely: `hydra` with no arguments needs no
 * chain, no state and no network, so the build can just ask it. What ends up on the page is what
 * the binary said at build time, and it cannot go stale for the same reason the disclosure
 * claims cannot.
 *
 * That works because of somebody else's fix. `usage()` used to print `lines.slice(3, 30)` — a
 * hardcoded range — so adding a command pushed the last ones past the cut and the help silently
 * stopped listing them; `post`, `fetch`, `audit` and `lookup` were all missing from the only
 * place a user learns what exists. It now derives the end from the comment's own terminator. If
 * it still used a magic number this capture would faithfully reproduce an incomplete list.
 *
 * ⚠ **THIS IS A SUBPROCESS, AND `scripts/module-graph.ts` CANNOT SEE IT.** The graph walker
 * follows imports; a process boundary is invisible to it. Nothing executes in the browser and
 * only stdout reaches the page, so there is no I6 exposure here — but the blind spot is real and
 * belongs written down rather than discovered. The alternative was re-implementing the header
 * extraction in `web/`, which is a second copy of logic that can drift from the first, and this
 * repository has paid for that three times.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/*
 * Paths are resolved from `process.cwd()`, which is `web/` for both `next build` and
 * `node --test`. NOT from `import.meta.dirname`: webpack leaves that undefined in the bundle it
 * builds for the server render, so it fails at page-collection time with a `paths[0]` type error
 * rather than anywhere near this file.
 */

/**
 * The two tools, and how to make each one describe itself.
 *
 * `hydra` is the platform client — `bin: hydra`, `private: true`, nothing published, so it runs
 * by path. `hydra-dev` is the devtool, publishable and unpublished, a different tool for a
 * different audience.
 *
 * They are asked differently on purpose. `hydra` prints usage when invoked bare. `hydra-dev`
 * bare prints LIVE STACK STATUS — whether a devnet is up on this machine — which is not a
 * command surface and would put one developer's local state on a public page, so it is asked
 * for `help` explicitly.
 */
export const TOOLS = {
  hydra: {
    dir: resolve(process.cwd(), "../hydra-dapp/packages/cli"),
    entry: "src/cli.ts",
    args: [] as string[],
    /** Two lines that must survive, or the capture is not the thing this page claims it is. */
    expect: ["hydra send", "hydra publish"],
  },
  "hydra-dev": {
    dir: resolve(process.cwd(), "../devtool"),
    entry: "packages/cli/src/cli.mjs",
    args: ["help"],
    expect: ["hydra-dev up", "hydra-dev leak"],
  },
} as const;

export type ToolName = keyof typeof TOOLS;

/**
 * Run the CLI with no arguments and return what it printed.
 *
 * It exits non-zero — usage is an error, correctly, since a bare invocation did not ask for
 * anything — and prints to stderr. Both are expected, so neither is treated as a failure; what
 * would be a failure is empty output, and that throws.
 */
export function commandSurface(tool: ToolName): string {
  const t = TOOLS[tool];
  let out = "";
  try {
    out = execFileSync(process.execPath, [t.entry, ...t.args], {
      cwd: t.dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (e) {
    // `hydra`'s `usage()` calls `process.exit(2)` — usage is an error, correctly, since a bare
    // invocation asked for nothing — so the normal path for that tool lands here.
    const err = e as { stdout?: string; stderr?: string };
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }

  const text = out.replace(/\s+$/, "");
  for (const marker of t.expect) {
    if (!text.includes(marker)) {
      throw new Error(
        `${tool} printed something this page cannot recognise as its command list — "${marker}" `
        + "is missing. Refusing to publish a demo of a command surface that may not be the real "
        + `one. Run \`node ${t.entry} ${t.args.join(" ")}\` in ${t.dir} and see what changed.`,
      );
    }
  }
  return text;
}

/**
 * The command lines only, without the file's own explanatory prose.
 *
 * `usage()` prints the whole header comment, which opens with several paragraphs about why the
 * CLI exists alongside the TUI. That is written for somebody reading the source, not for somebody
 * deciding whether to try this, so the page takes the indented command block and the headings
 * that organise it.
 */
export function commandLines(tool: ToolName): string[] {
  if (tool === "hydra-dev") {
    // `hydra-dev help` is already only its command surface — no source-file prose to drop.
    return commandSurface(tool).split("\n");
  }
  return commandSurface(tool)
    .split("\n")
    .filter((l) => /^\s{2,}/.test(l) || /^\s*$/.test(l))
    .join("\n")
    .replace(/^\n+|\n+$/g, "")
    .split("\n");
}
