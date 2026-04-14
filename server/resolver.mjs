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

export function resolveComponent({ name, cwd, dirs }) {
  if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return {};
  const dirArgs = dirs.map((d) => JSON.stringify(d)).join(" ");
  const pattern = `[^A-Za-z0-9_$]${name}[^A-Za-z0-9_$]|^${name}[^A-Za-z0-9_$]|[^A-Za-z0-9_$]${name}$`;

  let raw = "";
  try {
    raw = execSync(
      `grep -rnE ${JSON.stringify(pattern)} --include="*.tsx" --include="*.ts" --include="*.jsx" --include="*.js" --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=build ${dirArgs} 2>/dev/null`,
      { cwd, encoding: "utf8", timeout: 4000, maxBuffer: 10 * 1024 * 1024 },
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

export function resolvePage({ route, cwd }) {
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
      execSync(`test -f ${JSON.stringify(c)}`, { cwd });
      return { file: c };
    } catch {
      // next candidate
    }
  }
  if (first) {
    try {
      const result = execSync(
        `find app -name "page.tsx" -path "*/${first}/*" ! -path "*/\\[*" 2>/dev/null | head -1`,
        { cwd, encoding: "utf8", timeout: 3000 },
      ).trim();
      if (result) return { file: result };
    } catch {
      // ignore
    }
  }
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
