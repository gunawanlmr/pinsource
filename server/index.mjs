#!/usr/bin/env node
/**
 * pinsource HTTP resolver server.
 *
 * Listens on localhost:9101 (override with PINSOURCE_PORT).
 * Exposes POST /resolve:
 *   { kind: "component", name: string } -> { file, line }
 *   { kind: "page", route: string }     -> { file }
 *
 * All grep/find runs happen in process.cwd() (or PINSOURCE_CWD).
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";

const PORT = parseInt(process.env.PINSOURCE_PORT || process.env.CLAUDE_UI_DEVTOOLS_PORT || "9101", 10);
const CWD = process.env.PINSOURCE_CWD || process.env.CLAUDE_UI_DEVTOOLS_CWD || process.cwd();
const SEARCH_DIRS = (process.env.PINSOURCE_DIRS || process.env.CLAUDE_UI_DEVTOOLS_DIRS || "app components handlers lib src")
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

function resolveComponent(name) {
  if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return {};
  const patterns = [
    `function ${name}(`,
    `function ${name}<`,
    `const ${name} =`,
    `const ${name}:`,
    `const ${name}=`,
    `export default ${name}`,
    `export function ${name}`,
    `export const ${name}`,
  ];
  const dirs = SEARCH_DIRS.map((d) => `"${d}"`).join(" ");
  for (const pattern of patterns) {
    try {
      const raw = execSync(
        `grep -rnF ${JSON.stringify(pattern)} --include="*.tsx" --include="*.ts" --include="*.jsx" --include="*.js" ${dirs} 2>/dev/null`,
        { cwd: CWD, encoding: "utf8", timeout: 3000 },
      ).trim();
      if (!raw) continue;
      const lines = raw.split("\n").filter((l) => {
        const code = l.replace(/^[^:]+:\d+:/, "").trim();
        return !code.startsWith("import ") && !code.startsWith("//") && !code.startsWith("*");
      });
      if (lines.length === 0) continue;
      const m = lines[0].match(/^([^:]+):(\d+):/);
      if (m) return { file: m[1], line: parseInt(m[2], 10) };
    } catch {
      // next pattern
    }
  }
  return {};
}

function resolvePage(route) {
  if (!route) return {};
  const segments = route.split("/").filter(Boolean);
  const fullPath = segments.join("/");
  const first = segments[0] || "";
  const candidates = [
    `app/${fullPath}/page.tsx`,
    `app/${first}/page.tsx`,
    `app/${first}/layout.tsx`,
    `app/(root)/${fullPath}/page.tsx`,
    `app/(root)/${first}/page.tsx`,
    `app/(root)/${first}/layout.tsx`,
    `app/(root)/(home)/page.tsx`,
    `pages/${fullPath}.tsx`,
    `pages/${first}.tsx`,
    `pages/index.tsx`,
    `src/pages/${fullPath}.tsx`,
    `src/pages/${first}.tsx`,
  ];
  for (const c of candidates) {
    try {
      execSync(`test -f ${JSON.stringify(c)}`, { cwd: CWD });
      return { file: c };
    } catch {
      // next
    }
  }
  if (first) {
    try {
      const result = execSync(
        `find app -name "page.tsx" -path "*/${first}/*" ! -path "*/\\[*" 2>/dev/null | head -1`,
        { cwd: CWD, encoding: "utf8", timeout: 3000 },
      ).trim();
      if (result) return { file: result };
    } catch {
      // ignore
    }
  }
  return {};
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
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { json(res, 400, { error: "invalid json" }); return; }
    if (parsed.kind === "component") json(res, 200, resolveComponent(parsed.name));
    else if (parsed.kind === "page") json(res, 200, resolvePage(parsed.route));
    else json(res, 400, { error: "unknown kind" });
  });
});

server.listen(PORT, "localhost", () => {
  console.log(`[pinsource] resolver listening on http://localhost:${PORT} (cwd: ${CWD})`);
});
