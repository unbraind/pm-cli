import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runExtension, writeManagedExtensionState } from "../../src/cli/commands/extension.js";
import { runUpgrade, type UpgradeCommandRunner } from "../../src/cli/commands/upgrade.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

async function createPackage(root: string, name: string, version = "1.0.0"): Promise<string> {
  const packageRoot = path.join(root, name);
  const extensionRoot = path.join(packageRoot, "extensions", name);
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: `@example/${name}`,
        version,
        pm: {
          extensions: [`extensions/${name}`],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(extensionRoot, "manifest.json"),
    `${JSON.stringify(
      {
        name,
        version,
        entry: "./index.js",
        capabilities: ["commands"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(path.join(extensionRoot, "index.js"), "export default { activate() {} };\n", "utf8");
  return packageRoot;
}

describe("upgrade command", () => {
  it("plans CLI and managed package upgrades without mutating on dry-run", async () => {
    await withTempPmPath(async (context) => {
      const packageRoot = await createPackage(context.tempRoot, "upgrade-plan-ext");
      await runExtension(packageRoot, { install: true, project: true }, { path: context.pmPath });

      const result = await runUpgrade(undefined, { dryRun: true }, { path: context.pmPath });

      expect(result.ok).toBe(true);
      expect(result.dry_run).toBe(true);
      expect(result.cli).toMatchObject({
        status: "planned",
        target: "@unbrained/pm-cli@latest",
        command: ["npm", "install", "-g", "@unbrained/pm-cli@latest"],
      });
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]).toMatchObject({
        name: "upgrade-plan-ext",
        status: "planned",
        command: ["pm", "install", packageRoot, "--project"],
      });
      expect(result.summary).toMatchObject({
        requested_cli: true,
        requested_packages: true,
        planned: 2,
        failed: 0,
      });
    });
  });

  it("plans registry npm package refreshes against the requested tag", async () => {
    await withTempPmPath(async (context) => {
      await writeManagedExtensionState(path.join(context.pmPath, "extensions"), {
        version: 1,
        updated_at: "2026-05-11T00:00:00.000Z",
        entries: [
          {
            name: "registry-ext",
            directory: "registry-ext",
            scope: "project",
            manifest_version: "1.0.0",
            manifest_entry: "./index.js",
            capabilities: ["commands"],
            installed_at: "2026-05-11T00:00:00.000Z",
            updated_at: "2026-05-11T00:00:00.000Z",
            source: {
              kind: "npm",
              input: "npm:@example/registry-ext",
              location: ".",
              package: "@example/registry-ext",
              version: "1.0.0",
            },
          },
        ],
      });

      const result = await runUpgrade(undefined, { dryRun: true, packagesOnly: true, tag: "next" }, { path: context.pmPath });

      expect(result.cli.status).toBe("skipped");
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]).toMatchObject({
        name: "registry-ext",
        status: "planned",
        command: ["pm", "install", "npm:@example/registry-ext@next", "--project"],
      });
      expect(result.summary).toMatchObject({
        requested_cli: false,
        requested_packages: true,
        planned: 1,
      });
    });
  });

  it("executes CLI self-upgrade through injectable npm and version commands", async () => {
    await withTempPmPath(async (context) => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const commandRunner: UpgradeCommandRunner = async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: command === "pm" ? "2099.1.2\n" : "",
          stderr: "",
        };
      };

      const result = await runUpgrade(
        undefined,
        {
          cliOnly: true,
          repair: true,
          tag: "next",
          packageName: "@example/pm-cli",
          commandRunner,
        },
        { path: context.pmPath },
      );

      expect(result.ok).toBe(true);
      expect(result.cli).toMatchObject({
        status: "updated",
        target: "@example/pm-cli@next",
        after_version: "2099.1.2",
      });
      expect(calls).toEqual([
        { command: "npm", args: ["install", "-g", "@example/pm-cli@next", "--force"] },
        { command: "pm", args: ["--version"] },
      ]);
    });
  });

  it("rejects package targets when CLI-only mode is requested", async () => {
    await withTempPmPath(async (context) => {
      await expect(runUpgrade("registry-ext", { cliOnly: true }, { path: context.pmPath })).rejects.toThrow(
        'A package target cannot be used with "--cli-only".',
      );
    });
  });
});
