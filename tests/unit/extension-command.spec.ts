import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runExtension, parseExtensionInstallSource, readManagedExtensionState } from "../../src/cli/commands/extension.js";
import { EXIT_CODE } from "../../src/constants.js";
import { readSettings, writeSettings } from "../../src/settings.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

function runGit(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const completed = spawnSync("git", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return {
    status: completed.status,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? "",
  };
}

describe("extension command runtime", () => {
  it("parses local and GitHub install sources deterministically", () => {
    const local = parseExtensionInstallSource("./extensions/sample");
    expect(local.kind).toBe("local");
    expect(local.absolute_path).toBe(path.resolve(process.cwd(), "./extensions/sample"));

    const githubTree = parseExtensionInstallSource(
      "https://github.com/unbraind/pm-cli/tree/main/.agents/pm/extensions/pi",
    );
    expect(githubTree).toMatchObject({
      kind: "github",
      owner: "unbraind",
      repo: "pm-cli",
      ref: "main",
      subpath: ".agents/pm/extensions/pi",
    });

    const githubDomain = parseExtensionInstallSource("github.com/unbraind/pm-cli/pi");
    expect(githubDomain).toMatchObject({
      kind: "github",
      owner: "unbraind",
      repo: "pm-cli",
      subpath: "pi",
    });

    const githubFlag = parseExtensionInstallSource("unbraind/pm-cli/pi", { forceGithub: true, ref: "main" });
    expect(githubFlag).toMatchObject({
      kind: "github",
      owner: "unbraind",
      repo: "pm-cli",
      ref: "main",
      subpath: "pi",
    });
  });

  it("returns usage errors for invalid forced GitHub shorthand", () => {
    expect(() => parseExtensionInstallSource("not-a-repo", { forceGithub: true })).toThrowError(
      /Invalid GitHub shorthand/,
    );
  });

  it("validates unsupported URL host and empty source inputs", () => {
    expect(() => parseExtensionInstallSource("")).toThrowError(/Extension source is required/);
    expect(() => parseExtensionInstallSource("https://example.com/owner/repo")).toThrowError(
      /Unsupported extension source URL/,
    );
    expect(() => parseExtensionInstallSource("github.com/only-owner")).toThrowError(/Invalid GitHub source/);
  });

  it("installs bundled beads and todos aliases via extension install", async () => {
    await withTempPmPath(async (context) => {
      const beadsInstall = await runExtension("beads", { install: true, project: true }, { path: context.pmPath });
      expect(beadsInstall.details).toMatchObject({
        extension: {
          name: "builtin-beads-import",
        },
        activated: true,
      });

      const todosInstall = await runExtension("todos", { install: true, project: true }, { path: context.pmPath });
      expect(todosInstall.details).toMatchObject({
        extension: {
          name: "builtin-todos-import-export",
        },
        activated: true,
      });
    });
  });

  it("installs bundled extension source via explicit local path", async () => {
    await withTempPmPath(async (context) => {
      const bundledTodosPath = path.resolve(process.cwd(), ".agents", "pm", "extensions", "todos");
      const install = await runExtension(bundledTodosPath, { install: true, project: true }, { path: context.pmPath });
      expect(install.details).toMatchObject({
        extension: {
          name: "builtin-todos-import-export",
        },
        activated: true,
      });
    });
  });

  it("prefers PM_CLI_PACKAGE_ROOT bundled alias source when provided", async () => {
    await withTempPmPath(async (context) => {
      const tempPackageRoot = await mkdtemp(path.join(context.tempRoot, "pm-bundled-root-"));
      const bundledBeadsDir = path.join(tempPackageRoot, ".agents", "pm", "extensions", "beads");
      await mkdir(bundledBeadsDir, { recursive: true });
      await writeFile(
        path.join(bundledBeadsDir, "manifest.json"),
        JSON.stringify(
          {
            name: "env-beads-ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(bundledBeadsDir, "index.js"), "export default { activate() {} };", "utf8");

      const previousPackageRoot = process.env[PM_PACKAGE_ROOT_ENV];
      process.env[PM_PACKAGE_ROOT_ENV] = tempPackageRoot;
      try {
        const install = await runExtension("beads", { install: true, project: true }, { path: context.pmPath });
        expect(install.details).toMatchObject({
          extension: {
            name: "env-beads-ext",
          },
          source: {
            kind: "local",
            location: bundledBeadsDir,
          },
        });
      } finally {
        if (previousPackageRoot === undefined) {
          delete process.env[PM_PACKAGE_ROOT_ENV];
        } else {
          process.env[PM_PACKAGE_ROOT_ENV] = previousPackageRoot;
        }
      }
    });
  });

  it("falls back from missing PM_CLI_PACKAGE_ROOT alias path to module-root bundle", async () => {
    await withTempPmPath(async (context) => {
      const missingRoot = path.join(context.tempRoot, "missing-bundle-root");
      const previousPackageRoot = process.env[PM_PACKAGE_ROOT_ENV];
      process.env[PM_PACKAGE_ROOT_ENV] = missingRoot;
      try {
        const install = await runExtension("todos", { install: true, project: true }, { path: context.pmPath });
        expect(install.details).toMatchObject({
          extension: {
            name: "builtin-todos-import-export",
          },
          source: {
            kind: "local",
          },
        });
      } finally {
        if (previousPackageRoot === undefined) {
          delete process.env[PM_PACKAGE_ROOT_ENV];
        } else {
          process.env[PM_PACKAGE_ROOT_ENV] = previousPackageRoot;
        }
      }
    });
  });

  it("reads managed extension state fallback and invalid schema warnings", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-state-"));
    try {
      const emptyState = await readManagedExtensionState(tempRoot);
      expect(emptyState.state.entries).toEqual([]);
      expect(emptyState.warnings).toEqual([]);

      const statePath = path.join(tempRoot, ".managed-extensions.json");
      await writeFile(statePath, JSON.stringify({ version: 2, entries: [] }, null, 2), "utf8");
      const invalidState = await readManagedExtensionState(tempRoot);
      expect(invalidState.state.entries).toEqual([]);
      expect(invalidState.warnings).toEqual([`extension_manager_state_invalid_schema:${statePath}`]);

      await writeFile(statePath, "{not-json", "utf8");
      const malformedState = await readManagedExtensionState(tempRoot);
      expect(malformedState.state.entries).toEqual([]);
      expect(malformedState.warnings).toEqual([`extension_manager_state_read_failed:${statePath}`]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("installs, explores, manages, toggles activation, and uninstalls a local extension", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "sample-source-ext");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "sample-ext",
            version: "1.0.0",
            entry: "index.js",
            priority: 50,
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(sourceDir, "index.js"), "export default { activate() {} };", "utf8");

      const install = await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });
      expect(install.action).toBe("install");
      expect(install.scope).toBe("project");
      expect(install.details.extension).toMatchObject({
        name: "sample-ext",
        version: "1.0.0",
      });

      const settingsAfterInstall = await readSettings(context.pmPath);
      expect(settingsAfterInstall.extensions.disabled).not.toContain("sample-ext");

      const explore = await runExtension(undefined, { explore: true, project: true }, { path: context.pmPath });
      const exploreExtensions = (explore.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(exploreExtensions).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "sample-ext", active: true, managed: true })]),
      );
      expect(explore.details).toMatchObject({
        triage: {
          status: "ok",
          warning_count: 0,
          total_extensions: 1,
          managed_total: 1,
          active_total: 1,
        },
      });

      const deactivate = await runExtension("sample-ext", { deactivate: true, project: true }, { path: context.pmPath });
      expect(deactivate.details).toMatchObject({
        active: false,
      });
      const settingsAfterDeactivate = await readSettings(context.pmPath);
      expect(settingsAfterDeactivate.extensions.disabled).toContain("sample-ext");

      const activate = await runExtension("sample-ext", { activate: true, project: true }, { path: context.pmPath });
      expect(activate.details).toMatchObject({
        active: true,
      });
      const settingsAfterActivate = await readSettings(context.pmPath);
      expect(settingsAfterActivate.extensions.disabled).not.toContain("sample-ext");

      const manage = await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath });
      const managedExtensions = (manage.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(managedExtensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "sample-ext",
            update_check_status: "skipped_non_github",
            update_check_reason: "managed_source_kind_local",
          }),
        ]),
      );
      expect(manage.details).toMatchObject({
        total: 1,
        managed_total: 1,
        active_total: 1,
        triage: {
          status: "ok",
          warning_count: 0,
          update_check_status_totals: {
            skipped_non_github: 1,
          },
        },
      });

      const uninstall = await runExtension("sample-ext", { uninstall: true, project: true }, { path: context.pmPath });
      expect(uninstall.details).toMatchObject({
        removed: true,
      });
      const stateAfterUninstall = await readManagedExtensionState(path.join(context.pmPath, "extensions"));
      expect(stateAfterUninstall.state.entries).toEqual([]);
    });
  });

  it("installs in place when source is already in extension root", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.pmPath, "extensions", "inline-ext");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "inline-ext",
            version: "1.0.0",
            entry: "index.js",
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(sourceDir, "index.js"), "export default { activate() {} };", "utf8");

      const install = await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });
      expect(install.details).toMatchObject({
        installed_in_place: true,
      });
    });
  });

  it("marks unmanaged discovered extensions as skipped_unmanaged during manage", async () => {
    await withTempPmPath(async (context) => {
      const unmanagedDir = path.join(context.pmPath, "extensions", "manual-unmanaged");
      await mkdir(unmanagedDir, { recursive: true });
      await writeFile(
        path.join(unmanagedDir, "manifest.json"),
        JSON.stringify(
          {
            name: "manual-unmanaged",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(unmanagedDir, "index.js"), "export default { activate() {} };", "utf8");

      const manage = await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath });
      const extensions = (manage.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(extensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "manual-unmanaged",
            managed: false,
            update_check_status: "skipped_unmanaged",
            update_check_reason: "extension_not_managed",
          }),
        ]),
      );
      expect(manage.details).toMatchObject({
        triage: {
          update_check_status_totals: {
            skipped_unmanaged: 1,
          },
        },
      });
    });
  });

  it("runs extension doctor in summary/deep modes and supports doctor subcommand target syntax", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "doctor-source-ext");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "doctor-ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["schema"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        path.join(sourceDir, "index.js"),
        "export function activate(api) { api.registerItemTypes([{ name: \"DoctorAsset\", folder: \"doctor-assets\" }]); }\n",
        "utf8",
      );
      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });

      const summaryDoctor = await runExtension(undefined, { doctor: true, project: true }, { path: context.pmPath });
      expect(summaryDoctor.action).toBe("doctor");
      expect(summaryDoctor.details).toMatchObject({
        mode: "summary",
        summary: {
          scope: "project",
        },
      });
      const warningCodes = (summaryDoctor.details.summary as { warning_codes?: unknown }).warning_codes;
      expect(Array.isArray(warningCodes)).toBe(true);

      const deepDoctor = await runExtension(undefined, { doctor: true, project: true, detail: "deep" }, { path: context.pmPath });
      expect(deepDoctor.details).toMatchObject({
        mode: "deep",
      });
      const deep = deepDoctor.details.deep as {
        installed_extensions?: unknown;
        load?: {
          roots?: { project?: string };
          loaded?: Array<{ name: string }>;
        };
        activation?: {
          registration_counts?: { item_types?: number };
        };
        consistency?: {
          missing_active_project_names?: string[];
        };
      };
      expect(deep.installed_extensions).toBeDefined();
      expect(deep.load?.roots?.project).toBe(path.join(context.pmPath, "extensions"));
      expect((deep.load?.loaded ?? []).some((entry) => entry.name === "doctor-ext")).toBe(true);
      expect(deep.activation?.registration_counts?.item_types ?? 0).toBeGreaterThan(0);
      expect(deep.consistency?.missing_active_project_names ?? []).toEqual([]);

      const targetDoctor = await runExtension("doctor", {}, { path: context.pmPath });
      expect(targetDoctor.action).toBe("doctor");

      await expect(runExtension(undefined, { doctor: true, detail: "verbose" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects doctor action when an explicit extension target is provided", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runExtension("sample-ext", { doctor: true, project: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("reports warning codes and remediation in doctor deep mode", async () => {
    await withTempPmPath(async (context) => {
      const extensionsRoot = path.join(context.pmPath, "extensions");
      await mkdir(path.join(extensionsRoot, "missing-manifest"), { recursive: true });

      const invalidJsonDir = path.join(extensionsRoot, "invalid-json");
      await mkdir(invalidJsonDir, { recursive: true });
      await writeFile(path.join(invalidJsonDir, "manifest.json"), "{", "utf8");

      const doctor = await runExtension(undefined, { doctor: true, project: true, detail: "deep" }, { path: context.pmPath });
      const summary = doctor.details.summary as {
        status: string;
        warning_count: number;
        warning_codes: string[];
        remediation: string[];
      };
      const deep = doctor.details.deep as { warning_codes?: unknown };

      expect(summary.status).toBe("warn");
      expect(summary.warning_count).toBeGreaterThanOrEqual(2);
      expect(summary.warning_codes).toEqual(
        expect.arrayContaining(["extension_manifest_invalid_json", "extension_manifest_missing"]),
      );
      expect(summary.remediation).toEqual(
        expect.arrayContaining([expect.stringContaining("pm extension --explore --project")]),
      );
      expect(Array.isArray(deep.warning_codes)).toBe(true);
    });
  });

  it("validates action flags and missing targets", async () => {
    await expect(runExtension(undefined, {}, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(
      runExtension(undefined, { install: true, uninstall: true }, { path: ".agents/pm" }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runExtension(undefined, { uninstall: true }, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runExtension(undefined, { activate: true }, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runExtension(undefined, { explore: true, project: true, global: true }, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(
      runExtension(undefined, { install: true, project: true, gh: "owner/repo/ext", github: "owner/repo/other" }, { path: ".agents/pm" }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("returns not-found for uninstalling unknown extensions", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runExtension("missing-ext", { uninstall: true, project: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(
        runExtension("missing-ext", { deactivate: true, project: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("writes settings on uninstall when activation state entries exist", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "uninstall-state-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "stateful-ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(sourceDir, "index.js"), "export default { activate() {} };", "utf8");

      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });
      await runExtension("stateful-ext", { deactivate: true, project: true }, { path: context.pmPath });
      const uninstall = await runExtension("stateful-ext", { uninstall: true, project: true }, { path: context.pmPath });
      expect(uninstall.details).toMatchObject({
        settings_changed: true,
      });
    });
  });

  it("writes settings on install when extension was previously disabled", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "install-state-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "install-state-ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(sourceDir, "index.js"), "export default { activate() {} };", "utf8");

      const settingsBefore = await readSettings(context.pmPath);
      settingsBefore.extensions.disabled = ["install-state-ext"];
      await writeSettings(context.pmPath, settingsBefore, "settings:write");

      const install = await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });
      expect(install.details).toMatchObject({
        settings_changed: true,
      });
      const settingsAfter = await readSettings(context.pmPath);
      expect(settingsAfter.extensions.disabled).not.toContain("install-state-ext");
    });
  });

  it("validates local install source shape and manifest constraints", async () => {
    await withTempPmPath(async (context) => {
      const missingDir = path.join(context.tempRoot, "missing-extension");
      await expect(runExtension(missingDir, { install: true, project: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      const fileSource = path.join(context.tempRoot, "not-a-directory.txt");
      await writeFile(fileSource, "file source", "utf8");
      await expect(runExtension(fileSource, { install: true, project: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });

      const noManifestDir = path.join(context.tempRoot, "no-manifest");
      await mkdir(noManifestDir, { recursive: true });
      await writeFile(path.join(noManifestDir, "index.js"), "export default { activate() {} };", "utf8");
      await expect(runExtension(noManifestDir, { install: true, project: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });

      const invalidManifestDir = path.join(context.tempRoot, "invalid-manifest");
      await mkdir(invalidManifestDir, { recursive: true });
      await writeFile(path.join(invalidManifestDir, "manifest.json"), "{", "utf8");
      await expect(runExtension(invalidManifestDir, { install: true, project: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });

      const missingEntryDir = path.join(context.tempRoot, "missing-entry");
      await mkdir(missingEntryDir, { recursive: true });
      await writeFile(
        path.join(missingEntryDir, "manifest.json"),
        JSON.stringify(
          {
            name: "missing-entry-ext",
            version: "1.0.0",
            entry: "index.js",
          },
          null,
          2,
        ),
        "utf8",
      );
      await expect(runExtension(missingEntryDir, { install: true, project: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });

      const outsideEntryDir = path.join(context.tempRoot, "outside-entry");
      await mkdir(outsideEntryDir, { recursive: true });
      await writeFile(
        path.join(outsideEntryDir, "manifest.json"),
        JSON.stringify(
          {
            name: "outside-entry-ext",
            version: "1.0.0",
            entry: "../outside.js",
          },
          null,
          2,
        ),
        "utf8",
      );
      await expect(runExtension(outsideEntryDir, { install: true, project: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("reports malformed discovered extension warnings during explore", async () => {
    await withTempPmPath(async (context) => {
      const extensionsRoot = path.join(context.pmPath, "extensions");
      await mkdir(path.join(extensionsRoot, "missing-manifest"), { recursive: true });

      const invalidJsonDir = path.join(extensionsRoot, "invalid-json");
      await mkdir(invalidJsonDir, { recursive: true });
      await writeFile(path.join(invalidJsonDir, "manifest.json"), "{", "utf8");

      const invalidSchemaDir = path.join(extensionsRoot, "invalid-schema");
      await mkdir(invalidSchemaDir, { recursive: true });
      await writeFile(path.join(invalidSchemaDir, "manifest.json"), JSON.stringify({ name: "oops" }, null, 2), "utf8");

      const result = await runExtension(undefined, { explore: true, project: true }, { path: context.pmPath });
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          "extension_manifest_missing:project:missing-manifest",
          "extension_manifest_invalid_json:project:invalid-json",
          "extension_manifest_invalid:project:invalid-schema",
        ]),
      );
      expect(result.details).toMatchObject({
        triage: {
          status: "warn",
          warning_count: 3,
        },
      });
    });
  });

  it("supports global-scope lifecycle operations and directory-name targets", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "global-source-ext");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "Global Scope Ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(sourceDir, "index.js"), "export default { activate() {} };", "utf8");

      const install = await runExtension(sourceDir, { install: true, global: true }, { path: context.pmPath });
      expect(install.scope).toBe("global");

      const explore = await runExtension(undefined, { explore: true, global: true }, { path: context.pmPath });
      const listed = (explore.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ directory: "global-scope-ext" })]));

      const deactivate = await runExtension("global-scope-ext", { deactivate: true, global: true }, { path: context.pmPath });
      expect(deactivate.details).toMatchObject({ active: false });

      const activate = await runExtension("global-scope-ext", { activate: true, global: true }, { path: context.pmPath });
      expect(activate.details).toMatchObject({ active: true });

      const uninstall = await runExtension("global-scope-ext", { uninstall: true, global: true }, { path: context.pmPath });
      expect(uninstall.details).toMatchObject({ removed: true });
    });
  });

  it("updates managed GitHub metadata during manage checks", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "github-manage-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "github-managed-ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(sourceDir, "index.js"), "export default { activate() {} };", "utf8");
      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });

      const repoDir = path.join(context.tempRoot, "github-manage-remote");
      await mkdir(repoDir, { recursive: true });
      expect(runGit(["init", repoDir]).status).toBe(0);
      await writeFile(path.join(repoDir, "README.md"), "remote", "utf8");
      expect(runGit(["-C", repoDir, "add", "README.md"]).status).toBe(0);
      expect(
        runGit([
          "-C",
          repoDir,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "init",
        ]).status,
      ).toBe(0);
      const revParse = runGit(["-C", repoDir, "rev-parse", "HEAD"]);
      expect(revParse.status).toBe(0);
      const remoteCommit = revParse.stdout.trim();
      expect(remoteCommit.length).toBeGreaterThan(0);

      const managedPath = path.join(context.pmPath, "extensions", ".managed-extensions.json");
      const managedRaw = JSON.parse(await readFile(managedPath, "utf8")) as {
        version: number;
        updated_at: string;
        entries: Array<Record<string, unknown>>;
      };
      managedRaw.entries[0] = {
        ...managedRaw.entries[0],
        source: {
          kind: "github",
          input: "owner/repo/github-managed-ext",
          location: ".",
          repository: repoDir,
          owner: "owner",
          repo: "repo",
          ref: "HEAD",
          subpath: ".",
          commit: "0000000000000000000000000000000000000000",
        },
      };
      await writeFile(managedPath, `${JSON.stringify(managedRaw, null, 2)}\n`, "utf8");

      const manage = await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath });
      const extensions = (manage.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(extensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "github-managed-ext",
            update_available: true,
            last_update_remote_commit: remoteCommit,
            update_check_status: "checked",
            update_check_reason: "update_available",
          }),
        ]),
      );

      const refreshedState = JSON.parse(await readFile(managedPath, "utf8")) as {
        entries: Array<Record<string, unknown>>;
      };
      expect(refreshedState.entries[0]).toMatchObject({
        last_update_remote_commit: remoteCommit,
        update_available: true,
      });
    });
  });

  it("handles multi-extension sorting, reinstall updates, and manage warning paths", async () => {
    await withTempPmPath(async (context) => {
      const alphaSource = path.join(context.tempRoot, "alpha-source");
      await mkdir(alphaSource, { recursive: true });
      await writeFile(
        path.join(alphaSource, "manifest.json"),
        JSON.stringify(
          {
            name: "alpha-ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands", "schema"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(alphaSource, "index.js"), "export default { activate() {} };", "utf8");

      const betaSource = path.join(context.tempRoot, "beta-source");
      await mkdir(betaSource, { recursive: true });
      await writeFile(
        path.join(betaSource, "manifest.json"),
        JSON.stringify(
          {
            name: "beta-ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands", "schema"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(betaSource, "index.js"), "export default { activate() {} };", "utf8");

      await runExtension(alphaSource, { install: true, project: true }, { path: context.pmPath });
      await runExtension(betaSource, { install: true, project: true }, { path: context.pmPath });

      await writeFile(
        path.join(alphaSource, "manifest.json"),
        JSON.stringify(
          {
            name: "alpha-ext",
            version: "1.0.1",
            entry: "index.js",
            capabilities: ["commands", "schema"],
          },
          null,
          2,
        ),
        "utf8",
      );
      const reinstall = await runExtension(alphaSource, { install: true, project: true }, { path: context.pmPath });
      expect(reinstall.details).toMatchObject({
        overwritten: true,
      });

      const seededSettings = await readSettings(context.pmPath);
      seededSettings.extensions.enabled = ["z-ext", "a-ext"];
      seededSettings.extensions.disabled = ["z-dis", "a-dis"];
      await writeSettings(context.pmPath, seededSettings, "settings:write");

      await runExtension("alpha-ext", { activate: true, project: true }, { path: context.pmPath });
      await runExtension("beta-ext", { deactivate: true, project: true }, { path: context.pmPath });

      const explore = await runExtension(undefined, { explore: true, project: true }, { path: context.pmPath });
      const listedNames = ((explore.details.extensions as Array<Record<string, unknown>>) ?? [])
        .map((entry) => String(entry.name))
        .sort((left, right) => left.localeCompare(right));
      expect(listedNames).toEqual(["alpha-ext", "beta-ext"]);

      const managedPath = path.join(context.pmPath, "extensions", ".managed-extensions.json");
      const managedRaw = JSON.parse(await readFile(managedPath, "utf8")) as {
        version: number;
        updated_at: string;
        entries: Array<Record<string, unknown>>;
      };
      managedRaw.entries = managedRaw.entries.map((entry) =>
        entry.name === "alpha-ext"
          ? {
              ...entry,
              source: {
                kind: "github",
                input: "owner/repo/alpha-ext",
                location: ".",
                repository: path.join(context.tempRoot, "missing-github-remote"),
                owner: "owner",
                repo: "repo",
                ref: "main",
                subpath: ".",
                commit: "deadbeef",
              },
            }
          : entry,
      );
      await writeFile(managedPath, `${JSON.stringify(managedRaw, null, 2)}\n`, "utf8");

      const manage = await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath });
      expect(manage.warnings).toEqual(expect.arrayContaining(["extension_update_check_failed:alpha-ext"]));
      expect(manage.details).toMatchObject({
        triage: {
          status: "warn",
          update_check_failed_total: 1,
          update_check_status_totals: {
            failed: 1,
          },
        },
      });
    });
  });

  it("flags github-managed entries without repository metadata during manage", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "missing-repo-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "missing-repo-ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(sourceDir, "index.js"), "export default { activate() {} };", "utf8");
      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });

      const managedPath = path.join(context.pmPath, "extensions", ".managed-extensions.json");
      const managedRaw = JSON.parse(await readFile(managedPath, "utf8")) as {
        version: number;
        updated_at: string;
        entries: Array<Record<string, unknown>>;
      };
      managedRaw.entries[0] = {
        ...managedRaw.entries[0],
        source: {
          kind: "github",
          input: "owner/repo/missing-repo-ext",
          location: ".",
          owner: "owner",
          repo: "repo",
        },
      };
      await writeFile(managedPath, `${JSON.stringify(managedRaw, null, 2)}\n`, "utf8");

      const manage = await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath });
      expect(manage.warnings).toEqual(expect.arrayContaining(["extension_update_check_failed:missing-repo-ext"]));
      expect(manage.details).toMatchObject({
        triage: {
          status: "warn",
          update_check_failed_total: 1,
          update_check_status_totals: {
            failed: 1,
          },
        },
      });
    });
  });
});
