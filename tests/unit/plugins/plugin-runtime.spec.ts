import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePluginRuntime as resolveClaudeRuntime } from "../../../plugins/pm-claude/scripts/plugin-runtime.mjs";
import { resolvePluginRuntime as resolveCodexRuntime } from "../../../plugins/pm-codex/scripts/plugin-runtime.mjs";

const version = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const roots: string[] = [];
const originalPluginData = process.env.PLUGIN_DATA;
const originalClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;

async function fixture(manifest: Record<string, unknown> = {
  name: "pm-test-plugin",
  version,
  dependencies: { "@unbrained/pm-cli": version },
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-plugin-runtime-"));
  roots.push(root);
  const pluginRoot = path.join(root, "plugin");
  const dataRoot = path.join(root, "data");
  mkdirSync(pluginRoot);
  await writeFile(path.join(pluginRoot, "package.json"), JSON.stringify(manifest));
  process.env.PLUGIN_DATA = dataRoot;
  delete process.env.CLAUDE_PLUGIN_DATA;
  return { root, pluginRoot, dataRoot };
}

function writeRuntime(root: string, installedVersion = version) {
  const packageRoot = path.join(root, "node_modules", "@unbrained", "pm-cli");
  const server = path.join(packageRoot, "dist", "mcp", "server.js");
  const cli = path.join(packageRoot, "dist", "cli.js");
  mkdirSync(path.dirname(server), { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: installedVersion }));
  writeFileSync(server, "// fixture MCP server\n");
  writeFileSync(cli, "// fixture CLI\n");
  return { server, cli, version: installedVersion };
}

function stagingRoot(args: string[], options?: { env?: NodeJS.ProcessEnv }): string {
  return options?.env?.PM_PLUGIN_STAGING_ROOT ?? args[args.indexOf("--prefix") + 1];
}

