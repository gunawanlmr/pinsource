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
/**
 * Whether the client has successfully reached any backend in this session.
 * Lets the UI distinguish "no backend configured / unreachable" from
 * "backend returned no match for this component".
 */
export declare function isBackendConnected(): boolean;
export declare function resolveComponentFile(name: string, override?: string): Promise<string>;
export declare function resolvePageFile(route: string, override?: string): Promise<string>;
//# sourceMappingURL=resolver.d.ts.map