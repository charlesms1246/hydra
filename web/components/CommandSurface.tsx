import { commandLines, TOOLS, type ToolName } from "../scripts/cli-surface.ts";

/**
 * A tool's command list, captured from the tool itself at build time.
 *
 * **`data-generated="cli"` is a claim of provenance and is checked as one.** The disclosure
 * blocks carry `data-generated="statement"` and their text is matched against `statement()`;
 * this carries a different value because it comes from a different source, and
 * `test/site.test.ts` matches it against what the binary actually prints. A marker that decides
 * what gets inspected needs its own guard, or it becomes the way to smuggle copy past the
 * instrument that exists to read it.
 *
 * Marked at all because a demo is a claim in a format the forbidden-word check cannot read:
 * every string a terminal shows is copy on this site. Generating it removes the staleness
 * problem for this half — the page says what the binary says today, or the build fails.
 */
export function CommandSurface({ tool }: { tool: ToolName }) {
  return (
    <pre className="terminal" data-generated="cli" data-tool={tool}>
      <code>
        <span className="terminal-prompt">
          $ {tool}
          {TOOLS[tool].args.length ? ` ${TOOLS[tool].args.join(" ")}` : ""}
        </span>
        {"\n"}
        {commandLines(tool).join("\n")}
      </code>
    </pre>
  );
}
