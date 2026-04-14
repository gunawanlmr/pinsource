const DEFAULT_URL = "http://localhost:9101";
const cache = new Map();
function key(type, value) {
    return `${type}:${value}`;
}
async function post(serverUrl, body) {
    try {
        const res = await fetch(`${serverUrl.replace(/\/$/, "")}/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok)
            return {};
        return (await res.json());
    }
    catch {
        return {};
    }
}
export async function resolveComponentFile(name, serverUrl = DEFAULT_URL) {
    const k = key("component", name);
    if (cache.has(k))
        return cache.get(k);
    const result = await post(serverUrl, { kind: "component", name });
    const value = result.file && result.line ? `${result.file}:${result.line}` : result.file || "";
    cache.set(k, value);
    return value;
}
export async function resolvePageFile(route, serverUrl = DEFAULT_URL) {
    const k = key("page", route);
    if (cache.has(k))
        return cache.get(k);
    const result = await post(serverUrl, { kind: "page", route });
    const value = result.file || "";
    cache.set(k, value);
    return value;
}
//# sourceMappingURL=resolver.js.map