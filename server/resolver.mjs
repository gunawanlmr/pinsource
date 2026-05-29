/**
 * Shared resolver core. Used by:
 *   - server/index.mjs             (standalone HTTP server, CLI bin)
 *   - server/next-plugin.mjs       (Next.js dev middleware / API route)
 *   - server/vite-plugin.mjs       (Vite dev server middleware)
 *
 * Given a component name or a route path, returns { file, line } — relative
 * to `cwd` and pointing at the actual definition, not a re-export or import.
 *
 * All grep/find invocations are sandboxed to the configured `cwd` and search
 * dirs. Nothing leaves the machine.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// Directories that never contain authored source — pruned from every search.
const EXCLUDED_DIRS = [
  "node_modules", ".next", "dist", "build", "out", "coverage",
  ".turbo", ".cache", ".git", ".vercel", "storybook-static",
];

// Detect ripgrep once. It is 10-50x faster than grep on large trees because it
// respects .gitignore, parallelizes, and skips binary files automatically.
let _rgPath; // undefined = not probed, null = unavailable, string = path
function ripgrepPath() {
  if (_rgPath !== undefined) return _rgPath;
  try {
    _rgPath = execSync("command -v rg", { encoding: "utf8" }).trim() || null;
  } catch {
    _rgPath = null;
  }
  return _rgPath;
}

// Result cache: component name -> { file, line }. Resolution is deterministic
// for a given tree state, so we memoize and invalidate by TTL. Dev edits that
// move a definition are rare relative to pin clicks; a short TTL keeps it fresh
// without re-grepping on every click.
const CACHE_TTL_MS = 5000;
const _cache = new Map(); // key -> { value, at }

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    _cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  _cache.set(key, { value, at: Date.now() });
}

function runSearch({ pattern, dirs, cwd }) {
  const dirArgs = dirs.map((d) => JSON.stringify(d)).join(" ");
  const rg = ripgrepPath();
  if (rg) {
    const globs = ["*.tsx", "*.jsx", "*.ts", "*.js"].map((g) => `-g ${JSON.stringify(g)}`).join(" ");
    const excludes = EXCLUDED_DIRS.map((d) => `-g ${JSON.stringify(`!${d}/`)}`).join(" ");
    return execSync(
      `${JSON.stringify(rg)} --no-heading --line-number --color never ${globs} ${excludes} -e ${JSON.stringify(pattern)} ${dirArgs} 2>/dev/null`,
      { cwd, encoding: "utf8", timeout: 4000, maxBuffer: 10 * 1024 * 1024 },
    ).trim();
  }
  const includes = ['--include="*.tsx"', '--include="*.jsx"', '--include="*.ts"', '--include="*.js"'].join(" ");
  const excludeDirs = EXCLUDED_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");
  return execSync(
    `grep -rnE ${JSON.stringify(pattern)} ${includes} ${excludeDirs} ${dirArgs} 2>/dev/null`,
    { cwd, encoding: "utf8", timeout: 4000, maxBuffer: 10 * 1024 * 1024 },
  ).trim();
}

export function resolveComponent({ name, cwd, dirs }) {
  if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return {};

  const cacheKey = `component:${name}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const pattern = `[^A-Za-z0-9_$]${name}[^A-Za-z0-9_$]|^${name}[^A-Za-z0-9_$]|[^A-Za-z0-9_$]${name}$`;

  let raw = "";
  try {
    raw = runSearch({ pattern, dirs, cwd });
  } catch {
    return {};
  }
  if (!raw) {
    cacheSet(cacheKey, {});
    return {};
  }

  const candidates = [];
  for (const hit of raw.split("\n")) {
    const m = hit.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStr, rawCode] = m;
    const line = parseInt(lineStr, 10);
    const code = rawCode.trim();
    if (!code || code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;

    let score = 0;
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

    if (/^import\b/.test(code)) score -= 20;
    if (/^export\s*\{.*\bfrom\b/.test(code)) score -= 15;
    if (new RegExp(`^export\\s*\\{[^}]*\\b${name}\\b`).test(code)) score -= 8;
    if (/\bfrom\s+['"]/.test(code)) score -= 5;

    // React components live in .tsx/.jsx far more often than .ts/.js.
    if (file.endsWith(".tsx") || file.endsWith(".jsx")) score += 2;

    // A file literally named after the component is the canonical home.
    const parts = file.split("/");
    if (parts.some((p) => p === `${name}.tsx` || p === `${name}.ts` || p === `${name}.jsx` || p === `${name}.js`)) {
      score += 4;
    }
    // index.tsx inside a directory named after the component (Button/index.tsx).
    const baseName = parts[parts.length - 1];
    if (/^index\.[tj]sx?$/.test(baseName) && parts[parts.length - 2] === name) score += 4;

    // Prefer the conventional React source locations.
    if (/(^|\/)(components|ui|features|widgets|elements|blocks)\//.test(file)) score += 2;

    // PascalCase name in a PascalCase-or-component path is a strong component signal.
    if (/^[A-Z]/.test(name)) score += 1;

    // Deprioritize non-source variants.
    if (file.includes("/__tests__/") || /\.(test|spec)\.[tj]sx?$/.test(file)) score -= 6;
    if (file.includes("/stories/") || /\.stories\.[tj]sx?$/.test(file)) score -= 4;
    if (/\.d\.ts$/.test(file)) score -= 8;
    if (file.includes("/node_modules/")) score -= 20;
    if (/\/(\.next|dist|build|out|coverage|\.turbo)\//.test(file)) score -= 20;

    if (score > 0) candidates.push({ file, line, code, score });
  }

  if (candidates.length === 0) {
    cacheSet(cacheKey, {});
    return {};
  }
  candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  const best = candidates[0];
  const result = { file: best.file, line: best.line };
  cacheSet(cacheKey, result);
  return result;
}

export function resolvePage({ route, cwd }) {
  if (!route) return {};

  const cacheKey = `page:${route}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

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
    if (existsSync(resolvePath(cwd, c))) {
      const result = { file: c };
      cacheSet(cacheKey, result);
      return result;
    }
  }
  if (first) {
    try {
      const found = execSync(
        `find app -name "page.tsx" -path "*/${first}/*" ! -path "*/\\[*" 2>/dev/null | head -1`,
        { cwd, encoding: "utf8", timeout: 3000 },
      ).trim();
      if (found) {
        const result = { file: found };
        cacheSet(cacheKey, result);
        return result;
      }
    } catch {
      // ignore
    }
  }
  cacheSet(cacheKey, {});
  return {};
}

/**
 * Generic handler: takes a parsed JSON request body and returns a
 * serializable response. Shared between the HTTP server, Next middleware,
 * and Vite middleware.
 */
export function handleResolve(body, { cwd, dirs }) {
  if (!body || typeof body !== "object") return { error: "invalid body" };
  if (body.kind === "component") return resolveComponent({ name: body.name, cwd, dirs });
  if (body.kind === "page") return resolvePage({ route: body.route, cwd });
  return { error: "unknown kind" };
}

export const DEFAULT_DIRS = ["app", "components", "handlers", "lib", "src", "pages"];
