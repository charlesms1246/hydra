#!/usr/bin/env node
/**
 * hydra-gui — local surface for the leak report.
 *
 * Serves one static page and a small JSON API. No framework, no build step, no
 * network egress: standing rule 2 says nothing in the default path may need the
 * network, and this page is the demo surface for a tool whose whole claim is that
 * it does not phone home.
 */

import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { whatDoesThisLeak } from "../../leak/src/leak.mjs";
import { PARTIES, FIELDS, ACTION_TYPES, DISCOVERY_KINDS, PROVING_KINDS } from "../../leak/src/facts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, "..", "public");
const EXAMPLES = join(here, "..", "..", "leak", "examples");
const PORT = Number(process.env.HYDRA_GUI_PORT ?? 4600);

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** doctor is optional here: the report is useful without a running stack. */
async function environment() {
  try {
    const { check } = await import("../../cli/src/doctor.mjs");
    return { available: true, rows: check() };
  } catch (e) {
    return { available: false, reason: String(e.message) };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(join(PUBLIC, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/api/schema") {
      return json(res, 200, {
        parties: PARTIES,
        fields: FIELDS,
        actionTypes: ACTION_TYPES,
        discoveryKinds: DISCOVERY_KINDS,
        provingKinds: PROVING_KINDS,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/examples") {
      const files = (await readdir(EXAMPLES)).filter((f) => f.endsWith(".json"));
      const out = {};
      for (const f of files) out[f.replace(/\.json$/, "")] = JSON.parse(await readFile(join(EXAMPLES, f), "utf8"));
      return json(res, 200, out);
    }

    if (req.method === "GET" && url.pathname === "/api/env") {
      return json(res, 200, await environment());
    }

    if (req.method === "POST" && url.pathname === "/api/leak") {
      const tx = await readBody(req);
      return json(res, 200, whatDoesThisLeak(tx));
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: String(e.message) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  hydra-gui  http://127.0.0.1:${PORT}\n`);
  console.log("  Local only. Nothing is sent anywhere; the report is computed in this process.\n");
});
