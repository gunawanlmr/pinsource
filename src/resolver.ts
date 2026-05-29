/**
 * Browser-side adapter that talks to the resolver backend. The backend can be:
 *
 *  1. The Next.js route handler (set up via `pinsource/next-route`)    → POST /api/__pinsource
 *  2. The Vite dev-server middleware (set up via `pinsource/vite-plugin`) → POST /__pinsource/resolve
 *  3. The standalone HTTP server (`npx pinsource-server`)              → POST http://localhost:9101/resolve
 *
 * The first request fans out to the most likely endpoints in parallel and
 * memoizes the one that responds successfully. Subsequent requests hit only
 * that endpoint, so normal operation is a single network round-trip.
 */

const PLUGIN_PATHS = [
  "/__pinsource/resolve", // Vite plugin, and custom rewrites
  "/api/__pinsource", // Next.js App Router route handler
];
const STANDALONE_URL = "http://localhost:9101/resolve";

interface ResolveResponse {
  file?: string;
  line?: number;
}

const cache = new Map<string, string>();
let detectedEndpoint: string | null = null;
let detectionInFlight: Promise<{ url: string; data: ResolveResponse } | null> | null = null;

function key(type: string, value: string) {
  return `${type}:${value}`;
}

async function postTo(url: string, body: Record<string, unknown>, timeoutMs: number): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res;
  } catch {
    return null;
  }
}

function candidateEndpoints(override?: string): string[] {
  if (override) return [override.endsWith("/resolve") ? override : `${override.replace(/\/$/, "")}/resolve`];
  const list: string[] = [];
  if (typeof window !== "undefined") {
    for (const p of PLUGIN_PATHS) list.push(new URL(p, window.location.origin).toString());
  }
  list.push(STANDALONE_URL);
  return list;
}

/**
 * Fire the real lookup request at every candidate endpoint in parallel.
 * First endpoint to respond 2xx wins, its result is returned, and the
 * endpoint is memoized so subsequent calls are a single round-trip.
 *
 * This fuses detection and the first lookup — no wasted follow-up request.
 */
async function raceEndpoints(
  body: Record<string, unknown>,
  override: string | undefined,
): Promise<{ url: string; data: ResolveResponse } | null> {
  const urls = candidateEndpoints(override);
  return new Promise((resolve) => {
    let pending = urls.length;
    let settled = false;
    const settle = (value: { url: string; data: ResolveResponse } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    for (const url of urls) {
      postTo(url, body, 2500).then(async (res) => {
        if (!settled && res?.ok) {
          try {
            const data = (await res.json()) as ResolveResponse;
            settle({ url, data });
            return;
          } catch {
            // fall through to pending decrement
          }
        }
        pending -= 1;
        if (pending === 0) settle(null);
      }).catch(() => {
        pending -= 1;
        if (pending === 0) settle(null);
      });
    }
  });
}

async function request(body: Record<string, unknown>, override?: string): Promise<ResolveResponse> {
  // If we already know which endpoint works, go straight there.
  if (!override && detectedEndpoint) {
    const res = await postTo(detectedEndpoint, body, 3000);
    if (res?.ok) {
      try {
        return (await res.json()) as ResolveResponse;
      } catch {
        return {};
      }
    }
    // Endpoint stopped responding — clear and re-probe next call.
    detectedEndpoint = null;
  }

  // First lookup (or re-probe after a prior failure). Race all endpoints,
  // dedupe concurrent callers through `detectionInFlight`. The race already
  // performed a real lookup, so the winner carries the resolved data — the
  // caller that triggered detection reuses it directly instead of issuing a
  // second request to the now-known endpoint.
  const iTriggered = !detectionInFlight;
  if (!detectionInFlight) {
    detectionInFlight = (async () => {
      const winner = await raceEndpoints(body, override);
      if (winner) detectedEndpoint = winner.url;
      return winner;
    })();
  }

  try {
    const winner = await detectionInFlight;
    if (!winner) return {};
    // The caller whose request seeded the race gets the race's own result —
    // no extra round-trip. Concurrent callers (their body may differ) issue a
    // single request against the now-pinned endpoint.
    if (iTriggered) return winner.data;
    const res = await postTo(winner.url, body, 3000);
    if (!res?.ok) return {};
    try {
      return (await res.json()) as ResolveResponse;
    } catch {
      return {};
    }
  } finally {
    if (iTriggered) detectionInFlight = null;
  }
}

/**
 * Whether the client has successfully reached any backend in this session.
 * Lets the UI distinguish "no backend configured / unreachable" from
 * "backend returned no match for this component".
 */
export function isBackendConnected(): boolean {
  return detectedEndpoint !== null;
}

export async function resolveComponentFile(name: string, override?: string): Promise<string> {
  const k = key("component", name);
  if (cache.has(k)) return cache.get(k)!;
  const result = await request({ kind: "component", name }, override);
  const value = result.file && result.line ? `${result.file}:${result.line}` : result.file || "";
  cache.set(k, value);
  return value;
}

export async function resolvePageFile(route: string, override?: string): Promise<string> {
  const k = key("page", route);
  if (cache.has(k)) return cache.get(k)!;
  const result = await request({ kind: "page", route }, override);
  const value = result.file || "";
  cache.set(k, value);
  return value;
}
