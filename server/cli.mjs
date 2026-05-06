#!/usr/bin/env node
/**
 * pinsource CLI.
 *
 *   pinsource              Run the resolver server (default — same as old `pinsource-server`)
 *   pinsource dev <cmd>    Run <cmd> alongside the resolver, propagating signals
 *   pinsource init         Patch package.json's dev script to wrap with `pinsource dev`
 *   pinsource serve        Alias for the bare command
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === "serve") {
  await import("./index.mjs");
} else if (cmd === "dev") {
  await runDev(args.slice(1));
} else if (cmd === "init") {
  await runInit();
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  printHelp();
} else {
  console.error(`[pinsource] unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`pinsource — pin any UI element to its source file

Usage:
  pinsource                Run the resolver server on localhost:9101
  pinsource dev <cmd...>   Run <cmd> alongside the resolver (kills both on exit)
  pinsource init           Patch package.json so \`npm run dev\` wraps the resolver

Examples:
  pinsource dev next dev
  pinsource dev vite
  pinsource init
`);
}

async function runDev(rest) {
  if (rest.length === 0) {
    console.error("[pinsource] usage: pinsource dev <command> [args...]");
    process.exit(1);
  }

  const serverPath = fileURLToPath(new URL("./index.mjs", import.meta.url));
  const server = spawn(process.execPath, [serverPath], {
    stdio: "inherit",
    env: process.env,
  });

  const child = spawn(rest[0], rest.slice(1), {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const proc of [child, server]) {
      if (!proc.killed) {
        try { proc.kill(signal || "SIGTERM"); } catch { /* ignore */ }
      }
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => shutdown("SIGTERM"));

  child.on("exit", (code, signal) => {
    shutdown(signal);
    process.exit(code ?? 0);
  });

  server.on("exit", (code) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      console.error(`[pinsource] resolver exited with code ${code}`);
    }
  });
}

async function runInit() {
  const pkgPath = resolve(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) {
    console.error("[pinsource] no package.json in current directory");
    process.exit(1);
  }

  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  pkg.scripts = pkg.scripts || {};

  const original = pkg.scripts.dev;
  if (!original) {
    console.error("[pinsource] no `dev` script found in package.json — add one first");
    process.exit(1);
  }
  if (original.includes("pinsource dev")) {
    console.log("[pinsource] dev script already wraps pinsource — nothing to do");
  } else {
    pkg.scripts.dev = `pinsource dev ${original}`;
    const indent = raw.match(/^(\s+)"/m)?.[1] || "  ";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + "\n");
    console.log(`[pinsource] patched dev script:`);
    console.log(`  before: ${original}`);
    console.log(`  after:  ${pkg.scripts.dev}`);
  }

  console.log(`
Next: mount the loader in your root layout / entry file:

  import PinsourceLoader from "pinsource/loader";

  <>
    <App />
    <PinsourceLoader />
  </>

Then run \`npm run dev\`.`);
}
