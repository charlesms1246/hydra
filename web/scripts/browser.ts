/**
 * Driving a real browser over CDP, with no dependency in the tree.
 *
 * ⛔ **THIS IS A MOVE, NOT A NEW CAPABILITY.** Every function here was written for and proved by
 * `figure-geometry.ts`; it is extracted because a second rendering gate needs the same four
 * things — find a browser, serve `out/`, launch headless, speak CDP — and a copy of a Chrome
 * launcher is a copy that drifts. The comments come with the code, because each one records a
 * failure that was paid for once.
 *
 * ## ⛔ A RENDERING CHECK MUST NOT SKIP WHEN NO BROWSER IS PRESENT
 *
 * `findChrome` exits non-zero rather than returning nothing. A check that passes quietly on a
 * machine with no Chrome converts *nobody is testing this* into a green tick, which is worse than
 * no check — and the class these gates exist for is precisely the one nobody suspected through
 * green suites. Set `CHROME_PATH` if the search fails.
 *
 * ## No dependencies, deliberately
 *
 * `WebSocket` is a Node global from 22 on, and `out/` is served from `node:http`. The alternative
 * was `playwright-core` as a devDependency of `web/`, which is a real cost on a site whose whole
 * argument is that it ships nothing it did not have to — and a decision for the user rather than
 * for a guard.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { homedir, tmpdir } from "node:os";

/** Every route the site exports. A page missing from this list is a page nobody measures. */
/**
 * Every built route, enumerated from `out/` rather than listed.
 *
 * ⛔ **It was a list of nine, and it was a list the day three pages were added.** The legal pages
 * carry no SVG, so nothing here would have failed — which is the point: the next page that does
 * carry one is added by somebody who has no reason to know this file exists, and the gate would
 * have reported "clean" over a scope that had quietly stopped covering the site.
 *
 * The same reasoning `test/site.test.ts` gives for enumerating `out/`, and the same reasoning
 * behind `entryPoints()` discovering pages for the boundary walk. A hand-kept scope shrinks by
 * default.
 */
export function routes(dir: string, route = "/"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? routes(join(dir, e.name), `${route}${e.name}/`)
      : e.name === "index.html" ? [route] : [],
  );
}

/**
 * Where to look for a browser, in order.
 *
 * ⛔ **The last entry is DERIVED, never a literal path.** It named a specific home directory —
 * `/home/<a person>/.cache/…` — which is this machine's owner's username committed into a public
 * repository by the project whose subject is what leaks when nobody decided to leak it. Building
 * it from `homedir()` costs nothing and has a second, independent benefit: it works on every
 * machine rather than one.
 *
 * The Playwright cache directory is version-numbered (`chromium-1234`), so it is globbed rather
 * than pinned — a bumped Playwright would otherwise silently drop this candidate and the check
 * would fall back to failing loudly, which is correct but avoidable.
 */
function playwrightChrome(): string[] {
  const base = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((d) => d.startsWith("chromium-"))
    .map((d) => join(base, d, "chrome-linux64", "chrome"));
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  ...playwrightChrome(),
].filter((p): p is string => typeof p === "string" && p.length > 0);

export function findChrome(): string {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  console.error("::error::no Chrome binary found — this check measures a rendered page and cannot");
  console.error("run without one. It must not skip: a geometry guard that passes when nothing was");
  console.error("measured reports success for a page nobody looked at.");
  console.error("Looked in:");
  for (const p of CHROME_CANDIDATES) console.error(`  ${p}`);
  console.error("Set CHROME_PATH to a Chrome or Chromium binary.");
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function serve(root: string): Promise<{ origin: string; close: () => void }> {
  const server = createServer((req, res) => {
    // `normalize` then a prefix check: this serves a built directory to a browser we launched, but
    // a path walker is a path walker.
    const url = new URL(req.url ?? "/", "http://x");
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/* ---------------------------------------------------------------------------------------------
 * A minimum CDP client: launch, attach, navigate, evaluate.
 * ------------------------------------------------------------------------------------------ */

export function launch(exe: string): Promise<{ ws: string; kill: () => void }> {
  /*
   * A fresh profile per run, not a fixed path. A killed Chrome leaves `SingletonLock` behind and
   * the next launch aborts with "Failed to create a ProcessSingleton" — which would make this
   * check fail for a reason that has nothing to do with the page, on the second run and every run
   * after it. Two of these can also run at once without fighting.
   */
  const profile = mkdtempSync(join(tmpdir(), "hydra-figure-geometry-"));
  const proc = spawn(exe, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not report a debugging port")), 30_000);
    proc.stderr.on("data", (chunk) => {
      buf += String(chunk);
      const m = /ws:\/\/[^\s]+/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({
          ws: m[0],
          // Wait for the process to be gone before removing its profile: Chrome is still writing
          // to it at the moment it is signalled, and an `ENOTEMPTY` here would fail a run whose
          // measurements had all passed.
          kill: async () => {
            const gone = new Promise((done) => proc.once("exit", done));
            proc.kill();
            await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
            try {
              rmSync(profile, { recursive: true, force: true });
            } catch {
              /* a leftover temp profile is not worth failing a clean run over */
            }
          },
        });
      }
    });
    proc.on("exit", (code) => reject(new Error(`Chrome exited (${code}) before listening:\n${buf}`)));
  });
}

export async function connect(url: string) {
  const socket = new WebSocket(url);
  await new Promise((res, rej) => {
    socket.addEventListener("open", res, { once: true });
    socket.addEventListener("error", () => rej(new Error(`cannot reach ${url}`)), { once: true });
  });
  let id = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  socket.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    const slot = msg.id && pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.rej(new Error(JSON.stringify(msg.error))) : slot.res(msg.result);
  });
  return {
    send(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
      const n = ++id;
      return new Promise((res, rej) => {
        pending.set(n, { res, rej });
        socket.send(JSON.stringify({ id: n, method, params, sessionId }));
      });
    },
    close: () => socket.close(),
  };
}
