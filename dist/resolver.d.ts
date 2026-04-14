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
export declare function resolveComponentFile(name: string, override?: string): Promise<string>;
export declare function resolvePageFile(route: string, override?: string): Promise<string>;
//# sourceMappingURL=resolver.d.ts.map