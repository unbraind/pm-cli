#!/usr/bin/env node
// Measures the agent-facing token surface of the pm CLI (baseline chore pm-a22j):
// root help, every per-command help, the contracts payload family, and the MCP
// tools/list payload. Emits a JSON report on stdout so jq can slice it, e.g.:
//   node scripts/measure-agent-token-surface.mjs | jq '.per_command_total'
//   ... | jq '[.commands[] | select(.name | startswith("list"))] | map(.bytes) | add'
// Re-run after each consolidation slice lands and diff against the recorded baseline.

import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PM_BIN = process.env.PM_BIN ?? "pm";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SERVER = join(REPO_ROOT, "dist", "mcp", "server.js");

function tokens(bytes) {
  return Math.round(bytes / 4);
}

function measure(args) {
  try {
    const out = execFileSync(PM_BIN, [...args, "--no-pager"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return Buffer.byteLength(out);
  } catch (error) {
    const out = typeof error.stdout === "string" ? error.stdout : "";
    if (out.length > 0) return Buffer.byteLength(out);
    throw new Error(`pm ${args.join(" ")} failed: ${error.message}`, {
      cause: error,
    });
  }
}

function listCommands() {
  const help = execFileSync(PM_BIN, ["--help", "--no-pager"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const lines = help.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = /^ {2}(\S+)/.exec(line);
    if (!match) continue;
    const name = match[1].split("|")[0];
    if (name !== "help") names.push(name);
  }
  return { rootHelpBytes: Buffer.byteLength(help), names };
}

function measureMcpToolsList() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SERVER], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP tools/list timed out after 30s"));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id !== 1) continue;
        clearTimeout(timer);
        child.kill();
        resolve({
          bytes: Buffer.byteLength(line),
          tokens: tokens(Buffer.byteLength(line)),
          tool_count: parsed.result?.tools?.length ?? 0,
        });
        return;
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    );
  });
}

const pmVersion = execFileSync(PM_BIN, ["--version"], { encoding: "utf8" }).trim();
const { rootHelpBytes, names } = listCommands();

const commands = names
  .map((name) => {
    const bytes = measure([name, "--help"]);
    return { name, bytes, tokens: tokens(bytes) };
  })
  .sort((a, b) => b.bytes - a.bytes);
const perCommandBytes = commands.reduce((sum, entry) => sum + entry.bytes, 0);

const contracts = {};
for (const [key, args] of Object.entries({
  summary_toon: ["contracts", "--summary"],
  summary_json: ["contracts", "--summary", "--json"],
  json: ["contracts", "--json"],
  full: ["contracts", "--full"],
})) {
  const bytes = measure(args);
  contracts[key] = { bytes, tokens: tokens(bytes) };
}

const report = {
  generated_at: new Date().toISOString(),
  pm_version: pmVersion,
  root_help: { bytes: rootHelpBytes, tokens: tokens(rootHelpBytes) },
  command_count: commands.length,
  per_command_total: { bytes: perCommandBytes, tokens: tokens(perCommandBytes) },
  full_help_surface: {
    bytes: rootHelpBytes + perCommandBytes,
    tokens: tokens(rootHelpBytes + perCommandBytes),
  },
  commands,
  contracts,
  mcp_tools_list: await measureMcpToolsList(),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
