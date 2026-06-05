#!/usr/bin/env node
import path from "node:path";
import { startPluginMcpSmoke } from "./plugin-mcp-smoke-harness.mjs";

const repoRoot = process.cwd();
const serverPath = path.join(repoRoot, "dist", "mcp", "server.js");

const { tmpRoot, request, callTool, dispose } = await startPluginMcpSmoke({
  serverPath,
  author: "codex-smoke",
  tmpPrefix: "pm-codex-mcp-",
});

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pm-codex-plugin-smoke", version: "1.0.0" },
  });
  const tools = await request("tools/list");
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const required of ["pm_run", "pm_context", "pm_create", "pm_get", "pm_update", "pm_comments", "pm_files", "pm_docs", "pm_notes", "pm_learnings", "pm_deps", "pm_test"]) {
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
  await dispose();
}
