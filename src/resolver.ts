const DEFAULT_URL = "http://localhost:9101";

interface ResolveResponse {
  file?: string;
  line?: number;
}

const cache = new Map<string, string>();

function key(type: string, value: string) {
  return `${type}:${value}`;
}

async function post(serverUrl: string, body: Record<string, unknown>): Promise<ResolveResponse> {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return {};
    return (await res.json()) as ResolveResponse;
  } catch {
    return {};
  }
}

export async function resolveComponentFile(
  name: string,
  serverUrl: string = DEFAULT_URL,
): Promise<string> {
  const k = key("component", name);
  if (cache.has(k)) return cache.get(k)!;
  const result = await post(serverUrl, { kind: "component", name });
  const value = result.file && result.line ? `${result.file}:${result.line}` : result.file || "";
  cache.set(k, value);
  return value;
}

export async function resolvePageFile(
  route: string,
  serverUrl: string = DEFAULT_URL,
): Promise<string> {
  const k = key("page", route);
  if (cache.has(k)) return cache.get(k)!;
  const result = await post(serverUrl, { kind: "page", route });
  const value = result.file || "";
  cache.set(k, value);
  return value;
}
