import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runExtension, parseExtensionInstallSource, readManagedExtensionState } from "../../src/cli/commands/extension.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
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

  it("rejects strict doctor flags when --doctor is not selected", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runExtension(undefined, { manage: true, project: true, strictExit: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runExtension(undefined, { explore: true, project: true, failOnWarn: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runExtension(undefined, { manage: true, project: true, trace: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runExtension(undefined, { doctor: true, project: true, runtimeProbe: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runExtension(undefined, { explore: true, project: true, fixManagedState: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runExtension(undefined, { explore: true, project: true, watch: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("executes extension reload with cache-busted runtime diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "reload-source-ext");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "reload-source-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(sourceDir, "index.js"), "export default { activate() {} };\n", "utf8");

      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });
      const reloaded = await runExtension(undefined, { reload: true, watch: true, project: true }, { path: context.pmPath });

      expect(reloaded.action).toBe("reload");
      expect(reloaded.details).toMatchObject({
        reload: {
          cache_bust: true,
          watch: true,
        },
      });
      const loadedCount = (reloaded.details as { loaded_count?: number }).loaded_count ?? 0;
      expect(loadedCount).toBeGreaterThan(0);
      expect(reloaded.warnings).toEqual(
        expect.arrayContaining(["extension_reload_watch_hint:watch_mode_requested_non_interactive_single_pass_only"]),
      );
    });
  });

  it("scaffolds starter extension files via init/scaffold aliases with idempotent reruns", async () => {
    await withTempPmPath(async (context) => {
      const scaffoldPath = path.join(context.tempRoot, "starter-ext");
      const scaffold = await runExtension(scaffoldPath, { init: true, project: true }, { path: context.pmPath });
      expect(scaffold.action).toBe("init");
      expect(scaffold.details).toMatchObject({
        extension: {
          name: "starter-ext",
          command: "starter-ext ping",
        },
        target_path: scaffoldPath,
        created_directory: true,
      });

      const manifest = JSON.parse(await readFile(path.join(scaffoldPath, "manifest.json"), "utf8")) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        name: "starter-ext",
        entry: "./index.js",
        capabilities: ["commands"],
      });
      const entry = await readFile(path.join(scaffoldPath, "index.js"), "utf8");
      expect(entry).toContain("module.exports");
      expect(entry).toContain('name: "starter-ext ping"');

      const rerun = await runExtension(scaffoldPath, { scaffold: true, project: true }, { path: context.pmPath });
      const rerunFiles = (rerun.details as { files?: Array<{ status: string }> }).files ?? [];
      expect(rerunFiles.length).toBeGreaterThan(0);
      expect(rerunFiles.every((entry) => entry.status === "unchanged")).toBe(true);
    });
  });

  it("reports usage guidance for missing init target and conflicts for divergent scaffold files", async () => {
    await withTempPmPath(async (context) => {
      await expect(runExtension("init", {}, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });

      const conflictPath = path.join(context.tempRoot, "starter-conflict");
      await mkdir(conflictPath, { recursive: true });
      await writeFile(path.join(conflictPath, "manifest.json"), '{"name":"conflict-ext","entry":"./main.js"}\n', "utf8");
      await expect(runExtension(conflictPath, { init: true, project: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
      });
    });
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

  it("resolves bundled aliases for activate/deactivate lifecycle commands", async () => {
    await withTempPmPath(async (context) => {
      await runExtension("beads", { install: true, project: true }, { path: context.pmPath });

      const deactivate = await runExtension("beads", { deactivate: true, project: true }, { path: context.pmPath });
      expect(deactivate.details).toMatchObject({
        extension: {
          name: "builtin-beads-import",
        },
        active: false,
      });
      const settingsAfterDeactivate = await readSettings(context.pmPath);
      expect(settingsAfterDeactivate.extensions.disabled).toContain("builtin-beads-import");

      const activate = await runExtension("beads", { activate: true, project: true }, { path: context.pmPath });
      expect(activate.details).toMatchObject({
        extension: {
          name: "builtin-beads-import",
        },
        active: true,
      });
      const settingsAfterActivate = await readSettings(context.pmPath);
      expect(settingsAfterActivate.extensions.disabled).not.toContain("builtin-beads-import");
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
        expect.arrayContaining([
          expect.objectContaining({
            name: "sample-ext",
            active: true,
            enabled: true,
            runtime_active: null,
            activation_status: "unknown",
            managed: true,
          }),
        ]),
      );
      expect(explore.details).toMatchObject({
        triage: {
          status: "ok",
          warning_count: 0,
          total_extensions: 1,
          managed_total: 1,
          enabled_total: 1,
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
            active: true,
            enabled: true,
            runtime_active: null,
            activation_status: "unknown",
            update_check_status: "skipped_non_github",
            update_check_reason: "managed_source_kind_local",
          }),
        ]),
      );
      expect(manage.details).toMatchObject({
        total: 1,
        managed_total: 1,
        enabled_total: 1,
        active_total: 1,
        triage: {
          status: "ok",
          warning_count: 0,
          enabled_total: 1,
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
      const triage = manage.details.triage as {
        status: string;
        warning_count: number;
        warning_codes: string[];
        update_health_coverage: string;
        update_health_partial: boolean;
      };
      expect(triage.status).toBe("warn");
      expect(triage.warning_count).toBeGreaterThanOrEqual(1);
      expect(triage.warning_codes).toContain("extension_update_health_partial_coverage");
      expect(triage.update_health_coverage).toBe("partial");
      expect(triage.update_health_partial).toBe(true);
      expect(manage.warnings).toEqual(expect.arrayContaining(["extension_update_health_partial_coverage:skipped_unmanaged:1"]));
    });
  });

  it("treats bundled-style unmanaged extensions as informational by default", async () => {
    await withTempPmPath(async (context) => {
      const unmanagedDir = path.join(context.pmPath, "extensions", "builtin-informational");
      await mkdir(unmanagedDir, { recursive: true });
      await writeFile(
        path.join(unmanagedDir, "manifest.json"),
        JSON.stringify(
          {
            name: "builtin-informational-ext",
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
      const triage = manage.details.triage as {
        update_health_partial: boolean;
        unmanaged_expected_extension_count: number;
        unmanaged_action_required_extension_count: number;
      };
      expect(triage.update_health_partial).toBe(false);
      expect(triage.unmanaged_expected_extension_count).toBe(1);
      expect(triage.unmanaged_action_required_extension_count).toBe(0);
      expect(manage.warnings.some((warning) => warning.startsWith("extension_update_health_partial_coverage:"))).toBe(false);
    });
  });

  it("adopts unmanaged extensions via manage --fix-managed-state", async () => {
    await withTempPmPath(async (context) => {
      const unmanagedDir = path.join(context.pmPath, "extensions", "manual-fix-managed");
      await mkdir(unmanagedDir, { recursive: true });
      await writeFile(
        path.join(unmanagedDir, "manifest.json"),
        JSON.stringify(
          {
            name: "manual-fix-managed",
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

      const manage = await runExtension(
        undefined,
        { manage: true, project: true, fixManagedState: true },
        { path: context.pmPath },
      );
      const managedStateFix = manage.details.managed_state_fix as {
        requested: boolean;
        applied: boolean;
        adopted_count: number;
        adopted_extensions: string[];
      };
      const triage = manage.details.triage as { update_health_partial: boolean };
      const extensions = (manage.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(managedStateFix).toMatchObject({
        requested: true,
        applied: true,
        adopted_count: 1,
      });
      expect(managedStateFix.adopted_extensions).toContain("manual-fix-managed");
      expect(triage.update_health_partial).toBe(false);
      expect(extensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "manual-fix-managed",
            managed: true,
            update_check_status: "skipped_non_github",
          }),
        ]),
      );
    });
  });

  it("keeps top-level warnings aligned with triage warning semantics for manage and doctor", async () => {
    await withTempPmPath(async (context) => {
      const unmanagedDir = path.join(context.pmPath, "extensions", "manual-parity");
      await mkdir(unmanagedDir, { recursive: true });
      await writeFile(
        path.join(unmanagedDir, "manifest.json"),
        JSON.stringify(
          {
            name: "manual-parity",
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
      const manageTriage = manage.details.triage as { warning_codes: string[] };
      expect(manageTriage.warning_codes).toContain("extension_update_health_partial_coverage");
      expect(manage.warnings).toEqual(expect.arrayContaining(["extension_update_health_partial_coverage:skipped_unmanaged:1"]));

      const doctor = await runExtension(undefined, { doctor: true, project: true, detail: "summary" }, { path: context.pmPath });
      const doctorTriage = doctor.details.triage as { warning_codes: string[] };
      expect(doctorTriage.warning_codes).toContain("extension_update_health_partial_coverage");
      expect(doctor.warnings).toEqual(expect.arrayContaining(["extension_update_health_partial_coverage:skipped_unmanaged:1"]));
    });
  });

  it("adopts existing unmanaged extensions into managed local metadata without reinstalling", async () => {
    await withTempPmPath(async (context) => {
      const unmanagedDir = path.join(context.pmPath, "extensions", "manual-adopt");
      await mkdir(unmanagedDir, { recursive: true });
      await writeFile(
        path.join(unmanagedDir, "manifest.json"),
        JSON.stringify(
          {
            name: "manual-adopt",
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

      const adopt = await runExtension("manual-adopt", { adopt: true, project: true }, { path: context.pmPath });
      expect(adopt.action).toBe("adopt");
      expect(adopt.details).toMatchObject({
        adopted: true,
        extension: {
          name: "manual-adopt",
        },
        source: {
          kind: "local",
        },
        update_check_status: "skipped_non_github",
      });

      const managedState = await readManagedExtensionState(path.join(context.pmPath, "extensions"));
      expect(managedState.state.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "manual-adopt",
            source: expect.objectContaining({
              kind: "local",
            }),
          }),
        ]),
      );
    });
  });

  it("returns already_managed when adopt targets a managed extension", async () => {
    await withTempPmPath(async (context) => {
      const unmanagedDir = path.join(context.pmPath, "extensions", "manual-adopt-repeat");
      await mkdir(unmanagedDir, { recursive: true });
      await writeFile(
        path.join(unmanagedDir, "manifest.json"),
        JSON.stringify(
          {
            name: "manual-adopt-repeat",
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

      await runExtension("manual-adopt-repeat", { adopt: true, project: true }, { path: context.pmPath });
      const secondAdopt = await runExtension("manual-adopt-repeat", { adopt: true, project: true }, { path: context.pmPath });
      expect(secondAdopt.details).toMatchObject({
        adopted: false,
        already_managed: true,
        extension: {
          name: "manual-adopt-repeat",
        },
      });
    });
  });

  it("supports GitHub provenance metadata when adopting unmanaged extensions", async () => {
    await withTempPmPath(async (context) => {
      const unmanagedDir = path.join(context.pmPath, "extensions", "manual-adopt-gh");
      await mkdir(unmanagedDir, { recursive: true });
      await writeFile(
        path.join(unmanagedDir, "manifest.json"),
        JSON.stringify(
          {
            name: "manual-adopt-gh",
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

      const adopt = await runExtension(
        "manual-adopt-gh",
        { adopt: true, project: true, gh: "owner/repo/path", ref: "main" },
        { path: context.pmPath },
      );
      expect(adopt.details).toMatchObject({
        adopted: true,
        source: {
          kind: "github",
          owner: "owner",
          repo: "repo",
          ref: "main",
          subpath: "path",
        },
      });

      const managedState = await readManagedExtensionState(path.join(context.pmPath, "extensions"));
      expect(managedState.state.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "manual-adopt-gh",
            source: expect.objectContaining({
              kind: "github",
              owner: "owner",
              repo: "repo",
              ref: "main",
              subpath: "path",
            }),
          }),
        ]),
      );
    });
  });

  it("adopts all unmanaged extensions in one deterministic operation", async () => {
    await withTempPmPath(async (context) => {
      const firstUnmanagedDir = path.join(context.pmPath, "extensions", "manual-adopt-all-a");
      const secondUnmanagedDir = path.join(context.pmPath, "extensions", "manual-adopt-all-b");
      await mkdir(firstUnmanagedDir, { recursive: true });
      await mkdir(secondUnmanagedDir, { recursive: true });
      await writeFile(
        path.join(firstUnmanagedDir, "manifest.json"),
        JSON.stringify(
          {
            name: "manual-adopt-all-a",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        path.join(secondUnmanagedDir, "manifest.json"),
        JSON.stringify(
          {
            name: "manual-adopt-all-b",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(firstUnmanagedDir, "index.js"), "export default { activate() {} };", "utf8");
      await writeFile(path.join(secondUnmanagedDir, "index.js"), "export default { activate() {} };", "utf8");

      const manageBefore = await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath });
      const triageBefore = manageBefore.details.triage as { update_health_partial?: unknown };
      expect(triageBefore.update_health_partial).toBe(true);

      const adoptAll = await runExtension(undefined, { adoptAll: true, project: true }, { path: context.pmPath });
      expect(adoptAll.action).toBe("adopt-all");
      expect(adoptAll.details).toMatchObject({
        adopted_all: true,
        adopted_count: 2,
        already_managed_count: 0,
        warning_codes: expect.any(Array),
        update_health_partial: false,
        update_health_coverage: "full",
      });
      expect((adoptAll.details.extensions as Array<Record<string, unknown>>).map((entry) => entry.name)).toEqual([
        "manual-adopt-all-a",
        "manual-adopt-all-b",
      ]);

      const managedState = await readManagedExtensionState(path.join(context.pmPath, "extensions"));
      expect(managedState.state.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "manual-adopt-all-a", source: expect.objectContaining({ kind: "local" }) }),
          expect.objectContaining({ name: "manual-adopt-all-b", source: expect.objectContaining({ kind: "local" }) }),
        ]),
      );

      const adoptAllNoOp = await runExtension(undefined, { adoptAll: true, project: true }, { path: context.pmPath });
      expect(adoptAllNoOp.details).toMatchObject({
        adopted_all: false,
        adopted_count: 0,
        already_managed_count: 2,
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
          policy: {
            mode: "off",
          },
        },
        policy: {
          mode: "off",
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
          policy?: { mode?: string };
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
      expect(deep.load?.policy?.mode).toBe("off");
      expect((deep.load?.loaded ?? []).some((entry) => entry.name === "doctor-ext")).toBe(true);
      expect(deep.activation?.registration_counts?.item_types ?? 0).toBeGreaterThan(0);
      expect(deep.consistency?.missing_active_project_names ?? []).toEqual([]);

      const targetDoctor = await runExtension("doctor", {}, { path: context.pmPath });
      expect(targetDoctor.action).toBe("doctor");

      await expect(runExtension(undefined, { doctor: true, detail: "verbose" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runExtension(undefined, { doctor: true, detail: "summary", trace: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({
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
        blocking_failure_count: number;
        has_blocking_failures: boolean;
        remediation: string[];
      };
      const deep = doctor.details.deep as { warning_codes?: unknown };

      expect(summary.status).toBe("warn");
      expect(summary.warning_count).toBeGreaterThanOrEqual(2);
      expect(summary.warning_codes).toEqual(
        expect.arrayContaining(["extension_manifest_invalid_json", "extension_manifest_missing"]),
      );
      expect(summary.blocking_failure_count).toBe(0);
      expect(summary.has_blocking_failures).toBe(false);
      expect(summary.remediation).toEqual(
        expect.arrayContaining([expect.stringContaining("pm extension --explore --project")]),
      );
      expect(Array.isArray(deep.warning_codes)).toBe(true);
    });
  });

  it("reports extension governance policy diagnostics in doctor output", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "doctor-policy-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "doctor-policy-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(sourceDir, "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'doctor policy run',",
          "      run: () => ({ ok: true }),",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );
      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });

      const settings = await readSettings(context.pmPath);
      settings.extensions.policy = {
        mode: "enforce",
        allowed_extensions: [],
        blocked_extensions: [],
        allowed_capabilities: [],
        blocked_capabilities: [],
        allowed_surfaces: [],
        blocked_surfaces: ["commands.handler"],
        extension_overrides: [],
      };
      await writeSettings(context.pmPath, settings, "settings:write");

      const doctor = await runExtension(undefined, { doctor: true, project: true, detail: "summary" }, { path: context.pmPath });
      const summary = doctor.details.summary as {
        warning_codes: string[];
        policy?: { mode?: string; blocked_surfaces_count?: number };
      };
      const triage = doctor.details.triage as {
        policy_warning_count: number;
        policy_blocked_count: number;
      };
      const policy = doctor.details.policy as {
        mode: string;
        blocked_surfaces: string[];
      };

      expect(summary.warning_codes).toContain("extension_policy_blocked_registration");
      expect(summary.policy?.mode).toBe("enforce");
      expect(summary.policy?.blocked_surfaces_count).toBe(1);
      expect(triage.policy_warning_count).toBeGreaterThanOrEqual(1);
      expect(triage.policy_blocked_count).toBeGreaterThanOrEqual(1);
      expect(policy.mode).toBe("enforce");
      expect(policy.blocked_surfaces).toEqual(["commands.handler"]);
    });
  });

  it("surfaces unknown capability guidance in doctor diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const extensionsRoot = path.join(context.pmPath, "extensions");
      await mkdir(path.join(extensionsRoot, "unknown-capability"), { recursive: true });
      await writeFile(
        path.join(extensionsRoot, "unknown-capability", "manifest.json"),
        `${JSON.stringify(
          {
            name: "unknown-capability-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["service"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(extensionsRoot, "unknown-capability", "index.js"), "export default { activate() {} };\n", "utf8");

      const doctor = await runExtension(undefined, { doctor: true, project: true, detail: "deep" }, { path: context.pmPath });
      const summary = doctor.details.summary as {
        warning_codes: string[];
        unknown_capability_count: number;
        capability_contract_version: number;
        remediation: string[];
      };
      const capabilityContract = doctor.details.capability_contract as {
        version?: number;
        legacy_aliases?: Record<string, string>;
      };
      const capabilityGuidance = doctor.details.capability_guidance as Array<Record<string, unknown>>;
      const deep = doctor.details.deep as {
        warnings?: string[];
        capability_contract?: { version?: number };
        capability_guidance?: Array<Record<string, unknown>>;
      };

      expect(summary.warning_codes).toContain("extension_capability_unknown");
      expect(summary.unknown_capability_count).toBeGreaterThanOrEqual(1);
      expect(summary.capability_contract_version).toBeGreaterThanOrEqual(1);
      expect(summary.remediation.some((entry) => entry.includes("Allowed capabilities"))).toBe(true);
      expect(capabilityContract.version).toBe(summary.capability_contract_version);
      expect(capabilityContract.legacy_aliases?.migration).toBe("schema");
      expect(capabilityGuidance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: "project",
            name: "unknown-capability-ext",
            capability: "service",
            suggested_capability: "services",
            suggestion_source: "nearest_match",
          }),
        ]),
      );
      expect((capabilityGuidance[0]?.allowed_capabilities as string[]) ?? []).toContain("services");
      expect(typeof capabilityGuidance[0]?.capability_contract_version).toBe("number");
      expect(deep.warnings?.some((warning) => warning.includes("suggested=services"))).toBe(true);
      expect(deep.capability_contract?.version).toBe(summary.capability_contract_version);
      expect((deep.capability_guidance ?? []).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("surfaces legacy capability alias guidance in doctor diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const extensionsRoot = path.join(context.pmPath, "extensions");
      await mkdir(path.join(extensionsRoot, "legacy-capability"), { recursive: true });
      await writeFile(
        path.join(extensionsRoot, "legacy-capability", "manifest.json"),
        `${JSON.stringify(
          {
            name: "legacy-capability-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["migration"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(extensionsRoot, "legacy-capability", "index.js"), "export default { activate() {} };\n", "utf8");

      const doctor = await runExtension(undefined, { doctor: true, project: true, detail: "deep" }, { path: context.pmPath });
      const guidance = doctor.details.capability_guidance as Array<Record<string, unknown>>;
      expect(guidance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "migration",
            suggested_capability: "schema",
            suggestion_source: "legacy_alias",
            legacy_alias_target: "schema",
          }),
        ]),
      );
    });
  });

  it("surfaces doctor load failures in summary warnings", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "doctor-broken-load-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "doctor-broken-load-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(sourceDir, "index.js"), "export default { activate() {} };\n", "utf8");
      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });

      const installedEntryPath = path.join(context.pmPath, "extensions", "doctor-broken-load-ext", "index.js");
      await writeFile(
        installedEntryPath,
        "throw new Error(\"Cannot find package '@unbrained/pm-cli' imported from doctor-broken-load-ext/index.js. Cannot use import statement outside a module.\");\n",
        "utf8",
      );

      const doctor = await runExtension(undefined, { doctor: true, project: true, detail: "deep" }, { path: context.pmPath });
      const summary = doctor.details.summary as {
        load_failure_count: number;
        blocking_failure_count: number;
        warning_codes: string[];
        remediation: string[];
      };

      expect(summary.load_failure_count).toBeGreaterThanOrEqual(1);
      expect(summary.blocking_failure_count).toBeGreaterThanOrEqual(1);
      expect(summary.warning_codes).toContain("extension_load_failed_sdk_dependency_missing");
      expect(summary.warning_codes).toContain("extension_load_failed_module_mode_mismatch");
      expect(summary.remediation.join(" ")).toContain("@unbrained/pm-cli");
      expect(summary.remediation.join(" ")).toContain('"type": "module"');
    });
  });

  it("adopts unmanaged extensions when doctor --fix-managed-state is requested", async () => {
    await withTempPmPath(async (context) => {
      const unmanagedDir = path.join(context.pmPath, "extensions", "doctor-fix-managed");
      await mkdir(unmanagedDir, { recursive: true });
      await writeFile(
        path.join(unmanagedDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "doctor-fix-managed",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(unmanagedDir, "index.js"), "export default { activate() {} };", "utf8");

      const doctor = await runExtension(
        undefined,
        { doctor: true, project: true, detail: "summary", fixManagedState: true },
        { path: context.pmPath },
      );
      const managedStateFix = doctor.details.managed_state_fix as {
        requested: boolean;
        applied: boolean;
        adopted_count: number;
      };
      const triage = doctor.details.triage as { update_health_partial: boolean };
      expect(managedStateFix).toMatchObject({
        requested: true,
        applied: true,
        adopted_count: 1,
      });
      expect(triage.update_health_partial).toBe(false);
    });
  });

  it("includes actionable registerCommand traces when doctor --trace is enabled", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "doctor-trace-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "doctor-trace-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(sourceDir, "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({ name: 'trace broken command' });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );
      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });

      const doctor = await runExtension(
        undefined,
        { doctor: true, project: true, detail: "deep", trace: true },
        { path: context.pmPath },
      );
      const summary = doctor.details.summary as { trace_enabled?: boolean };
      const deep = doctor.details.deep as {
        activation?: { failed?: Array<Record<string, unknown>> };
        trace?: { activation_failures?: Array<Record<string, unknown>> };
      };
      expect(summary.trace_enabled).toBe(true);
      expect(deep.trace?.activation_failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "doctor-trace-ext",
            method: "registerCommand",
            command: "trace broken command",
          }),
        ]),
      );
      expect(deep.trace?.activation_failures?.[0]?.expected_schema).toBe("{ name: string; run: (context) => unknown; }");
      expect(typeof deep.trace?.activation_failures?.[0]?.registration_index).toBe("number");
      expect(deep.activation?.failed?.[0]?.error).toContain("registerCommand requires a command definition run handler");
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
    await expect(runExtension(undefined, { adopt: true }, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runExtension("manual-ext", { adoptAll: true }, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runExtension(undefined, { adoptAll: true, gh: "owner/repo/ext" }, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runExtension(undefined, { adoptAll: true, ref: "main" }, { path: ".agents/pm" })).rejects.toMatchObject({
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
      const triage = result.details.triage as {
        status: string;
        warning_count: number;
        warning_codes: string[];
      };
      expect(triage.status).toBe("warn");
      expect(triage.warning_count).toBeGreaterThanOrEqual(3);
      expect(triage.warning_codes).toContain("extension_update_health_partial_coverage");
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

  it("runs opt-in runtime probe for manage parity without changing default manage semantics", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "runtime-probe-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "runtime-probe-ext",
            version: "1.0.0",
            entry: "index.js",
            capabilities: ["commands"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        path.join(sourceDir, "index.js"),
        "export default { activate() { throw new Error('runtime probe activation failure'); } };",
        "utf8",
      );
      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });

      const manageDefault = await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath });
      const defaultExtensions = (manageDefault.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(defaultExtensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "runtime-probe-ext",
            runtime_active: null,
            activation_status: "unknown",
          }),
        ]),
      );
      expect(manageDefault.details.runtime_probe).toMatchObject({
        requested: false,
        executed: false,
      });

      const manageProbe = await runExtension(
        undefined,
        { manage: true, project: true, runtimeProbe: true },
        { path: context.pmPath },
      );
      const probeExtensions = (manageProbe.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(probeExtensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "runtime-probe-ext",
            runtime_active: false,
            activation_status: "failed",
          }),
        ]),
      );
      expect(manageProbe.details.runtime_probe).toMatchObject({
        requested: true,
        executed: true,
      });
      expect(manageProbe.warnings).toEqual(expect.arrayContaining(["extension_activate_failed:project:runtime-probe-ext"]));
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
