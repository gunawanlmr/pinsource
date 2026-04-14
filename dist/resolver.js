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
const cache = new Map();
let detectedEndpoint = null;
let detectionInFlight = null;
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
    list.push(STANDALONE_URL);
    return list;
}
/**
 * Fire a probe request at every candidate endpoint; first one to respond 2xx
 * with a JSON body wins. Result is cached for the lifetime of the page.
 */
async function detectEndpoint(override, probeBody) {
    if (detectedEndpoint)
        return detectedEndpoint;
    if (detectionInFlight)
        return detectionInFlight;
    detectionInFlight = (async () => {
        const urls = candidateEndpoints(override);
        const attempts = urls.map(async (url) => {
            const res = await postTo(url, probeBody, 2500);
            if (!res || !res.ok)
                return null;
            try {
                await res.clone().json();
            }
            catch {
                return null;
            }
            return { url, res };
        });
        const results = await Promise.all(attempts);
        const winner = results.find((r) => r !== null);
        if (winner) {
            detectedEndpoint = winner.url;
            return winner.url;
        }
        return null;
    })();
    try {
        return await detectionInFlight;
    }
    finally {
        detectionInFlight = null;
    }
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
    }
    const endpoint = await detectEndpoint(override, body);
    if (!endpoint)
        return {};
    // detectEndpoint already made the probe request that returned the winner,
    // but we don't have its body cached, so make one follow-up request here.
    // The cost is low because the endpoint is now pinned.
    const res = await postTo(endpoint, body, 3000);
    if (!res?.ok)
        return {};
    try {
        return (await res.json());
    }
    catch {
        return {};
    }
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