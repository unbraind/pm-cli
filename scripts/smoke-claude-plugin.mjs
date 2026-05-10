#!/usr/bin/env node
/**
 * Smoke test for the pm-cli Claude Code plugin.
 *
 * Tests:
 * 1. Plugin file structure (marketplace + plugin manifests, skills, commands, agents, hooks)
 * 2. MCP server launcher resolves the repo build
 * 3. MCP server initializes with instructions
 * 4. All 18 required tools are listed
 * 5. pm_run(init), pm_create, pm_claim, pm_update, pm_comments, pm_files, pm_docs, pm_test,
 *    pm_get, pm_context, pm_search, pm_validate, pm_health all succeed
 * 6. Session-start hook script runs without errors
 * 7. Marketplace plugin name matches plugin.json name
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const launcherPath = path.join(repoRoot, "plugins", "pm-cli-claude", "scripts", "pm-mcp-server.mjs");
const sessionStartPath = path.join(repoRoot, "plugins", "pm-cli-claude", "hooks", "session-start.mjs");
const tmpRoot = await mkdtemp(path.join(tmpdir(), "pm-claude-smoke-"));

// Verify plugin files exist
const pluginFiles = [
  // Root-level marketplace (required for /plugin marketplace add unbraind/pm-cli)
  ".claude-plugin/marketplace.json",
  // Plugin manifests
  "plugins/pm-cli-claude/.claude-plugin/plugin.json",
  "plugins/pm-cli-claude/.mcp.json",
  // Skills (5 total)
  "plugins/pm-cli-claude/skills/pm-workflow/SKILL.md",
  "plugins/pm-cli-claude/skills/pm-developer/SKILL.md",
  "plugins/pm-cli-claude/skills/pm-release/SKILL.md",
  "plugins/pm-cli-claude/skills/pm-audit/SKILL.md",
  "plugins/pm-cli-claude/skills/pm-planner/SKILL.md",
  // Commands (9 total)
  "plugins/pm-cli-claude/commands/pm-status.md",
  "plugins/pm-cli-claude/commands/pm-start-task.md",
  "plugins/pm-cli-claude/commands/pm-close-task.md",
  "plugins/pm-cli-claude/commands/pm-triage.md",
  "plugins/pm-cli-claude/commands/pm-audit.md",
  "plugins/pm-cli-claude/commands/pm-search.md",
  "plugins/pm-cli-claude/commands/pm-new.md",
  "plugins/pm-cli-claude/commands/pm-list.md",
  "plugins/pm-cli-claude/commands/pm-calendar.md",
  // Hooks
  "plugins/pm-cli-claude/hooks/hooks.json",
  "plugins/pm-cli-claude/hooks/session-start.mjs",
  // Scripts and agents
  "plugins/pm-cli-claude/scripts/pm-mcp-server.mjs",
  "plugins/pm-cli-claude/README.md",
  "plugins/pm-cli-claude/agents/pm-coordinator.md",
  // Legacy root marketplace.json (backwards compat)
  "marketplace.json",
];

for (const relPath of pluginFiles) {
  const absPath = path.join(repoRoot, relPath);
  if (!existsSync(absPath)) {
    throw new Error(`Missing plugin file: ${relPath}`);
  }
}
console.log(`Plugin file structure: ${pluginFiles.length} files verified`);

// Verify marketplace.json name is "pm" and plugin name matches plugin.json.
// The marketplace is the repo-level catalog; the plugin entry remains pm-cli.
const { readFileSync } = await import("node:fs");
const rootMarketplace = JSON.parse(readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf-8"));
if (rootMarketplace.name !== "pm") {
  throw new Error(`Root marketplace.json name must be "pm", got "${rootMarketplace.name}"`);
}
const marketplacePluginName = rootMarketplace.plugins?.[0]?.name;
if (marketplacePluginName !== "pm-cli") {
  throw new Error(`Root marketplace plugins[0].name must be "pm-cli", got "${marketplacePluginName}"`);
}
const pluginJson = JSON.parse(readFileSync(path.join(repoRoot, "plugins", "pm-cli-claude", ".claude-plugin", "plugin.json"), "utf-8"));
if (pluginJson.name !== "pm-cli") {
  throw new Error(`plugin.json name must be "pm-cli", got "${pluginJson.name}"`);
}
if (marketplacePluginName !== pluginJson.name) {
  throw new Error(`marketplace plugin name "${marketplacePluginName}" does not match plugin.json name "${pluginJson.name}"`);
}
console.log(`Manifest names: marketplace="${rootMarketplace.name}" plugin="${pluginJson.name}" (consistent)`);

const child = spawn(process.execPath, [launcherPath], {
  cwd: tmpRoot,
  env: {
    ...process.env,
    PM_AUTHOR: "claude-smoke",
    PM_GLOBAL_PATH: path.join(tmpRoot, ".pm-global"),
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;
let stderr = "";

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) {
    waiter.reject(new Error(message.error.message));
  } else {
    waiter.resolve(message.result);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 15000);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timeout);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });
}

async function callTool(name, args = {}) {
  const response = await request("tools/call", { name, arguments: args });
  if (response.isError) {
    throw new Error(`${name} returned isError: ${response.content?.[0]?.text ?? "unknown"}`);
  }
  return response.structuredContent?.result ?? JSON.parse(response.content[0].text);
}

try {
  // 1. Initialize and check instructions
  const initResult = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pm-claude-plugin-smoke", version: "1.0.0" },
  });
  if (!initResult.instructions || typeof initResult.instructions !== "string") {
    throw new Error("MCP server missing instructions in initialize response");
  }
  if (!initResult.instructions.includes("pm_context")) {
    throw new Error("Server instructions missing pm_context guidance");
  }
  console.log("MCP initialize: ok (instructions present)");

  // 2. Verify all required tools
  const tools = await request("tools/list");
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  const required = [
    "pm_run", "pm_context", "pm_search", "pm_list", "pm_get",
    "pm_create", "pm_update", "pm_claim", "pm_release", "pm_close",
    "pm_comments", "pm_files", "pm_docs", "pm_test",
    "pm_validate", "pm_health", "pm_contracts", "pm_guide",
  ];
  for (const name of required) {
    if (!toolNames.has(name)) {
      throw new Error(`Missing required MCP tool: ${name}`);
    }
  }
  console.log(`tools/list: ${tools.tools.length} tools (all ${required.length} required tools present)`);

  // 3. Full workflow in sandbox
  await callTool("pm_run", { action: "init", cwd: tmpRoot, options: { preset: "minimal" } });
  console.log("pm_run(init): ok");

  const created = await callTool("pm_create", {
    cwd: tmpRoot,
    author: "claude-smoke",
    options: {
      title: "Claude Code plugin smoke item",
      description: "Verify native Claude Code pm MCP tool flow.",
      type: "Task",
      status: "open",
      priority: "1",
      tags: "claude-code,mcp,smoke",
      acceptanceCriteria: "Native MCP create/get/update/link/comment/validate flow works.",
      createMode: "progressive",
    },
  });
  const id = created.item.id;
  console.log(`pm_create: ok (${id})`);

  await callTool("pm_claim", { cwd: tmpRoot, id, author: "claude-smoke" });
  await callTool("pm_update", { cwd: tmpRoot, id, author: "claude-smoke", options: { status: "in_progress" } });
  console.log("pm_claim + pm_update: ok");

  await callTool("pm_comments", { cwd: tmpRoot, id, author: "claude-smoke", options: { add: "Claude Code plugin smoke evidence." } });
  await callTool("pm_files", { cwd: tmpRoot, id, author: "claude-smoke", options: { add: ["path=README.md,scope=project,note=smoke"] } });
  await callTool("pm_docs", { cwd: tmpRoot, id, author: "claude-smoke", options: { add: ["path=docs/CLAUDE_CODE_PLUGIN.md,scope=project,note=smoke"] } });
  await callTool("pm_test", {
    cwd: tmpRoot,
    id,
    author: "claude-smoke",
    options: { add: ["command=node --version,scope=project,timeout_seconds=30,note=smoke"] },
  });
  console.log("pm_comments + pm_files + pm_docs + pm_test: ok");

  const item = await callTool("pm_get", { cwd: tmpRoot, id });
  if (item.item.status !== "in_progress") throw new Error(`Expected in_progress, got ${item.item.status}`);
  if (item.linked.files.length < 1) throw new Error("Expected at least 1 linked file");
  if (item.linked.tests.length < 1) throw new Error("Expected at least 1 linked test");
  console.log("pm_get: ok (status + links verified)");

  await callTool("pm_context", { cwd: tmpRoot, options: { limit: "5" } });
  console.log("pm_context: ok");

  await callTool("pm_search", { cwd: tmpRoot, query: "smoke", options: { limit: "5" } });
  console.log("pm_search: ok");

  await callTool("pm_validate", { cwd: tmpRoot, options: { checkResolution: true } });
  console.log("pm_validate: ok");

  await callTool("pm_health", { cwd: tmpRoot });
  console.log("pm_health: ok");

  // 4. Test session-start hook in non-pm directory (should exit silently)
  const { execSync } = await import("node:child_process");
  try {
    execSync(`node "${sessionStartPath}"`, {
      cwd: tmpRoot,
      encoding: "utf-8",
      timeout: 6000,
    });
    console.log("session-start hook (no pm): ok (silent exit)");
  } catch (err) {
    if (err.status !== 0) {
      throw new Error(`session-start hook failed with exit ${err.status}: ${err.stderr}`);
    }
  }

  console.log(`\nClaude Code plugin smoke passed for ${id}`);
} finally {
  child.stdin.end();
  child.kill();
  await rm(tmpRoot, { recursive: true, force: true });
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
}
