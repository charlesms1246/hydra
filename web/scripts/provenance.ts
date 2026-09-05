/**
 * What built this page, read from git at build time.
 *
 * **This is what goes up the right edge of the footer, where the reference puts a copyright.**
 * There is no legal entity to assert one, and a project whose argument is that its claims are
 * checkable has something better to put in that slot: the commit a reader can check the page
 * against. A copyright line claims ownership; this one offers a way to verify.
 *
 * Fails soft. A build from a tarball or an export with no `.git` has no commit, and the edge text
 * is simply absent — a footer ornament is not worth failing a build over, and an absent one is
 * honest in a way a placeholder would not be.
 */

import { execFileSync } from "node:child_process";

export function provenance(): string | null {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return commit ? `BUILT FROM ${commit}` : null;
  } catch {
    return null;
  }
}
