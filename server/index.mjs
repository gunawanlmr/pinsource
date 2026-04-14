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

const server = createServer((req, res) => {
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
});

server.listen(PORT, "localhost", () => {
  console.log(`[pinsource] resolver listening on http://localhost:${PORT} (cwd: ${CWD})`);
});
