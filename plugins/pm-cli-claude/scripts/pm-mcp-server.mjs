#!/usr/bin/env node
/**
 * pm-cli native MCP server launcher for Claude Code.
 *
 * Resolution order:
 * 1. PM_CLI_MCP_SERVER env var (explicit path)
 * 2. dist/mcp/server.js walking up from this file (repo checkout)
 * 3. npx -y @unbrained/pm-cli@latest pm-mcp (installed via npm)
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function findRepoServer() {
  let cursor = here;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(cursor, "dist", "mcp", "server.js");
    if (await exists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

const explicitServer = process.env.PM_CLI_MCP_SERVER;
if (explicitServer && (await exists(explicitServer))) {
  await import(pathToFileURL(explicitServer).href);
} else {
  const repoServer = await findRepoServer();
  if (repoServer) {
    await import(pathToFileURL(repoServer).href);
  } else {
    const child = spawn("npx", ["-y", "--package=@unbrained/pm-cli@latest", "pm-mcp"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });
  }
}
