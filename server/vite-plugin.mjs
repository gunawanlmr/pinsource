/**
 * Vite plugin for pinsource.
 *
 * Setup:
 *   // vite.config.ts
 *   import { defineConfig } from "vite";
 *   import pinsource from "pinsource/vite-plugin";
 *
 *   export default defineConfig({
 *     plugins: [pinsource()],
 *   });
 *
 * Registers a dev-server middleware at /__pinsource/resolve that exposes
 * the same POST endpoint as the standalone server. Disabled during build.
 *
 * Options:
 *   cwd   — override project root (default: Vite's config.root)
 *   dirs  — array of subdirectories to search
 *   path  — override endpoint path (default: "/__pinsource/resolve")
 */
import { DEFAULT_DIRS, handleResolve } from "./resolver.mjs";

export default function pinsource(options = {}) {
  const endpointPath = options.path || "/__pinsource/resolve";

  return {
    name: "pinsource",
    apply: "serve",
    configureServer(server) {
      const cwd = options.cwd || server.config.root || process.cwd();
      const dirs = options.dirs || DEFAULT_DIRS;

      server.middlewares.use(endpointPath, async (req, res, next) => {
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
          res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
          res.end();
          return;
        }
        if (req.method !== "POST") {
          next();
          return;
        }

        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          let body;
          try {
            body = JSON.parse(raw || "{}");
          } catch {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "invalid json" }));
            return;
          }
          const result = handleResolve(body, { cwd, dirs });
          const status = result?.error ? 400 : 200;
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(JSON.stringify(result ?? {}));
        });
      });
    },
  };
}
