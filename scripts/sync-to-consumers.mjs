#!/usr/bin/env node
/**
 * Mirror this package's published files (dist/, server/, package.json, etc.)
 * into any sibling project's `node_modules/pinsource/` directory, so edits
 * show up after a Next.js / Vite hot-reload without running `yarn install`.
 *
 * Consumers: configure via env var PINSOURCE_CONSUMERS (colon-separated
 * absolute paths to project roots). Defaults to the sibling `elfa-ai-app`.
 *
 *   PINSOURCE_CONSUMERS=/abs/path/app1:/abs/path/app2 yarn sync
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const DEFAULT_CONSUMERS = [resolve(ROOT, "..", "elfa-ai-app")];

const consumers = (process.env.PINSOURCE_CONSUMERS || "")
  .split(":")
  .filter(Boolean)
  .map((p) => resolve(p));

const targets = consumers.length > 0 ? consumers : DEFAULT_CONSUMERS;

// Files/directories to mirror. Keep in sync with `files` in package.json.
const INCLUDE = ["dist", "server", "package.json", "README.md", "LICENSE"];

let synced = 0;
let skipped = 0;

for (const consumer of targets) {
  const dest = join(consumer, "node_modules", "pinsource");
  if (!existsSync(consumer)) {
    console.log(`[pinsource:sync] skip (no dir): ${consumer}`);
    skipped++;
    continue;
  }
  if (!existsSync(join(consumer, "node_modules"))) {
    console.log(`[pinsource:sync] skip (no node_modules): ${consumer}`);
    skipped++;
    continue;
  }

  // Clear the target so removed files don't linger.
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  for (const entry of INCLUDE) {
    const src = join(ROOT, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(dest, entry), { recursive: true });
  }

  console.log(`[pinsource:sync] → ${dest}`);
  synced++;
}

if (synced === 0 && skipped > 0) {
  console.log("[pinsource:sync] no consumers synced");
  process.exit(0);
}
