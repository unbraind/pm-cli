#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const repoRoot = process.cwd();
const serverPath = path.join(repoRoot, "dist", "mcp", "server.js");
const tmpRoot = await mkdtemp(path.join(tmpdir(), "pm-codex-mcp-"));

const child = spawn(process.execPath, [serverPath], {
  cwd: tmpRoot,
  env: {
    ...process.env,
    PM_AUTHOR: "codex-smoke",
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
    throw new Error(response.content?.[0]?.text ?? `${name} failed`);
  }
  return response.structuredContent?.result ?? JSON.parse(response.content[0].text);
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pm-codex-plugin-smoke", version: "1.0.0" },
  });
  const tools = await request("tools/list");
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const required of ["pm_run", "pm_context", "pm_create", "pm_get", "pm_update", "pm_comments", "pm_files", "pm_docs", "pm_test"]) {
    if (!toolNames.has(required)) {
      throw new Error(`Missing MCP tool ${required}`);
    }
  }

  await callTool("pm_run", { action: "init", cwd: tmpRoot, options: { preset: "minimal" } });
  const created = await callTool("pm_create", {
    cwd: tmpRoot,
    author: "codex-smoke",
    options: {
      title: "Codex MCP smoke item",
      description: "Verify native pm MCP tool flow.",
      type: "Task",
      status: "open",
      priority: "1",
      tags: "codex,mcp,smoke",
      acceptanceCriteria: "Native MCP create/get/update/link/comment flow works.",
      createMode: "progressive",
    },
  });
  const id = created.item.id;
  await callTool("pm_claim", { cwd: tmpRoot, id, author: "codex-smoke" });
  await callTool("pm_update", { cwd: tmpRoot, id, author: "codex-smoke", options: { status: "in_progress" } });
  await callTool("pm_comments", { cwd: tmpRoot, id, author: "codex-smoke", options: { add: "Smoke evidence comment." } });
  await callTool("pm_files", { cwd: tmpRoot, id, author: "codex-smoke", options: { add: ["path=README.md,scope=project,note=smoke"] } });
  await callTool("pm_docs", { cwd: tmpRoot, id, author: "codex-smoke", options: { add: ["path=docs/CODEX_PLUGIN.md,scope=project,note=smoke"] } });
  await callTool("pm_test", {
    cwd: tmpRoot,
    id,
    author: "codex-smoke",
    options: { add: ["command=node --version,scope=project,timeout_seconds=30,note=smoke"] },
  });
  const item = await callTool("pm_get", { cwd: tmpRoot, id });
  if (item.item.status !== "in_progress" || item.linked.files.length !== 1 || item.linked.tests.length !== 1) {
    throw new Error("MCP smoke item did not persist expected status/links");
  }
  await callTool("pm_context", { cwd: tmpRoot, options: { limit: "5" } });
  await callTool("pm_validate", { cwd: tmpRoot, options: { checkResolution: true } });
  console.log(`Codex plugin MCP smoke passed for ${id}`);
} finally {
  child.stdin.end();
  child.kill();
  await rm(tmpRoot, { recursive: true, force: true });
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
}
