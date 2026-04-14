#!/usr/bin/env node
/**
 * Run `tsc --watch` and re-sync `dist/` to every consumer on each successful
 * rebuild. Keeps the host app in lockstep with source changes without
 * re-running `yarn install` or restarting the Next.js dev server.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const tsc = spawn("yarn", ["dev"], { cwd: ROOT, stdio: ["inherit", "pipe", "inherit"] });

// tsc --watch prints "Found N errors. Watching for file changes." after each
// incremental compile. We use that as the trigger to resync.
const READY_RE = /Found \d+ error/;

let syncing = false;
let queued = false;

async function sync() {
  if (syncing) {
    queued = true;
    return;
  }
  syncing = true;
  await new Promise((done) => {
    const proc = spawn("node", ["scripts/sync-to-consumers.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    proc.on("close", () => done(null));
  });
  syncing = false;
  if (queued) {
    queued = false;
    sync();
  }
}

tsc.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (READY_RE.test(chunk.toString())) {
    sync();
  }
});

tsc.on("close", (code) => process.exit(code ?? 0));

process.on("SIGINT", () => {
  tsc.kill("SIGINT");
});