afterEach(async () => {
  if (originalPluginData === undefined) delete process.env.PLUGIN_DATA;
  else process.env.PLUGIN_DATA = originalPluginData;
  if (originalClaudePluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = originalClaudePluginData;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.each([
  ["Claude", resolveClaudeRuntime],
  ["Codex", resolveCodexRuntime],
])("%s plugin runtime", (_name, resolveRuntime) => {
  it("uses a matching bundled package without installing", async () => {
    const { pluginRoot } = await fixture();
    const expected = writeRuntime(pluginRoot);
    const installer = vi.fn();
    await expect(resolveRuntime({ pluginRoot, installer })).resolves.toEqual(expected);
    expect(installer).not.toHaveBeenCalled();
  });

  it("reuses a complete pinned cache offline", async () => {
    const { pluginRoot, dataRoot } = await fixture();
    const expected = writeRuntime(path.join(dataRoot, `v${version}`));
    const installer = vi.fn();
    await expect(resolveRuntime({ pluginRoot, installer })).resolves.toEqual(expected);
    expect(installer).not.toHaveBeenCalled();
  });

  it("installs into staging and publishes a complete version directory", async () => {
    const { pluginRoot, dataRoot } = await fixture();
    const installer = vi.fn((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      writeRuntime(stagingRoot(args, options));
      return { status: 0, stderr: "" };
    });
    const runtime = await resolveRuntime({ pluginRoot, installer });
    expect(runtime).toEqual({
      server: path.join(dataRoot, `v${version}`, "node_modules", "@unbrained", "pm-cli", "dist", "mcp", "server.js"),
      cli: path.join(dataRoot, `v${version}`, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js"),
      version,
    });
    expect(installer).toHaveBeenCalledOnce();
    expect(installer.mock.calls[0]?.[1].join(" ")).toContain(`@unbrained/pm-cli@${version}`);
    expect((await readdir(dataRoot)).filter((entry) => entry.startsWith(".install-"))).toEqual([]);
    expect(existsSync(runtime.server)).toBe(true);
  });

  it("rejects incomplete installs and removes their staging trees", async () => {
    const { pluginRoot, dataRoot } = await fixture();
    const installer = vi.fn(() => ({ status: 0, stderr: "" }));
    await expect(resolveRuntime({ pluginRoot, installer })).rejects.toThrow("incomplete package");
    expect(await readdir(dataRoot)).toEqual([]);
  });

  it("reports package-manager failures without publishing a partial runtime", async () => {
    const { pluginRoot, dataRoot } = await fixture();
    const installer = vi.fn(() => ({ status: 1, stderr: "registry unavailable" }));
    await expect(resolveRuntime({ pluginRoot, installer })).rejects.toThrow("registry unavailable");
    expect(await readdir(dataRoot)).toEqual([]);
  });

  it("preserves the package-manager error when process launch fails", async () => {
    const { pluginRoot, dataRoot } = await fixture();
    const installer = vi.fn(() => ({ status: null, error: new Error("npm unavailable"), stderr: "" }));
    await expect(resolveRuntime({ pluginRoot, installer })).rejects.toThrow("npm unavailable");
    expect(await readdir(dataRoot)).toEqual([]);
  });

  it("refuses stale or incomplete cache entries before reinstalling", async () => {
    const { pluginRoot, dataRoot } = await fixture();
    writeRuntime(path.join(dataRoot, `v${version}`), "2026.9.21");
    const installer = vi.fn((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      writeRuntime(stagingRoot(args, options));
      return { status: 0, stderr: "" };
    });
    await expect(resolveRuntime({ pluginRoot, installer })).rejects.toThrow("is incomplete; remove that directory and retry");
    expect(installer).toHaveBeenCalledOnce();
  });

  it("does not conceal a rename failure behind an incomplete concurrent cache", async () => {
    const { pluginRoot, dataRoot } = await fixture();
    const installer = vi.fn((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      writeRuntime(stagingRoot(args, options));
      mkdirSync(path.join(dataRoot, `v${version}`), { recursive: true });
      writeFileSync(path.join(dataRoot, `v${version}`, "incomplete"), "marker");
      return { status: 0, stderr: "" };
    });
    await expect(resolveRuntime({ pluginRoot, installer })).rejects.toThrow("is incomplete; remove that directory and retry");
  });

  it("uses Claude data and a private home cache when the primary data path is absent", async () => {
    const { root, pluginRoot, dataRoot } = await fixture();
    delete process.env.PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    const installer = vi.fn((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      writeRuntime(stagingRoot(args, options));
      return { status: 0, stderr: "" };
    });
    await expect(resolveRuntime({ pluginRoot, installer })).resolves.toMatchObject({ version });
    delete process.env.CLAUDE_PLUGIN_DATA;
    const home = vi.spyOn(os, "homedir").mockReturnValue(root);
    await expect(resolveRuntime({ pluginRoot, installer })).resolves.toMatchObject({ version });
    home.mockRestore();
    expect(installer).toHaveBeenCalledTimes(2);
  });

  it("uses the plugin's own root when no root option is supplied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-plugin-default-root-"));
    roots.push(root);
    process.env.PLUGIN_DATA = root;
    const installer = vi.fn((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      writeRuntime(stagingRoot(args, options));
      return { status: 0, stderr: "" };
    });
    await expect(resolveRuntime({ installer })).resolves.toMatchObject({ version });
  });

  it("accepts a completed concurrent install after its staging rename loses", async () => {
    const { pluginRoot, dataRoot } = await fixture();
    const expected = { ...writeRuntime(path.join(dataRoot, `v${version}`)) };
    await rm(path.join(dataRoot, `v${version}`), { recursive: true });
    const installer = vi.fn((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      writeRuntime(stagingRoot(args, options));
      writeRuntime(path.join(dataRoot, `v${version}`));
      return { status: 0, stderr: "" };
    });
    await expect(resolveRuntime({ pluginRoot, installer })).resolves.toEqual(expected);
    expect((await readdir(dataRoot)).filter((entry) => entry.startsWith(".install-"))).toEqual([]);
  });

  it("requires an exact dependency matching the plugin release", async () => {
    for (const manifest of [
      { name: "invalid", version, dependencies: {} },
      { name: "invalid", version, dependencies: { "@unbrained/pm-cli": "latest" } },
      { name: "invalid", version: "2026.9.21", dependencies: { "@unbrained/pm-cli": version } },
      { version, dependencies: { "@unbrained/pm-cli": "latest" } },
    ]) {
      const { pluginRoot } = await fixture(manifest);
      await expect(resolveRuntime({ pluginRoot })).rejects.toThrow("exact pm-cli dependency");
    }
  });
});
