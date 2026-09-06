import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
const ROOT = "/home/xavio/projects/hydra";
const specs = (s: string) => {
  const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const out: string[] = [];
  for (const re of [/\bimport\s+[^;'"]*?\bfrom\s*["']([^"']+)["']/g, /\bexport\s+[^;'"]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g])
    for (const m of code.matchAll(re)) out.push(m[1]);
  return out;
};
const res = (f: string, sp: string) => {
  if (!sp.startsWith(".")) return null;
  const b = resolve(dirname(f), sp);
  for (const c of [b, `${b}.ts`, `${b}.tsx`, `${b}/index.ts`]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
};
const start = `${ROOT}/hydra-dapp/packages/tui/src/app.ts`;
const prev = new Map<string, string>([[start, ""]]);
const q = [start];
const hits: string[] = [];
while (q.length) {
  const f = q.shift()!;
  for (const sp of specs(readFileSync(f, "utf8"))) {
    const t = res(f, sp);
    if (!t || prev.has(t)) continue;
    prev.set(t, f); q.push(t);
    if (/packages\/(identity|vault-client)\//.test(t)) hits.push(t);
  }
}
for (const h of hits) {
  const chain = []; let c: string | undefined = h;
  while (c) { chain.unshift(relative(ROOT, c).replace("hydra-dapp/packages/", "")); c = prev.get(c) || undefined; }
  console.log(chain.join("\n  -> ") + "\n");
}
