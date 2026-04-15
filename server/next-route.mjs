/**
 * Next.js Route Handler for pinsource.
 *
 * Setup (App Router):
 *
 *   // app/api/__pinsource/route.ts
 *   export { POST, runtime, dynamic } from "pinsource/next-route";
 *
 * That's the whole integration. Dev-only guard prevents the route from
 * running in production builds.
 *
 * The handler accepts the same POST body shape as the standalone server:
 *   { kind: "component", name } | { kind: "page", route }
 *
 * Environment overrides:
 *   PINSOURCE_CWD  — directory to grep (default: process.cwd())
 *   PINSOURCE_DIRS — space-separated subdirectories (default: app components handlers lib src pages)
 */
import { DEFAULT_DIRS, handleResolve } from "./resolver.mjs";

// Pin to Node.js runtime — the resolver shells out via `child_process`, which
// isn't available on the Edge runtime. Some Next configurations default route
// handlers to Edge; re-exporting this from the user's route.ts forces Node.
export const runtime = "nodejs";
// Disable caching so probes and repeated lookups always hit the handler.
export const dynamic = "force-dynamic";

function cwd() {
  return process.env.PINSOURCE_CWD || process.cwd();
}

function dirs() {
  const raw = process.env.PINSOURCE_DIRS;
  if (raw) return raw.split(/\s+/).filter(Boolean);
  return DEFAULT_DIRS;
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

// Health check — lets users verify the route is mounted by hitting it in a
// browser tab, and lets the client-side resolver quickly probe availability.
export async function GET() {
  if (isProduction()) {
    return new Response(JSON.stringify({ ok: false, reason: "production" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({ ok: true, service: "pinsource", runtime: "nodejs" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export async function POST(request) {
  if (isProduction()) {
    return new Response(JSON.stringify({ error: "pinsource disabled in production" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const result = handleResolve(body, { cwd: cwd(), dirs: dirs() });
  const status = result?.error ? 400 : 200;
  return new Response(JSON.stringify(result ?? {}), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Pages Router compat: `export default` style API handler.
// Users can do: `export { default } from "pinsource/next-route";`
export default async function handler(req, res) {
  if (isProduction()) {
    res.status(403).json({ error: "pinsource disabled in production" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
  const result = handleResolve(body, { cwd: cwd(), dirs: dirs() });
  const status = result?.error ? 400 : 200;
  res.status(status).json(result ?? {});
}
