import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerSetupCommands } from "../../../src/cli/register-setup.js";
import { PmClient, runAction } from "../../../src/sdk/runtime.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("package install dry run", () => {
  it("plans through SDK and every CLI install spelling before any destination mutation", async () => {
    await withTempPmPath(async (context) => {
      const source = path.join(context.tempRoot, "source");
      await writeTestExtension({ root: source, name: "plan-demo" });
      await fs.mkdir(path.join(source, "dist"));
      await fs.writeFile(path.join(source, "dist", "artifact"), "artifact");
      await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "plan-demo", version: "1.0.0", type: "module" }));
      const client = new PmClient({ pmRoot: context.pmPath });
      const result = await client.packageInstall(source, { project: true, dryRun: true });
      expect(result.details).toMatchObject({ installed: false, activated: false, dry_run: true, install_plan: { source_mode: "directory", copy: { complete: true, files: 4 }, packed_alternative: { cwd: source, pack: { command: "npm", args: ["pack", "--ignore-scripts", "--json"] } } } });
      const destination = result.details.install_plan!.copy.destination_directory;
      for (const command of [["package", "install"], ["extension", "install"], ["install"], ["package", "--install"]]) {
        const planned = context.runCli([...command, source, "--project", "--dry-run", "--json"], { expectJson: true });
        expect(planned.code, planned.stderr).toBe(0);
        expect(planned.json).toMatchObject({ details: { dry_run: true, installed: false } });
      }
      const mcpPlan = await runAction({ action: "package-install", target: source, scope: "project", dryRun: true, path: context.pmPath });
      expect(mcpPlan).toMatchObject({ details: { dry_run: true, installed: false, install_plan: { source_mode: "directory" } } });
      const allPlan = await client.packageInstall("all", { project: true, dryRun: true });
      expect(allPlan.details).toMatchObject({ installed_all: false, installed_count: 0, dry_run: true });
      expect(allPlan.details.planned_count).toBeGreaterThan(0);
      const multiPlan = context.runCli(["package", "install", source, source, "--project", "--dry-run", "--json"], { expectJson: true });
      expect(multiPlan.code, multiPlan.stderr).toBe(0);
      expect(multiPlan.json).toMatchObject({ installed_count: 0, dry_run: true, planned_count: 2 });
      const program = new Command().option("--json");
      registerSetupCommands(program);
      const output: string[] = [];
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      try {
        await program.parseAsync(["package", "install", source, source, "--project", "--dry-run", "--json"], { from: "user" });
      } finally {
        write.mockRestore();
      }
      expect(JSON.parse(output.join(""))).toMatchObject({ installed_count: 0, dry_run: true, planned_count: 2 });
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      const installed = await client.packageInstall(source, { project: true });
      expect(installed.ok, JSON.stringify(installed)).toBe(true);
      expect(installed.details).toMatchObject({ install_plan: { copy: { files: 4, complete: true } } });
      expect(await fs.readFile(path.join(destination, "dist", "artifact"), "utf8")).toBe("artifact");
      const alternative = result.details.install_plan!.packed_alternative!;
      const packed = spawnSync(alternative.pack.command, alternative.pack.args, { cwd: alternative.cwd, encoding: "utf8", env: { ...process.env, npm_config_cache: path.join(context.tempRoot, "npm-cache") } });
      expect(packed.status, packed.stderr).toBe(0);
      const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      const archive = path.join(alternative.cwd, filename);
      const archivePlan = await client.packageInstall(archive, { project: true, dryRun: true });
      expect(archivePlan.details).toMatchObject({ installed: false, install_plan: { source_mode: "archive", archive_bytes: (await fs.stat(archive)).size } });
      const archiveInstall = context.runCli([...alternative.install.args.map((argument) => argument === "<archive-filename>" ? archive : argument), "--json"], { expectJson: true });
      expect(archiveInstall.code, archiveInstall.stderr).toBe(0);
      expect(archiveInstall.json).toMatchObject({ ok: true, details: { activated: true, install_plan: { source_mode: "archive" } } });
    });
  });
});
