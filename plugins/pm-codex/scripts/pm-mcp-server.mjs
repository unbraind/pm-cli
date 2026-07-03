#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function canRead(target) {
  try { await access(target); return true; } catch { return false; }
}
function isImportUrl(target) {
  if (/^[A-Za-z]:[\\/]/.test(target)) {
    return false;
  }
  try {
    return new URL(target).protocol.length > 0;
  } catch {
    return false;
  }
}
async function repoServerPath() {
  for (let cursor = scriptDir, depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(cursor, "dist", "mcp", "server.js");
    if (await canRead(candidate)) {
      return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
  return null;
}
async function startReadableServer(target) {
  if (!target) {
    return false;
  }
  if (isImportUrl(target)) {
    const server = await import(target);
    server.startMcpServer();
    return true;
  }
  if (!(await canRead(target))) {
    return false;
  }
  const server = await import(pathToFileURL(path.resolve(target)).href);
  server.startMcpServer();
  return true;
}
if (!(await startReadableServer(process.env.PM_CLI_MCP_SERVER)) && !(await startReadableServer(await repoServerPath()))) {
  const child = spawn("npx", ["-y", "--package=@unbrained/pm-cli@latest", "pm-mcp"], { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 1));
}
