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

/**
 * Resolve a component name to a file:line. Instead of stopping at the first
 * grep hit, we collect ALL candidate definitions across the repo and score
 * each one. The goal is to pick the actual definition over re-exports,
 * imports, type-only declarations, and barrel files.
 *
 * Score rules (higher = more likely the real definition):
 *   +10 `export default function Name`
 *   +10 `export function Name(`
 *   +9  `export const Name = (...) =>`   (likely arrow component)
 *   +8  `const Name = React.memo(` / forwardRef(` / styled(`
 *   +8  `export const Name = memo(` / forwardRef(`
 *   +6  `function Name(` / `function Name<`
 *   +5  `const Name =` / `const Name:`
 *   +4  `class Name extends`
 *   +3  Name.displayName = "Name"
 *   +2  ends with `.tsx` / `.jsx`  (JSX-capable file)
 *   +1  file path contains the component name (conventional filename)
 *   -20 line is inside an `import` / re-export from a string source
 *   -10 line starts with `export { Name`  (barrel re-export)
 *   -10 file path contains `node_modules`
 *   -5  file path contains `/__tests__/` or ends `.test.` or `.spec.`
 *   -3  file path contains `/stories/` or ends `.stories.`
 */
function resolveComponent(name) {
  if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return {};

  const dirs = SEARCH_DIRS.map((d) => JSON.stringify(d)).join(" ");
  // Use a word-boundary regex so we don't match substrings (e.g. `Button` matching `IconButton`).
  // BSD grep (macOS) supports -E for extended regex.
  const pattern = `[^A-Za-z0-9_$]${name}[^A-Za-z0-9_$]|^${name}[^A-Za-z0-9_$]|[^A-Za-z0-9_$]${name}$`;

  let raw = "";
  try {
    raw = execSync(
      `grep -rnE ${JSON.stringify(pattern)} --include="*.tsx" --include="*.ts" --include="*.jsx" --include="*.js" --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=build ${dirs} 2>/dev/null`,
      { cwd: CWD, encoding: "utf8", timeout: 4000, maxBuffer: 10 * 1024 * 1024 },
    ).trim();
  } catch {
    return {};
  }
  if (!raw) return {};

  const candidates = [];
  for (const hit of raw.split("\n")) {
    const m = hit.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStr, rawCode] = m;
    const line = parseInt(lineStr, 10);
    const code = rawCode.trim();

    // Quick filters: comments, empty lines.
    if (!code || code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;

    let score = 0;

    // Definition patterns.
    const defPatterns = [
      { re: new RegExp(`^export\\s+default\\s+function\\s+${name}\\b`), w: 10 },
      { re: new RegExp(`^export\\s+function\\s+${name}\\b`), w: 10 },
      { re: new RegExp(`^export\\s+const\\s+${name}\\s*[:=]`), w: 9 },
      { re: new RegExp(`^const\\s+${name}\\s*=\\s*(?:React\\.)?memo\\b`), w: 8 },
      { re: new RegExp(`^const\\s+${name}\\s*=\\s*(?:React\\.)?forwardRef\\b`), w: 8 },
      { re: new RegExp(`^const\\s+${name}\\s*=\\s*styled\\b`), w: 8 },
      { re: new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*(?:React\\.)?memo\\b`), w: 8 },
      { re: new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*(?:React\\.)?forwardRef\\b`), w: 8 },
      { re: new RegExp(`^function\\s+${name}\\b`), w: 6 },
      { re: new RegExp(`^const\\s+${name}\\s*[:=]`), w: 5 },
      { re: new RegExp(`^class\\s+${name}\\s+extends\\b`), w: 4 },
      { re: new RegExp(`^${name}\\.displayName\\s*=`), w: 3 },
      { re: new RegExp(`^export\\s+default\\s+${name}\\b`), w: 2 },
    ];
    for (const { re, w } of defPatterns) {
      if (re.test(code)) {
        score += w;
        break;
      }
    }

    // Heavy penalties for imports / barrel re-exports.
    if (/^import\b/.test(code)) score -= 20;
    if (/^export\s*\{.*\bfrom\b/.test(code)) score -= 15;
    if (new RegExp(`^export\\s*\\{[^}]*\\b${name}\\b`).test(code)) score -= 8;
    if (/\bfrom\s+['"]/.test(code)) score -= 5;

    // Path-based nudges.
    if (file.endsWith(".tsx") || file.endsWith(".jsx")) score += 2;
    if (file.split("/").some((part) => part === `${name}.tsx` || part === `${name}.ts` || part === `${name}.jsx` || part === `${name}.js`)) {
      score += 3;
    }
    if (file.includes("/__tests__/") || /\.(test|spec)\.[tj]sx?$/.test(file)) score -= 5;
    if (file.includes("/stories/") || /\.stories\.[tj]sx?$/.test(file)) score -= 3;
    if (file.includes("/node_modules/")) score -= 10;
    if (file.includes("/.next/")) score -= 10;

    if (score > 0) candidates.push({ file, line, code, score });
  }

  if (candidates.length === 0) return {};
  candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  const best = candidates[0];
  return { file: best.file, line: best.line };
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
