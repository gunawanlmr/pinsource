#!/usr/bin/env node
/**
 * pinsource HTTP resolver server.
 *
 * Listens on localhost:9101 (override with PINSOURCE_PORT).
 * Exposes POST /resolve:
 *   { kind: "component", name: string } -> { file, line }
 *   { kind: "page", route: string }     -> { file }
 *
 * Most users won't need to run this directly — the Next and Vite plugins
 * expose the same endpoint through their own dev servers. This standalone
 * binary exists for frameworks without a plugin (CRA, plain Webpack, etc.).
 */
import { createServer } from "node:http";

import { DEFAULT_DIRS, handleResolve } from "./resolver.mjs";

const PORT = parseInt(process.env.PINSOURCE_PORT || process.env.CLAUDE_UI_DEVTOOLS_PORT || "9101", 10);
const CWD = process.env.PINSOURCE_CWD || process.env.CLAUDE_UI_DEVTOOLS_CWD || process.cwd();
const SEARCH_DIRS = (process.env.PINSOURCE_DIRS || process.env.CLAUDE_UI_DEVTOOLS_DIRS || DEFAULT_DIRS.join(" "))
  .split(/\s+/)
  .filter(Boolean);

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { ok: true, cwd: CWD, dirs: SEARCH_DIRS });
    return;
  }
  if (req.method !== "POST" || req.url !== "/resolve") {
    json(res, 404, { error: "not found" });
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const result = handleResolve(parsed, { cwd: CWD, dirs: SEARCH_DIRS });
    const status = result?.error ? 400 : 200;
    json(res, status, result ?? {});
  });
}

// How many ports to try past the configured one before giving up. The client
// probes the same small range, so a bumped server is still discoverable.
const MAX_PORT_TRIES = 3;

// Is the process already on `port` one of our own resolvers? If so we just
// reuse it rather than crashing or claiming another port. `/health` returns
// `{ ok, cwd, dirs }` — the `dirs` array fingerprints our server specifically,
// so a foreign squatter (e.g. Dart DevTools) won't be mistaken for pinsource.
async function probePinsource(port) {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data && data.ok === true && Array.isArray(data.dirs);
  } catch {
    return false;
  }
}

function start(port, triesLeft) {
  const server = createServer(handler);

  server.once("error", async (err) => {
    if (err && err.code === "EADDRINUSE") {
      if (await probePinsource(port)) {
        console.log(`[pinsource] resolver already running on http://localhost:${port} — reusing it`);
        process.exit(0);
      }
      if (triesLeft > 0) {
        const next = port + 1;
        console.warn(`[pinsource] port ${port} is in use by another process — trying ${next}`);
        start(next, triesLeft - 1);
        return;
      }
      console.warn(
        `[pinsource] ports ${PORT}-${port} are all in use; standalone resolver not started.\n` +
          `[pinsource] Your Next.js route (/api/__pinsource) or Vite plugin will still resolve sources.\n` +
          `[pinsource] Free the port or set PINSOURCE_PORT=<port> to override.`,
      );
      process.exit(0); // graceful — don't take the wrapped dev process down
      return;
    }
    console.error(`[pinsource] resolver error: ${err?.message || err}`);
    process.exit(1);
  });

  server.listen(port, "localhost", () => {
    console.log(`[pinsource] resolver listening on http://localhost:${port} (cwd: ${CWD})`);
  });
}

start(PORT, MAX_PORT_TRIES);
