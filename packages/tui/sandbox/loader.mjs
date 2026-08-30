/**
 * Redirects the three modules that spawn processes to their sandbox fakes.
 *
 * Only those three. Everything else — probe.mjs, services.mjs, wallets.mjs, chain.mjs,
 * transact.mjs — runs for real against the fake server, and the whole of packages/leak
 * runs untouched. That last part is deliberate: a sandbox that faked the disclosure
 * matrix would be showing invented privacy claims, and "generated, never asserted" is the
 * one rule this project does not bend, least of all in a tool for looking at that screen.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKES = [
  ["packages/core/src/stack.mjs", "stack.mjs"],
  ["packages/core/src/install.mjs", "install.mjs"],
  ["packages/cli/src/doctor.mjs", "doctor.mjs"],
];

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  // The fakes re-export the pure halves of the modules they stand in for; redirecting
  // their own imports would point them back at themselves.
  if (context.parentURL?.includes("/sandbox/fake/")) return resolved;
  for (const [suffix, fake] of FAKES) {
    if (resolved.url.endsWith(suffix)) {
      return { ...resolved, url: pathToFileURL(join(HERE, "fake", fake)).href, shortCircuit: true };
    }
  }
  return resolved;
}
