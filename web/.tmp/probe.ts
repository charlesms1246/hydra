import { reachableFrom, FORBIDDEN } from "../scripts/module-graph.ts";
import { relative } from "node:path";
const ROOT = "/home/xavio/projects/hydra";
const P = `${ROOT}/hydra-dapp/packages/tui/src`;
for (const name of ["view.ts", "screen.ts", "app.ts"]) {
  const all = [...reachableFrom([`${P}/${name}`])].map((f) => relative(ROOT, f)).sort();
  const bad = all.filter((f) => FORBIDDEN.some((p) => f.includes(p)));
  console.log(`\n### ${name}: ${all.length} reachable, ${bad.length} FORBIDDEN`);
  console.log(bad.map(b => "  !! " + b).join("\n"));
}
