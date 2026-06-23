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
// The standalone resolver binds 9101 by default, but bumps to the next free
// port when something else already holds it (a Flutter/Dart DevTools instance
// is a common squatter). Probe the small range so a bumped server is found.
const STANDALONE_PORTS = [9101, 9102, 9103];
const standaloneUrls = () => STANDALONE_PORTS.map((p) => `http://localhost:${p}/resolve`);
const cache = new Map();
// Persist the winning endpoint for the tab session so a page reload skips the
// multi-endpoint detection race and goes straight to one request. Self-heals:
// if the remembered endpoint stops responding, it's cleared and re-probed.
const ENDPOINT_STORAGE_KEY = "pinsource:endpoint";
function loadEndpoint() {
    try {
        return typeof window !== "undefined" ? window.sessionStorage.getItem(ENDPOINT_STORAGE_KEY) : null;
    }
    catch {
        return null;
    }
}
function rememberEndpoint(url) {
    try {
        if (typeof window === "undefined")
            return;
        if (url)
            window.sessionStorage.setItem(ENDPOINT_STORAGE_KEY, url);
        else
            window.sessionStorage.removeItem(ENDPOINT_STORAGE_KEY);
    }
    catch {
        /* sessionStorage unavailable (SSR, privacy mode) — fall back to in-memory */
    }
}
let detectedEndpoint = loadEndpoint();
let detectionInFlight = null;
// Circuit breaker. A single picker click resolves many components in a row;
// once a full detection pass finds no reachable backend, short-circuit further
// lookups for a cooldown instead of re-racing every candidate each time —
// otherwise the network tab floods with hundreds of failing 404s. Re-probe
// after the cooldown so a backend that comes online is picked up automatically.
const BACKEND_COOLDOWN_MS = 10000;
let noBackendUntil = 0;
function key(type, value) {
    return `${type}:${value}`;
}
async function postTo(url, body, timeoutMs) {
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        return res;
    }
    catch {
        return null;
    }
}
function candidateEndpoints(override) {
    if (override)
        return [override.endsWith("/resolve") ? override : `${override.replace(/\/$/, "")}/resolve`];
    const list = [];
    if (typeof window !== "undefined") {
        for (const p of PLUGIN_PATHS)
            list.push(new URL(p, window.location.origin).toString());
    }
    list.push(...standaloneUrls());
    return list;
}
/**
 * Fire the real lookup request at every candidate endpoint in parallel.
 * First endpoint to respond 2xx wins, its result is returned, and the
 * endpoint is memoized so subsequent calls are a single round-trip.
 *
 * This fuses detection and the first lookup — no wasted follow-up request.
 */
async function raceEndpoints(body, override) {
    const urls = candidateEndpoints(override);
    return new Promise((resolve) => {
        let pending = urls.length;
        let settled = false;
        const settle = (value) => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };
        for (const url of urls) {
            postTo(url, body, 2500).then(async (res) => {
                if (!settled && res?.ok) {
                    try {
                        const data = (await res.json());
                        settle({ url, data });
                        return;
                    }
                    catch {
                        // fall through to pending decrement
                    }
                }
                pending -= 1;
                if (pending === 0)
                    settle(null);
            }).catch(() => {
                pending -= 1;
                if (pending === 0)
                    settle(null);
            });
        }
    });
}
async function request(body, override) {
    // If we already know which endpoint works, go straight there.
    if (!override && detectedEndpoint) {
        const res = await postTo(detectedEndpoint, body, 3000);
        if (res?.ok) {
            try {
                return (await res.json());
            }
            catch {
                return {};
            }
        }
        // Endpoint stopped responding — clear and re-probe next call.
        detectedEndpoint = null;
        rememberEndpoint(null);
    }
    // No known endpoint and a recent detection pass came up empty — stay quiet
    // until the cooldown elapses. This is what stops a deep picker selection from
    // re-racing every candidate (and flooding 404s) for each component in the
    // chain. `noBackendUntil` is always 0 while an endpoint is known, so a
    // freshly-cleared endpoint above still re-probes immediately.
    if (Date.now() < noBackendUntil)
        return {};
    // First lookup (or re-probe after a prior failure). Race all endpoints,
    // dedupe concurrent callers through `detectionInFlight`. The race already
    // performed a real lookup, so the winner carries the resolved data — the
    // caller that triggered detection reuses it directly instead of issuing a
    // second request to the now-known endpoint.
    const iTriggered = !detectionInFlight;
    if (!detectionInFlight) {
        detectionInFlight = (async () => {
            const winner = await raceEndpoints(body, override);
            if (winner) {
                detectedEndpoint = winner.url;
                rememberEndpoint(winner.url);
                noBackendUntil = 0; // backend reachable — clear any cooldown
            }
            else {
                noBackendUntil = Date.now() + BACKEND_COOLDOWN_MS; // open the breaker
            }
            return winner;
        })();
    }
    try {
        const winner = await detectionInFlight;
        if (!winner)
            return {};
        // The caller whose request seeded the race gets the race's own result —
        // no extra round-trip. Concurrent callers (their body may differ) issue a
        // single request against the now-pinned endpoint.
        if (iTriggered)
            return winner.data;
        const res = await postTo(winner.url, body, 3000);
        if (!res?.ok)
            return {};
        try {
            return (await res.json());
        }
        catch {
            return {};
        }
    }
    finally {
        if (iTriggered)
            detectionInFlight = null;
    }
}
/**
 * Whether the client has successfully reached any backend in this session.
 * Lets the UI distinguish "no backend configured / unreachable" from
 * "backend returned no match for this component".
 */
export function isBackendConnected() {
    return detectedEndpoint !== null;
}
export async function resolveComponentFile(name, override) {
    const k = key("component", name);
    if (cache.has(k))
        return cache.get(k);
    const result = await request({ kind: "component", name }, override);
    const value = result.file && result.line ? `${result.file}:${result.line}` : result.file || "";
    cache.set(k, value);
    return value;
}
export async function resolvePageFile(route, override) {
    const k = key("page", route);
    if (cache.has(k))
        return cache.get(k);
    const result = await request({ kind: "page", route }, override);
    const value = result.file || "";
    cache.set(k, value);
    return value;
}
//# sourceMappingURL=resolver.js.map