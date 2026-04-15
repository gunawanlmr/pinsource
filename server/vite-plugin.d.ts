/**
 * Vite plugin for pinsource — registers a dev-server middleware at
 * `/__pinsource/resolve` (or a custom `path`) that resolves component names
 * and route paths to file:line.
 *
 * Usage:
 *   // vite.config.ts
 *   import { defineConfig } from "vite";
 *   import pinsource from "pinsource/vite-plugin";
 *
 *   export default defineConfig({
 *     plugins: [pinsource()],
 *   });
 */

export interface PinsourceViteOptions {
  /** Project root to grep. Defaults to Vite's `config.root`. */
  cwd?: string;
  /** Subdirectories to search. Defaults to `["app","components","handlers","lib","src","pages"]`. */
  dirs?: string[];
  /** Endpoint path. Defaults to `/__pinsource/resolve`. */
  path?: string;
}

/** Minimal Vite plugin shape — avoids a hard dependency on `vite` types. */
export interface PinsourcePlugin {
  name: string;
  apply: "serve";
  configureServer(server: unknown): void;
}

export default function pinsource(options?: PinsourceViteOptions): PinsourcePlugin;
