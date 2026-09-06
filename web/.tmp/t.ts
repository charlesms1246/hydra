import { reachableFrom } from "../scripts/module-graph.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
mkdirSync("/tmp/g", { recursive: true });
writeFileSync("/tmp/g/a.ts", 'import type { X } from "./b.ts";\nexport const q = 1;\n');
writeFileSync("/tmp/g/b.ts", 'export type X = number;\n');
console.log("type-only import followed?", [...reachableFrom(["/tmp/g/a.ts"])].length === 2);
rmSync("/tmp/g", { recursive: true });
