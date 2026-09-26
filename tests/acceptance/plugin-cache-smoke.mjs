#!/usr/bin/env node
/**
 * Exercise copied Claude and Codex plugins against a real packed pm-cli install.
 * The warm cache is then launched with npm unavailable, so an accidental
 * registry fallback cannot make the offline proof pass.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPluginMcpSmoke } from "../../scripts/plugin-mcp-smoke-harness.mjs";
import { registerTempCleanup } from "../../scripts/temp-lifecycle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).version;
const npm = "npm";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-plugin-cache-"));
const releaseCleanup = registerTempCleanup(tempRoot);

try {
  const report = JSON.parse(execFileSync(npm, ["pack", repoRoot, "--json", "--ignore-scripts", "--pack-destination", tempRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120000,
  }));
  const artifacts = Object.values(report);
  const artifact = artifacts[0];
  assert.equal(artifacts.length, 1, "npm pack must return one archive");
  assert.equal(artifact.name, "@unbrained/pm-cli");
  assert.equal(artifact.version, version);
  assert.equal(typeof artifact.filename, "string");
  assert.equal(path.basename(artifact.filename), artifact.filename);
  const archive = path.join(tempRoot, artifact.filename);

  for (const plugin of ["pm-claude", "pm-codex"]) {
    const pluginRoot = path.join(tempRoot, "copied-plugins", plugin);
    const dataRoot = path.join(tempRoot, "plugin-data", plugin);
    const cacheRoot = path.join(dataRoot, `v${version}`);
    await cp(path.join(repoRoot, "plugins", plugin), pluginRoot, { recursive: true });
    await mkdir(cacheRoot, { recursive: true });
    const pluginManifest = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
    assert.equal(pluginManifest.version, version);
    assert.equal(pluginManifest.dependencies["@unbrained/pm-cli"], version);
    execFileSync(npm, ["install", "--prefix", cacheRoot, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--prefer-offline", archive], {
      cwd: tempRoot,
      encoding: "utf8",
      timeout: 120000,
    });
    const installed = JSON.parse(await readFile(path.join(cacheRoot, "node_modules", "@unbrained", "pm-cli", "package.json"), "utf8"));
    assert.equal(installed.version, version);

    const offline = {
      PLUGIN_DATA: dataRoot,
      CLAUDE_PLUGIN_DATA: dataRoot,
      PM_CLI_MCP_SERVER: "",
      PATH: "",
      npm_config_offline: "true",
    };
    let serverPath = path.join(pluginRoot, "scripts", "pm-mcp-server.mjs");
    if (plugin === "pm-codex") {
      const portableManifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"));
      const portableMcp = JSON.parse(await readFile(path.join(pluginRoot, "mcp.json"), "utf8"));
      const server = portableMcp.mcpServers?.["pm-mcp"];
      assert.equal(portableManifest.version, version);
      assert.equal(portableManifest.name, plugin);
      assert.equal(server?.type, "stdio");
      assert.equal(server.command, "node");
      assert.equal(server.cwd, "./");
      assert.deepEqual(server.args, ["./scripts/pm-mcp-server.mjs"]);
      serverPath = path.resolve(pluginRoot, server.args[0]);
    }
    const smoke = await startPluginMcpSmoke({
      serverPath,
      author: `${plugin}-cache-smoke`,
      tmpPrefix: `${plugin}-cache-smoke-`,
      environment: offline,
    });
    try {
      const discovery = await smoke.request("server/discover");
      assert.ok(discovery.supportedVersions.includes("2026-07-28"));
      const tools = await smoke.request("tools/list");
      assert.ok(tools.tools.some((tool) => tool.name === "pm_context"));
      await smoke.callTool("pm_run", { action: "init", cwd: smoke.tmpRoot, options: { preset: "minimal" } });
      const created = await smoke.callTool("pm_create", {
        cwd: smoke.tmpRoot,
        options: { title: "Copied plugin cache smoke", type: "Task", status: "open", createMode: "progressive" },
      });
      assert.ok(created.id);
      const context = await smoke.callTool("pm_context", { cwd: smoke.tmpRoot, options: { limit: "5" } });
      assert.ok(context.summary.open >= 1);

      if (plugin === "pm-claude") {
        const hookOutput = execFileSync(process.execPath, [path.join(pluginRoot, "hooks", "session-start.mjs")], {
          cwd: smoke.tmpRoot,
          env: { ...process.env, ...offline, PM_PATH: path.join(smoke.tmpRoot, ".agents", "pm"), PM_GLOBAL_PATH: path.join(smoke.tmpRoot, ".pm-global") },
          encoding: "utf8",
          timeout: 30000,
        });
        assert.ok(hookOutput.includes("pm tracker:"));
      }
    } finally {
      await smoke.dispose();
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
  releaseCleanup();
}
