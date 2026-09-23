/**
 * Resolve the exact pm-cli runtime declared by a copied agent plugin.
 * This file is copied into each plugin by gen-plugin-mcp-wrappers.mjs so a
 * marketplace cache never needs to reach back into the repository checkout.
 */
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@unbrained/pm-cli";
const versionPattern = /^[1-9]\d{3}\.[1-9]\d*\.[1-9]\d*(?:-[1-9]\d*)?$/;

/** Require both the declared version and the executable shipped by that package. */
async function installedRuntime(root, version) {
  const packageRoot = path.join(root, "node_modules", "@unbrained", "pm-cli");
  try {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.version !== version) return null;
    const server = path.join(packageRoot, "dist", "mcp", "server.js");
    const cli = path.join(packageRoot, "dist", "cli.js");
    await access(server);
    await access(cli);
    return { server, cli, version };
  } catch {
    return null;
  }
}

/** Install into a private staging directory and publish only a complete tree. */
async function installRuntime(dataRoot, version, installer) {
  await mkdir(dataRoot, { recursive: true });
  const finalRoot = path.join(dataRoot, `v${version}`);
  const existing = await installedRuntime(finalRoot, version);
  if (existing) return existing;
  const stagingRoot = await mkdtemp(path.join(dataRoot, `.install-${version}-`));
  try {
    const args = ["install", "--prefix", stagingRoot, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", `${packageName}@${version}`];
    const windows = process.platform === "win32";
    // The command text contains only fixed tokens and a validated version.
    // Put the caller-selected path in the child environment so cmd.exe never
    // parses path metacharacters as command syntax.
    const command = windows ? process.env.ComSpec || "cmd.exe" : "npm";
    const commandArgs = windows
      ? ["/d", "/v:off", "/s", "/c", `"npm.cmd ${args.map((arg) => arg === stagingRoot ? '"%PM_PLUGIN_STAGING_ROOT%"' : arg).join(" ")}"`]
      : args;
    const result = installer(command, commandArgs, {
      encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
      ...(windows ? { windowsVerbatimArguments: true, env: { ...process.env, PM_PLUGIN_STAGING_ROOT: stagingRoot } } : {}),
    });
    if (result.error || result.status !== 0 || !(await installedRuntime(stagingRoot, version))) {
      throw new Error(`Cannot install ${packageName}@${version}: ${result.error?.message || result.stderr?.trim() || "incomplete package"}`);
    }
    try {
      await rename(stagingRoot, finalRoot);
    } catch (error) {
      if (!(await installedRuntime(finalRoot, version))) {
        throw new Error(`Plugin runtime at ${finalRoot} is incomplete; remove that directory and retry.`, { cause: error });
      }
    }
    const runtime = await installedRuntime(finalRoot, version);
    if (!runtime) throw new Error(`Plugin runtime at ${finalRoot} is incomplete; remove that directory and retry.`);
    return runtime;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

/** Resolve a copied plugin's runtime without ever consulting npm's latest tag. */
export async function resolvePluginRuntime(options = {}) {
  const root = options.pluginRoot ?? pluginRoot;
  const plugin = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const version = plugin.dependencies?.[packageName];
  if (typeof version !== "string" || !versionPattern.test(version) || plugin.version !== version) {
    throw new Error(`Plugin ${plugin.name ?? root} needs an exact pm-cli dependency matching its version.`);
  }
  const bundled = await installedRuntime(root, version);
  if (bundled) return bundled;
  const dataRoot = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), ".cache", "pm-cli", "plugins", path.basename(root));
  return installRuntime(dataRoot, version, options.installer ?? spawnSync);
}
