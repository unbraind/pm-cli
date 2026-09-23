#!/usr/bin/env node
/**
 * Cached-plugin MCP launcher, copied verbatim into Claude and Codex plugins.
 * The server runs from an exact-version package, never from an npm tag.
 */
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePluginRuntime } from "./plugin-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Return an explicit local server path or this plugin's matching checkout build. */
async function localServer() {
  const override = process.env.PM_CLI_MCP_SERVER;
  if (override) {
    const target = override.startsWith("file:") ? fileURLToPath(override) : path.resolve(override);
    await access(target);
    return target;
  }
  const repoRoot = path.resolve(here, "..", "..", "..");
  const pluginRoot = path.resolve(here, "..");
  const candidate = path.join(repoRoot, "dist", "mcp", "server.js");
  try {
    const [repo, plugin] = await Promise.all([
      readFile(path.join(repoRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(path.join(pluginRoot, "package.json"), "utf8").then(JSON.parse),
    ]);
    if (repo.name !== "@unbrained/pm-cli" || repo.version !== plugin.version ||
        plugin.dependencies?.[repo.name] !== repo.version) return null;
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

const server = (await localServer()) ?? (await resolvePluginRuntime()).server;
const child = spawn(process.execPath, [server], { stdio: "inherit", env: process.env });
child.on("error", (error) => {
  console.error(`pm-mcp plugin runtime failed: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
