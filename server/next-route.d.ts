/**
 * Next.js Route Handler for pinsource.
 *
 * App Router usage:
 *   // app/api/__pinsource/route.ts
 *   export { POST, GET, runtime, dynamic } from "pinsource/next-route";
 *
 * Pages Router usage:
 *   // pages/api/__pinsource.ts
 *   export { default } from "pinsource/next-route";
 */

/** Pinned to Node.js — the resolver shells out and cannot run on Edge. */
export const runtime: "nodejs";

/** Disables caching so probes always hit the handler. */
export const dynamic: "force-dynamic";

/** App Router: health check. Returns `{ ok: true }` in dev, 403 in prod. */
export function GET(): Promise<Response>;

/** App Router: resolves a component or page to `{ file, line }`. */
export function POST(request: Request): Promise<Response>;

/** Pages Router compat: default export is a classic `(req, res) => void` handler. */
declare const handler: (
  req: { method?: string; body?: unknown },
  res: {
    status: (code: number) => { json: (data: unknown) => void };
  },
) => Promise<void>;
export default handler;
