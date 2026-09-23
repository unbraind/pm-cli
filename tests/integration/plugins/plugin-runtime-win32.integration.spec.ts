import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolvePluginRuntime as resolveClaudeRuntime } from "../../../plugins/pm-claude/scripts/plugin-runtime.mjs";
import { resolvePluginRuntime as resolveCodexRuntime } from "../../../plugins/pm-codex/scripts/plugin-runtime.mjs";

const version = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const originalPath = process.env.PATH;
const originalPluginData = process.env.PLUGIN_DATA;
const originalTestNode = process.env.PM_PLUGIN_TEST_NODE;
const originalTestScript = process.env.PM_PLUGIN_TEST_SCRIPT;
const originalTestMarker = process.env.PM_PLUGIN_TEST_MARKER;
const roots: string[] = [];

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalPluginData === undefined) delete process.env.PLUGIN_DATA;
  else process.env.PLUGIN_DATA = originalPluginData;
  if (originalTestNode === undefined) delete process.env.PM_PLUGIN_TEST_NODE;
  else process.env.PM_PLUGIN_TEST_NODE = originalTestNode;
  if (originalTestScript === undefined) delete process.env.PM_PLUGIN_TEST_SCRIPT;
  else process.env.PM_PLUGIN_TEST_SCRIPT = originalTestScript;
  if (originalTestMarker === undefined) delete process.env.PM_PLUGIN_TEST_MARKER;
  else process.env.PM_PLUGIN_TEST_MARKER = originalTestMarker;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.skipIf(process.platform !== "win32").each([
  ["Claude", resolveClaudeRuntime],
  ["Codex", resolveCodexRuntime],
])("%s copied plugin invokes a real Windows command processor and preserves the staging path", async (_name, resolveRuntime) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-plugin-win32-"));
  roots.push(root);
  const pluginRoot = path.join(root, "plugin");
  const binRoot = path.join(root, "bin");
  const dataRoot = path.join(root, "plugin data & 50% ready");
  const marker = path.join(root, "invocation.json");
  const script = path.join(root, "installer.cjs");
  await Promise.all([mkdir(pluginRoot), mkdir(binRoot)]);
  await writeFile(path.join(pluginRoot, "package.json"), JSON.stringify({
    name: "pm-plugin-win32-fixture", version, dependencies: { "@unbrained/pm-cli": version },
  }));
  await writeFile(path.join(binRoot, "npm.cmd"), '@echo off\r\n"%PM_PLUGIN_TEST_NODE%" "%PM_PLUGIN_TEST_SCRIPT%" %*\r\n');
  await writeFile(script, `
    const fs = require("node:fs");
    const path = require("node:path");
    const args = process.argv.slice(2);
    const prefix = args[args.indexOf("--prefix") + 1];
    if (prefix !== process.env.PM_PLUGIN_STAGING_ROOT) process.exit(11);
    if (!args.includes("@unbrained/pm-cli@${version}")) process.exit(12);
    const packageRoot = path.join(prefix, "node_modules", "@unbrained", "pm-cli");
    fs.mkdirSync(path.join(packageRoot, "dist", "mcp"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "${version}" }));
    fs.writeFileSync(path.join(packageRoot, "dist", "mcp", "server.js"), "");
    fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), "");
    fs.writeFileSync(process.env.PM_PLUGIN_TEST_MARKER, JSON.stringify({ prefix, args }));
  `);

  process.env.PATH = `${binRoot}${path.delimiter}${originalPath ?? ""}`;
  process.env.PLUGIN_DATA = dataRoot;
  process.env.PM_PLUGIN_TEST_NODE = process.execPath;
  process.env.PM_PLUGIN_TEST_SCRIPT = script;
  process.env.PM_PLUGIN_TEST_MARKER = marker;
  const installed = await resolveRuntime({ pluginRoot });
  const invocation = JSON.parse(await readFile(marker, "utf8")) as { prefix: string; args: string[] };
  expect(invocation.prefix).toContain("plugin data & 50% ready");
  expect(installed.version).toBe(version);
  expect(installed.server).toContain(path.join(dataRoot, `v${version}`));
  await expect(resolveRuntime({ pluginRoot, installer: () => { throw new Error("Cache was not reused"); } })).resolves.toEqual(installed);
});
