/**
 * Every test double must have the same shape as the module it replaces.
 *
 * `sandbox/fake/stack.mjs` declared `startStack(onLine)` while the real
 * `core/src/stack.mjs` declares `startStack(onLine, env)`. `app.mjs:711` restarts the stack
 * with a new account count by calling `bringUp({ HYDRA_ACCOUNTS: String(c.count) })`, so in
 * the sandbox that env was DISCARDED SILENTLY — and the fake world has no account count for
 * anything to check, so the flow reported success there no matter what it was given.
 *
 * Adding the parameter would close that instance and leave the cause: nothing compared the
 * double to the original. So this compares them, and it reads the pairs out of the loader's
 * own `FAKES` table rather than a list kept here, because a list kept here is the next thing
 * to drift.
 *
 * Parameter NAMES, not `Function.length` — which counts only parameters before the first
 * default, and is 0 for both `(onLine = () => {})` and `(onLine = () => {}, env = {})`. An
 * arity check would have passed on the very defect that prompted this file.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = join(HERE, "..", "..");
const SANDBOX = join(PKGS, "tui", "sandbox");

let failed = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    if (detail?.skip) return console.log(`SKIP  ${name}  — ${detail.skip}`);
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (e) {
    console.log(`FAIL  ${name}  — ${e.message}`);
    failed++;
  }
};

/** The parameter names of a function, from its source. Depth-aware, so defaults survive. */
function params(fn) {
  const src = String(fn);
  const open = src.indexOf("(");
  if (open === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const inner = src.slice(open + 1, end);
  const out = [];
  let depth2 = 0;
  let cur = "";
  for (const c of inner) {
    if ("([{".includes(c)) depth2++;
    if (")]}".includes(c)) depth2--;
    if (c === "," && depth2 === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out
    .map((p) => p.split("=")[0].trim().replace(/^\.\.\./, ""))
    .filter(Boolean);
}

/** Compare a double against the module it stands in for, in both directions. */
async function compare(realPath, fakePath, label) {
  const real = await import(pathToFileURL(realPath).href);
  const fake = await import(pathToFileURL(fakePath).href);

  const missing = Object.keys(real).filter((k) => !(k in fake));
  if (missing.length) throw new Error(`${label}: the double does not export ${missing.join(", ")}`);

  const drifted = [];
  for (const [k, v] of Object.entries(real)) {
    if (typeof v !== "function" || typeof fake[k] !== "function") continue;
    const a = params(v);
    const b = params(fake[k]);
    if (a.join(",") !== b.join(",")) drifted.push(`${k}(${b.join(", ")}) should be ${k}(${a.join(", ")})`);
  }
  if (drifted.length) throw new Error(`${label}: ${drifted.join("; ")}`);
  return Object.keys(real).length;
}

// The pairs come from the loader's own table. Parsed rather than repeated, and the parse is
// asserted non-empty — a regex that silently matched nothing would make every check below
// vacuous, which is the failure mode a guard like this has.
const loaderSrc = readFileSync(join(SANDBOX, "loader.mjs"), "utf8");
const pairs = [...loaderSrc.matchAll(/\["(packages\/[^"]+\.mjs)",\s*"([^"]+)"\]/g)]
  .map((m) => [join(PKGS, "..", m[1]), join(SANDBOX, "fake", m[2])]);

await check("the loader's fake table is readable", () => {
  if (pairs.length < 3) throw new Error(`parsed ${pairs.length} pairs from loader.mjs — expected the three it redirects`);
  for (const [realPath, fakePath] of pairs) {
    if (!existsSync(realPath)) throw new Error(`no such module: ${realPath}`);
    if (!existsSync(fakePath)) throw new Error(`no such fake: ${fakePath}`);
  }
  return `${pairs.length} pairs, all present`;
});

for (const [realPath, fakePath] of pairs) {
  const name = realPath.split("/").slice(-3).join("/");
  await check(`the sandbox fake matches ${name}`, async () => {
    const n = await compare(realPath, fakePath, name);
    return `${n} exports, same names and same parameters`;
  });
}

// The MCP lifetime probe swaps in its own stack double. Same rule; withheld from clones.
await check("the MCP stack stub matches core/src/stack.mjs", async () => {
  const stub = join(PKGS, "mcp", "test", "fixtures", "stack-stub.mjs");
  if (!existsSync(stub)) return { skip: "packages/mcp is not present here — withheld from this clone" };
  const n = await compare(join(PKGS, "core", "src", "stack.mjs"), stub, "stack-stub");
  return `${n} exports, same names and same parameters`;
});

console.log(failed ? `\n${failed} failed` : "\nall doubles match the modules they replace");
process.exit(failed ? 1 : 0);
