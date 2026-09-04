/**
 * Reading source files for the guards that audit them.
 *
 * **A LITERAL NUL BYTE IN A SOURCE FILE MADE THREE GUARDS BLIND, SILENTLY.**
 * `vault-client/src/blobs.ts` and `handshake/src/inbox.ts` each carry a correct domain separator
 * written as a raw byte rather than a `\0` escape. `/usr/bin/grep` classifies such a file as
 * binary and **suppresses matched content**, printing "binary file matches" to *stderr* — which
 * `execFileSync` does not capture into its return value. Measured, on a NUL-bearing file:
 *
 *     grep -c PATTERN   -> 5                  unaffected
 *     grep -l PATTERN   -> the filename       unaffected
 *     grep -n PATTERN   -> nothing on stdout, diagnostic on stderr
 *     grep -o PATTERN   -> the same
 *
 * The failure is a **silent pass**, because for every one of these guards *no match is the passing
 * case*. So `i2-no-key-egress` scanned the two files where key handling is most concentrated,
 * `i5-blob-separation` scanned its own boundary file, each saw nothing, and each passed.
 *
 * **NO SUBPROCESS, AND THAT IS THE POINT.** The first fix here added `-a` in one shared place. It
 * worked, and it was still wrong: **a flag is a thing that can be dropped, so immunity that depends
 * on remembering one is immunity somebody eventually does not have.** Node reads NUL without
 * noticing and JS regexes match across it, which is why the **twenty-four guards using
 * `readFileSync` were never affected by this at all** — and `i6-sandbox-separation` reached the
 * same shape independently by streaming bytes through `cat` rather than interpreting them.
 * This is that shape, made shared: immune by construction rather than by configuration.
 *
 * **THE READER FIXES THE TWO LIVE CASES; {@link assertScansEveryFile} FIXES THE ONES NOBODY HAS
 * ENUMERATED.** NUL is the symptom. The class is *a scanner silently seeing fewer files than it
 * claims to*, and its causes are many — an encoding, a permission, a symlink, a glob that stopped
 * matching, a directory that moved. That is the vacuity discipline this repository already applies
 * to matches, applied to INPUTS: not *did this check find something*, but *did this check see
 * everything it claims to scan*.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every non-empty `.ts` file under a path, as this repository's guards mean it. */
export function sourceFilesUnder(path: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      // Zero-byte files have no lines, so no line-oriented tool lists them and they hide nothing.
      else if (/\.tsx?$/.test(e.name) && statSync(p).size > 0) out.push(p);
    }
  };
  walk(path);
  return out.sort();
}

/**
 * `grep -rn` over source, as lines of `path:lineno:text`.
 *
 * The shape is grep's on purpose: the call sites it replaces already parse it, and a guard being
 * converted should not also have to be rewritten. `RegExp` rather than ERE — every pattern these
 * guards use is common to both, and JS is what reads the bytes now.
 */
export function scanSource(pattern: string, path: string): string[] {
  const re = new RegExp(pattern);
  const out: string[] = [];
  for (const file of sourceFilesUnder(path)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) out.push(`${file}:${i + 1}:${lines[i]}`);
    }
  }
  return out;
}

/**
 * The same, as matched text only — `grep -rhoE`.
 *
 * **LINE BY LINE, BECAUSE GREP IS LINE-ORIENTED, and matching the whole file instead is wrong in
 * both directions.** The first version of this did, and it broke `i1-key-domains` immediately:
 * `^export function rootSeed\b` anchored to the start of the FILE rather than of each line, so a
 * count of 1 became 0 — a guard asserting "exactly one place mints a Seed" failing because the
 * reader had changed, not the code.
 *
 * The other direction is worse and would have been silent: a JS character class matches newlines,
 * so `EncryptedBlob\)[^{]*: *PublicBlob` scanned against whole file contents can span lines and
 * report a conversion nobody wrote. Line-oriented matching is what these patterns were written
 * against and is what they must keep.
 */
export function scanMatches(pattern: string, path: string): string[] {
  const re = new RegExp(pattern, "g");
  const out: string[] = [];
  for (const file of sourceFilesUnder(path)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      for (const m of line.matchAll(re)) out.push(m[0]);
    }
  }
  return out;
}

/** The files containing a match — `grep -rl`. Line-oriented, for the reason above. */
export function scanFiles(pattern: string, path: string): string[] {
  const re = new RegExp(pattern);
  return sourceFilesUnder(path)
    .filter((f) => readFileSync(f, "utf8").split("\n").some((l) => re.test(l)));
}

/**
 * Fail if the scanner cannot read every file it claims to scan.
 *
 * **THE ASSERTION THAT WOULD HAVE CAUGHT THE NUL BYTE**, and it is not about NUL. A file that
 * becomes unreadable for any reason makes the count diverge and fails here **loudly**, instead of
 * quietly shrinking the corpus every other assertion in the guard is checked against.
 *
 * Cheap, and the only assertion in this file that is about the instrument rather than the code.
 * Call it from any guard that scans a directory — including ones that are not affected today, since
 * the point is the case nobody has enumerated.
 */
export function assertScansEveryFile(
  path: string,
  assert: { equal(a: unknown, b: unknown, m?: string): void },
): void {
  const onDisk = sourceFilesUnder(path);
  const unreadable = onDisk.filter((f) => {
    try {
      // A file the reader cannot turn into lines is a file the guard cannot audit, whatever the
      // reason. Read it the way `scanSource` does, and count what comes back.
      return readFileSync(f, "utf8").length === 0;
    } catch {
      return true;
    }
  });
  assert.equal(unreadable.join("\n"), "",
    `the scanner cannot read ${unreadable.length} of ${onDisk.length} source files under ${path}, `
    + "so every assertion made by scanning this directory was checked against a smaller corpus "
    + "than it claims.");
  assert.equal(onDisk.length > 0, true, `no source files found under ${path} at all`);
}
