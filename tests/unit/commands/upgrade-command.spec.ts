import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runExtension, writeManagedExtensionState } from "../../../src/cli/commands/extension.js";
import { _testOnly as upgradeInternals, runUpgrade, type UpgradeCommandRunner } from "../../../src/cli/commands/upgrade.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

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
  it("covers upgrade helper fallbacks for targets, package sources, commands, and summaries", async () => {
    await withTempPmPath(async (context) => {
      const packageRoot = path.join(context.tempRoot, "local-source");
      await mkdir(packageRoot, { recursive: true });
      const npmSource = {
        kind: "npm" as const,
        input: "@example/plain",
        location: ".",
        package: "@example/plain",
        version: "1.0.0",
      };
      const localSource = {
        kind: "local" as const,
        input: path.join(context.tempRoot, "missing-local-source"),
        location: packageRoot,
      };
      const githubSource = {
        kind: "github" as const,
        input: "Owner/Repo",
        location: "Owner/Repo",
        owner: "Owner",
        repo: "Repo",
        repository: "https://github.com/Owner/Repo",
        ref: "  ",
      };
      const record = {
        name: "Plain Ext",
        directory: "plain-dir",
        scope: "project" as const,
        manifest_version: "1.0.0",
        manifest_entry: "./index.js",
        capabilities: ["commands"],
        installed_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z",
        source: { ...npmSource, input: "npm:@example/plain" },
      };

      expect(upgradeInternals.resolveScope({})).toBe("project");
      expect(upgradeInternals.resolveScope({ local: true })).toBe("project");
      expect(upgradeInternals.resolveScope({ global: true })).toBe("global");
      expect(() => upgradeInternals.resolveScope({ project: true, global: true })).toThrow(/mutually exclusive/);
      expect(upgradeInternals.resolveTag({ tag: " beta " })).toBe("beta");
      expect(upgradeInternals.resolveTag({ tag: " " })).toBe("latest");
      expect(upgradeInternals.resolveCliPackage({ packageName: " @example/pm " })).toBe("@example/pm");
      expect(upgradeInternals.resolveCliPackage({ packageName: " " })).toBe("@unbrained/pm-cli");
      expect(upgradeInternals.isLocalNpmSpec("/tmp/pkg")).toBe(true);
      expect(upgradeInternals.isLocalNpmSpec("file:../pkg")).toBe(true);
      expect(upgradeInternals.isLocalNpmSpec("@example/plain")).toBe(false);
      expect(upgradeInternals.normalizeTarget("  Owner/Repo  ")).toBe("owner/repo");
      expect(upgradeInternals.packageRecordMatchesTarget(record, "plain-dir")).toBe(true);
      expect(upgradeInternals.packageRecordMatchesTarget(record, "npm:@example/plain")).toBe(true);
      expect(upgradeInternals.packageRecordMatchesTarget(record, "@example/missing")).toBe(false);
      expect(upgradeInternals.resolvePackageInstallSource(npmSource, "next")).toBe("npm:@example/plain@next");
      expect(upgradeInternals.resolvePackageInstallSource({ ...npmSource, package: undefined, input: "@example/no-pkg" }, "next")).toBe(
        "npm:@example/no-pkg",
      );
      expect(upgradeInternals.resolvePackageInstallSource({ ...npmSource, input: "../local" }, "next")).toBe("npm:../local");
      expect(upgradeInternals.resolvePackageInstallSource(githubSource, "next")).toBe("Owner/Repo");
      expect(await upgradeInternals.resolveRunnablePackageSource({ ...localSource, input: packageRoot }, "latest")).toBe(packageRoot);
      expect(await upgradeInternals.resolveRunnablePackageSource(localSource, "latest")).toBe(packageRoot);
      expect(
        await upgradeInternals.resolveRunnablePackageSource(
          { ...localSource, input: path.join(context.tempRoot, "missing-input"), location: path.join(context.tempRoot, "missing-location") },
          "latest",
        ),
      ).toBe(path.join(context.tempRoot, "missing-input"));
      expect(upgradeInternals.packageCommandFor(githubSource, "Owner/Repo", "global", githubSource.ref)).toEqual([
        "pm",
        "install",
        "Owner/Repo",
        "--global",
      ]);
      expect(upgradeInternals.packageCommandFor({ ...githubSource, ref: " feature " }, "Owner/Repo", "project", " feature ")).toEqual([
        "pm",
        "install",
        "Owner/Repo",
        "--project",
        "--ref",
        "feature",
      ]);
      expect(
        upgradeInternals.summarize(
          {
            requested: true,
            status: "updated",
            package: "@example/pm",
            target: "@example/pm@latest",
            command: ["npm"],
            repair: false,
          },
          [
            {
              name: "pkg",
              directory: "pkg",
              scope: "project",
              source: npmSource,
              status: "failed",
              command: ["pm"],
              previous_version: "1.0.0",
            },
          ],
          true,
          true,
        ),
      ).toMatchObject({ requested_cli: true, requested_packages: true, updated: 1, failed: 1, skipped: 0 });
    });
  });

  it("returns stdout and stderr from the default command runner on success", async () => {
    await expect(
      upgradeInternals.defaultCommandRunner(process.execPath, [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err')",
      ]),
    ).resolves.toEqual({
      stdout: "out",
      stderr: "err",
    });
  });

  it("surfaces stderr from the default command runner", async () => {
    await expect(
      upgradeInternals.defaultCommandRunner(process.execPath, ["-e", "process.stderr.write('nope'); process.exit(7)"]),
    ).rejects.toThrow("nope");
  });

  it("falls back to the thrown command error message when stderr is empty", async () => {
    await expect(upgradeInternals.defaultCommandRunner(process.execPath, ["--definitely-not-a-node-flag"])).rejects.toThrow(
      "bad option",
    );
  });

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

  it("reports CLI self-upgrade command failures without throwing", async () => {
    await withTempPmPath(async (context) => {
      const commandRunner: UpgradeCommandRunner = async () => {
        throw new Error("npm unavailable");
      };

      const result = await runUpgrade(undefined, { cliOnly: true, commandRunner }, { path: context.pmPath });

      expect(result.ok).toBe(false);
      expect(result.cli.status).toBe("failed");
      expect(result.cli.error).toBe("npm unavailable");
      expect(result.summary.failed).toBe(1);
    });
  });

  it("normalizes blank verified versions and string-thrown CLI errors", async () => {
    await withTempPmPath(async (context) => {
      const blankVersionRunner: UpgradeCommandRunner = async (command) => ({
        stdout: command === "pm" ? "   " : "",
        stderr: "",
      });
      const blankVersionResult = await runUpgrade(
        undefined,
        {
          cliOnly: true,
          commandRunner: blankVersionRunner,
        },
        { path: context.pmPath },
      );
      expect(blankVersionResult.cli.status).toBe("updated");
      expect(blankVersionResult.cli.after_version).toBeUndefined();

      const stringErrorRunner: UpgradeCommandRunner = async () => {
        throw "string-cli-failure";
      };
      const stringErrorResult = await runUpgrade(
        undefined,
        {
          cliOnly: true,
          commandRunner: stringErrorRunner,
        },
        { path: context.pmPath },
      );
      expect(stringErrorResult.cli.status).toBe("failed");
      expect(stringErrorResult.cli.error).toBe("string-cli-failure");
    });
  });

  it("plans targeted global GitHub package upgrades with refs", async () => {
    await withTempPmPath(async (context) => {
      await writeManagedExtensionState(path.join(String(context.env.PM_GLOBAL_PATH), "extensions"), {
        version: 1,
        updated_at: "2026-05-11T00:00:00.000Z",
        entries: [
          {
            name: "github-ext",
            directory: "github-ext-dir",
            scope: "global",
            manifest_version: "1.0.0",
            manifest_entry: "./index.js",
            capabilities: ["commands"],
            installed_at: "2026-05-11T00:00:00.000Z",
            updated_at: "2026-05-11T00:00:00.000Z",
            source: {
              kind: "github",
              input: "owner/repo",
              location: "owner/repo",
              owner: "owner",
              repo: "repo",
              repository: "https://github.com/owner/repo",
              ref: "main",
            },
          },
        ],
      });

      const result = await runUpgrade("owner/repo", { dryRun: true, global: true, tag: "next" }, { path: context.pmPath });

      expect(result.scope).toBe("global");
      expect(result.target).toBe("owner/repo");
      expect(result.cli.status).toBe("skipped");
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]).toMatchObject({
        name: "github-ext",
        status: "planned",
        command: ["pm", "install", "owner/repo", "--global", "--ref", "main"],
      });
      expect(result.summary).toMatchObject({ requested_cli: false, requested_packages: true, planned: 1 });
    });
  });

  it("keeps local npm specs untagged during dry-run planning", async () => {
    await withTempPmPath(async (context) => {
      await writeManagedExtensionState(path.join(context.pmPath, "extensions"), {
        version: 1,
        updated_at: "2026-05-11T00:00:00.000Z",
        entries: [
          {
            name: "local-npm-ext",
            directory: "local-npm-ext",
            scope: "project",
            manifest_version: "1.0.0",
            manifest_entry: "./index.js",
            capabilities: ["commands"],
            installed_at: "2026-05-11T00:00:00.000Z",
            updated_at: "2026-05-11T00:00:00.000Z",
            source: {
              kind: "npm",
              input: "npm:file:../local-npm-ext",
              location: ".",
              package: "@example/local-npm-ext",
              version: "1.0.0",
            },
          },
        ],
      });

      const result = await runUpgrade("local-npm-ext", { dryRun: true, packagesOnly: true, tag: "next" }, { path: context.pmPath });

      expect(result.packages[0]?.command).toEqual(["pm", "install", "npm:file:../local-npm-ext", "--project"]);
    });
  });

  it("executes managed local package upgrades and refreshes installed versions", async () => {
    await withTempPmPath(async (context) => {
      const packageRoot = await createPackage(context.tempRoot, "upgrade-apply-ext", "1.0.0");
      await runExtension(packageRoot, { install: true, project: true }, { path: context.pmPath });
      await writeFile(
        path.join(packageRoot, "extensions", "upgrade-apply-ext", "manifest.json"),
        `${JSON.stringify(
          {
            name: "upgrade-apply-ext",
            version: "2.0.0",
            entry: "./index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = await runUpgrade("upgrade-apply-ext", { packagesOnly: true }, { path: context.pmPath });

      expect(result.ok).toBe(true);
      expect(result.packages[0]).toMatchObject({
        name: "upgrade-apply-ext",
        status: "updated",
        installed_version: "2.0.0",
      });
    });
  });

  it("handles non-Error command failures in the default runner", async () => {
    vi.resetModules();
    const execFileMock = vi
      .fn()
      .mockImplementationOnce((_command: string, _args: string[], _options: object, callback: (error: unknown, stdout?: unknown, stderr?: unknown) => void) => {
        const errorWithUndefinedStderr = Object.assign(new Error("undefined-stderr"), { stderr: undefined });
        callback(errorWithUndefinedStderr);
      })
      .mockImplementationOnce((_command: string, _args: string[], _options: object, callback: (error: unknown, stdout?: unknown, stderr?: unknown) => void) => {
        callback("plain-command-failure");
      });
    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
    }));

    try {
      const mockedUpgrade = await import("../../../src/cli/commands/upgrade.js");
      await expect(mockedUpgrade._testOnly.defaultCommandRunner("mock-cmd", [])).rejects.toThrow("undefined-stderr");
      await expect(mockedUpgrade._testOnly.defaultCommandRunner("mock-cmd", [])).rejects.toThrow("Command failed: mock-cmd");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("refreshes upgraded github records by directory and captures non-Error package failures", async () => {
    vi.resetModules();
    const initialRecord = {
      name: "github-ext",
      directory: "github-ext-dir",
      scope: "project" as const,
      manifest_version: "1.0.0",
      manifest_entry: "./index.js",
      capabilities: ["commands"],
      installed_at: "2026-05-11T00:00:00.000Z",
      updated_at: "2026-05-11T00:00:00.000Z",
      source: {
        kind: "github" as const,
        input: "owner/repo",
        location: "owner/repo",
        owner: "owner",
        repo: "repo",
        repository: "https://github.com/owner/repo",
        ref: "main",
      },
    };
    const refreshedRecord = {
      ...initialRecord,
      name: "github-ext-renamed",
      manifest_version: "2.0.0",
    };
    const readManagedStateMock = vi
      .fn()
      .mockResolvedValueOnce({
        version: 1,
        updated_at: "2026-05-11T00:00:00.000Z",
        state: { entries: [initialRecord] },
      })
      .mockResolvedValueOnce({
        version: 1,
        updated_at: "2026-05-12T00:00:00.000Z",
        state: { entries: [refreshedRecord] },
      })
      .mockResolvedValueOnce({
        version: 1,
        updated_at: "2026-05-12T00:00:00.000Z",
        state: { entries: [initialRecord] },
      })
      .mockResolvedValueOnce({
        version: 1,
        updated_at: "2026-05-12T00:00:00.000Z",
        state: { entries: [initialRecord] },
      });
    const runExtensionMock = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce("string-package-failure")
      .mockRejectedValueOnce(new Error("error-package-failure"));
    vi.doMock("../../../src/cli/commands/extension.js", () => ({
      readManagedExtensionState: readManagedStateMock,
      runExtension: runExtensionMock,
      writeManagedExtensionState: vi.fn(),
    }));

    try {
      const mockedUpgrade = await import("../../../src/cli/commands/upgrade.js");
      const upgraded = await mockedUpgrade.runUpgrade(
        "github-ext",
        {
          packagesOnly: true,
        },
        { path: "/tmp/mock-upgrade-path" },
      );
      expect(upgraded.packages[0]).toMatchObject({
        name: "github-ext",
        status: "updated",
        installed_version: "2.0.0",
      });
      expect(runExtensionMock).toHaveBeenNthCalledWith(
        1,
        "owner/repo",
        expect.objectContaining({ ref: "main" }),
        { path: "/tmp/mock-upgrade-path" },
      );

      const failed = await mockedUpgrade.runUpgrade(
        "github-ext",
        {
          packagesOnly: true,
        },
        { path: "/tmp/mock-upgrade-path" },
      );
      expect(failed.packages[0]).toMatchObject({
        name: "github-ext",
        status: "failed",
        error: "string-package-failure",
      });

      const failedWithError = await mockedUpgrade.runUpgrade(
        "github-ext",
        {
          packagesOnly: true,
        },
        { path: "/tmp/mock-upgrade-path" },
      );
      expect(failedWithError.packages[0]).toMatchObject({
        name: "github-ext",
        status: "failed",
        error: "error-package-failure",
      });
    } finally {
      vi.doUnmock("../../../src/cli/commands/extension.js");
      vi.resetModules();
    }
  });

  it("rejects mutually exclusive scope and mode flags", async () => {
    await withTempPmPath(async (context) => {
      await expect(runUpgrade(undefined, { cliOnly: true, packagesOnly: true }, { path: context.pmPath })).rejects.toThrow(
        'Options "--cli-only" and "--packages-only" are mutually exclusive.',
      );
      await expect(runUpgrade(undefined, { project: true, global: true }, { path: context.pmPath })).rejects.toThrow(
        'Options "--project/--local" and "--global" are mutually exclusive.',
      );
    });
  });

  it("rejects package targets when CLI-only mode is requested", async () => {
    await withTempPmPath(async (context) => {
      await expect(runUpgrade("registry-ext", { cliOnly: true }, { path: context.pmPath })).rejects.toThrow(
        'A package target cannot be used with "--cli-only".',
      );
    });
  });

  it("rejects missing targeted managed packages", async () => {
    await withTempPmPath(async (context) => {
      await expect(runUpgrade("missing-ext", { dryRun: true, packagesOnly: true }, { path: context.pmPath })).rejects.toThrow(
        'Managed package "missing-ext" was not found in project scope.',
      );
    });
  });
});
