import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";
import type * as FsPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  dropPublished: false,
  install: vi.fn(),
}));

vi.mock("node:child_process", async (load) => {
  const actual = await load<typeof ChildProcess>();
  return { ...actual, spawnSync: hooks.install };
});

vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof FsPromises>();
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      await actual.rename(source, destination);
      if (hooks.dropPublished) await actual.rm(destination, { recursive: true, force: true });
    },
  };
});

import { resolvePluginRuntime as resolveClaudeRuntime } from "../../../plugins/pm-claude/scripts/plugin-runtime.mjs";
import { resolvePluginRuntime as resolveCodexRuntime } from "../../../plugins/pm-codex/scripts/plugin-runtime.mjs";

const version = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const originalPluginData = process.env.PLUGIN_DATA;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-plugin-race-"));
  roots.push(root);
  const pluginRoot = path.join(root, "plugin");
  await mkdir(pluginRoot);
  await writeFile(path.join(pluginRoot, "package.json"), JSON.stringify({
    name: "race-plugin", version, dependencies: { "@unbrained/pm-cli": version },
  }));
  process.env.PLUGIN_DATA = path.join(root, "data");
  hooks.install.mockImplementation((_command: string, args: string[]) => {
    const staging = args[args.indexOf("--prefix") + 1];
    const packageRoot = path.join(staging, "node_modules", "@unbrained", "pm-cli");
    mkdirSync(path.join(packageRoot, "dist", "mcp"), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version }));
    writeFileSync(path.join(packageRoot, "dist", "mcp", "server.js"), "");
    writeFileSync(path.join(packageRoot, "dist", "cli.js"), "");
    return { status: 0, stderr: "" };
  });
  return { pluginRoot };
}

afterEach(async () => {
  hooks.dropPublished = false;
  hooks.install.mockReset();
  if (originalPluginData === undefined) delete process.env.PLUGIN_DATA;
  else process.env.PLUGIN_DATA = originalPluginData;
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.each([
  ["Claude", resolveClaudeRuntime],
  ["Codex", resolveCodexRuntime],
])("%s plugin cache publication", (_name, resolveRuntime) => {
  it("selects the Windows npm command through the default installer", async () => {
    const { pluginRoot } = await fixture();
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    await expect(resolveRuntime({ pluginRoot })).resolves.toMatchObject({ version });
    expect(hooks.install).toHaveBeenCalledWith("npm.cmd", expect.any(Array), expect.any(Object));
  });

  it("rejects a runtime removed after atomic cache publication", async () => {
    const { pluginRoot } = await fixture();
    hooks.dropPublished = true;
    await expect(resolveRuntime({ pluginRoot })).rejects.toThrow("is incomplete; remove that directory and retry");
    expect(hooks.install).toHaveBeenCalledWith(process.platform === "win32" ? "npm.cmd" : "npm", expect.any(Array), expect.any(Object));
  });
});
