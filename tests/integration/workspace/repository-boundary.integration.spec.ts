import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { PmClient } from "../../../src/sdk/core.js";
import { handleRequest } from "../../../src/mcp/server.js";
import { runDirectDistCli } from "../../helpers/cliRunner.js";
import { expectJsonErrorEnvelope } from "../../helpers/jsonErrorEnvelope.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

async function trackerBytes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const file = path.join(root, name);
    if ((await stat(file)).isFile()) hashes[name] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return hashes;
}

it.each(["checkout", "worktree", "submodule"])("keeps implicit SDK, CLI and MCP access inside a nested %s", async (kind) => {
  await withTempPmPath(async (context) => {
    const env = { ...context.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    delete env.PM_PATH;
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
    git(context.tempRoot, ["init", "--initial-branch=main"]);
    const inner = path.join(context.tempRoot, "vendor", "inner");
    await mkdir(path.dirname(inner), { recursive: true });
    if (kind === "checkout") git(context.tempRoot, ["init", "--initial-branch=main", inner]);
    else {
      const source = path.join(context.tempRoot, "source");
      git(context.tempRoot, ["init", "--initial-branch=main", source]);
      git(source, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture"]);
      if (kind === "worktree") git(source, ["worktree", "add", "--detach", inner]);
      else git(context.tempRoot, ["-c", "protocol.file.allow=always", "submodule", "add", source, "vendor/inner"]);
    }
    const cwd = path.join(inner, "src");
    const localRoot = path.join(inner, ".agents", "pm");
    await mkdir(cwd);
    const before = await trackerBytes(context.pmPath);
    const create = ["create", "--title", "Boundary fixture", "--type", "Task", "--description", "Disposable boundary control", "--priority", "2", "--json"];
    for (const args of [create, ["list", "--json"], ["config", "project", "set", "ux_deprecation_hints", "false", "--json"]]) {
      const result = runDirectDistCli(args, { cwd, env });
      expect(result.code, result.stderr).toBe(3);
      const error = expectJsonErrorEnvelope(result.stderr, { code: "tracker_root_missing", exit_code: 3 });
      expect(error.recovery?.suggested_retry_args).toEqual(["--pm-path", localRoot, "init", "--defaults", "--agent-guidance", "skip"]);
    }
    vi.stubEnv("PM_PATH", undefined);
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const client = new PmClient({ cwd, noExtensions: true });
      await expect(client.create({ title: "SDK boundary fixture", type: "Task", description: "Disposable boundary control", priority: "2" })).rejects.toMatchObject({ context: { code: "tracker_root_missing", resolved_path: localRoot } });
      await expect(handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pm_create", arguments: { options: { title: "MCP boundary fixture", type: "Task", description: "Disposable boundary control", priority: "2" } } } })).rejects.toMatchObject({ context: { code: "tracker_root_missing", resolved_path: localRoot, recovery: { suggested_retry_args: ["--pm-path", localRoot, "init", "--defaults", "--agent-guidance", "skip"] } } });
    } finally {
      process.chdir(originalCwd);
      vi.unstubAllEnvs();
    }
    expect(await trackerBytes(context.pmPath)).toEqual(before);
    // Deliberate cross-root selections still work, as do normal subdirectories.
    const ordinary = path.join(context.tempRoot, "ordinary");
    await mkdir(ordinary);
    for (const options of [{ cwd, env: { ...env, PM_PATH: context.pmPath } }, { cwd, env }, { cwd: ordinary, env }]) {
      const args = options.env.PM_PATH || options.cwd !== cwd ? ["list", "--json"] : ["--pm-path", context.pmPath, "list", "--json"];
      expect(runDirectDistCli(args, options).code).toBe(0);
    }
    expect(runDirectDistCli(["--pm-path", context.pmPath, ...create], { cwd, env }).code).toBe(0);
    const afterExplicitSelection = await trackerBytes(context.pmPath);
    const initialized = runDirectDistCli(["init", "--defaults", "--agent-guidance", "skip", "--json"], { cwd, env, expectJson: true });
    expect(initialized.code, initialized.stderr).toBe(0);
    expect(initialized.json).toMatchObject({ path: localRoot });
    expect(runDirectDistCli(create, { cwd, env }).code).toBe(0);
    expect(await trackerBytes(context.pmPath)).toEqual(afterExplicitSelection);
  });
}, 60_000);
