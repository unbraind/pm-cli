import { spawnSync } from "node:child_process";
import {
  chmod,
  cp as fsPromisesCp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  _testOnly as extensionCommandTestOnly,
  copyExtensionDirectoryForInstall,
  parseExtensionManifest,
  runExtension,
  parseExtensionInstallSource,
  readManagedExtensionState,
  validateExtensionDirectory,
} from "../../../src/cli/commands/extension.js";
import {
  createEmptyManagedExtensionState,
  managedExtensionSourcesEquivalent,
  normalizeManagedState,
  sortManagedEntries,
  upsertManagedEntry,
  writeManagedExtensionState,
} from "../../../src/cli/commands/extension/managed-state.js";
import {
  buildNpmNotFoundRecovery,
  _testOnlyInstallSources,
  isNpmNotFoundError,
  isNpmPackNotFoundError,
  normalizeNpmLocalFileAliasSpec,
  runGitCommand,
  resolveInstallSource,
  resolveNpmCommandName,
  shouldRunNpmCommandInShell,
  wrapNpmPackResolutionError,
} from "../../../src/cli/commands/extension/install-sources.js";
import {
  applyDoctorRuntimeActivationState,
  buildCapabilityContractMetadata,
  buildDoctorConsistencySummary,
  buildExtensionTriageSummary,
  buildRegistrationCollisionRemediation,
  classifyDoctorLoadFailureWarnings,
  classifyDoctorActivationFailureWarnings,
  collectUnknownCapabilityGuidance,
} from "../../../src/cli/commands/extension/doctor.js";
import {
  _testOnlyBundledCatalog,
  buildBundledPackageCatalog,
  listBundledPackageAliases,
  resolveBundledAliasManifestName,
  resolveBundledExtensionAliasSource,
} from "../../../src/cli/commands/extension/bundled-catalog.js";
import { normalizeManagedDirectoryName } from "../../../src/cli/commands/extension/shared.js";
import {
  coerceLooseCommandOptionsWithFlagDefinitions,
  collectLooseCommandOptionKeysForDefinitions,
  parseLooseCommandOptions,
  stripLooseCommandOptionTokens,
  validateLooseCommandOptionsWithFlagDefinitions,
} from "../../../src/cli/extension-command-options.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

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
  it("covers pure extension command helper decisions", () => {
    expect(extensionCommandTestOnly.resolveAction("doctor", {})).toBe("doctor");
    expect(extensionCommandTestOnly.resolveAction("reload", {})).toBe("reload");
    expect(extensionCommandTestOnly.resolveAction("catalog", {})).toBe("catalog");
    expect(extensionCommandTestOnly.resolveAction("scaffold", {})).toBe("init");
    expect(extensionCommandTestOnly.resolveAction("manage", {})).toBe("manage");
    expect(extensionCommandTestOnly.resolveAction("list", {})).toBe("explore");
    expect(extensionCommandTestOnly.resolveAction("", {})).toBe("explore");
    expect(extensionCommandTestOnly.resolveAction(undefined, {})).toBe("explore");
    expect(() => extensionCommandTestOnly.resolveAction("target", { install: true, manage: true })).toThrow(/mutually exclusive/);
    expect(() => extensionCommandTestOnly.resolveAction("target", {})).toThrow(/One action flag is required/);
    expect(extensionCommandTestOnly.resolveScope({ project: true })).toBe("project");
    expect(extensionCommandTestOnly.resolveScope({ local: true })).toBe("project");
    expect(extensionCommandTestOnly.resolveScope({ global: true })).toBe("global");
    expect(() => extensionCommandTestOnly.resolveScope({ project: true, global: true })).toThrow(/mutually exclusive/);

    expect(() => extensionCommandTestOnly.requireTarget(undefined, "init")).toThrow(/requires a scaffold target path/);
    expect(() => extensionCommandTestOnly.requireTarget(" ", "install")).toThrow(/requires an extension name/);
    expect(extensionCommandTestOnly.requireTarget(" package ", "install")).toBe("package");

    expect(extensionCommandTestOnly.resolveGithubOption({ gh: " owner/repo ", github: "owner/repo" })).toBe("owner/repo");
    expect(extensionCommandTestOnly.resolveGithubOption({ github: " owner/repo " })).toBe("owner/repo");
    expect(extensionCommandTestOnly.resolveGithubOption({ gh: " " })).toBeUndefined();
    expect(() => extensionCommandTestOnly.resolveGithubOption({ gh: "one", github: "two" })).toThrow(/must match/);

    expect(
      extensionCommandTestOnly.resolveUpdateCheckResolution({
        source: { kind: "local", input: "./local", location: "/tmp/local" },
      }),
    ).toEqual({ status: "skipped_non_github", reason: "managed_source_kind_local" });
    expect(
      extensionCommandTestOnly.resolveUpdateCheckResolution({
        source: { kind: "github", input: "owner/repo", location: ".", repository: "repo" },
        update_error: "network_down",
      }),
    ).toEqual({ status: "failed", reason: "network_down" });
    expect(
      extensionCommandTestOnly.resolveUpdateCheckResolution({
        source: { kind: "github", input: "owner/repo", location: ".", repository: "repo" },
        last_update_check_at: "2026-01-01T00:00:00.000Z",
        update_available: true,
      }),
    ).toEqual({ status: "checked", reason: "update_available" });
    expect(
      extensionCommandTestOnly.resolveUpdateCheckResolution({
        source: { kind: "github", input: "owner/repo", location: ".", repository: "repo" },
        last_update_check_at: "2026-01-01T00:00:00.000Z",
        update_available: false,
      }),
    ).toEqual({ status: "checked", reason: "up_to_date" });
    expect(
      extensionCommandTestOnly.resolveUpdateCheckResolution({
        source: { kind: "github", input: "owner/repo", location: ".", repository: "repo" },
        last_update_check_at: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({ status: "checked", reason: "checked_without_commit_baseline" });

    expect(
      extensionCommandTestOnly.resolveCommandDiscoveryPackageName("fallback", {
        kind: "npm",
        input: "pkg",
        location: ".",
        package: " @scope/pkg ",
      }),
    ).toBe("@scope/pkg");
    expect(
      extensionCommandTestOnly.resolveCommandDiscoveryPackageName("fallback", {
        kind: "builtin",
        input: "guide",
        location: "builtin",
        name: " guide-shell ",
      }),
    ).toBe("guide-shell");
    expect(
      extensionCommandTestOnly.buildInstallCommandDiscovery(
        "fallback",
        { kind: "local", input: "./ext", location: "/tmp/ext" },
        { command_paths: ["z", "a"], action_paths: ["b"] },
      ),
    ).toMatchObject({
      package_name: "fallback",
      extension_name: "fallback",
      command_paths: ["z", "a"],
      action_paths: ["b"],
      help_commands: ["pm z --help", "pm a --help"],
    });
    expect(
      extensionCommandTestOnly.collectGlobalOutputOverrideDoctorWarnings({
        services: { overrides: [{ service: "output_format", layer: "project", name: "svc" }, { service: "other" }] },
        renderers: { overrides: [{ format: "json", layer: "global", name: "renderer" }] },
      }),
    ).toEqual([
      "extension_output_renderer_override_global:json:global:renderer",
      "extension_output_service_override_global:output_format:project:svc",
    ]);

    expect(extensionCommandTestOnly.isRetriableExtensionInstallCopyError("plain")).toBe(false);
    expect(extensionCommandTestOnly.isRetriableExtensionInstallCopyError({ code: "ENOENT" })).toBe(true);
    expect(extensionCommandTestOnly.isRetriableExtensionInstallCopyError({ code: "EACCES" })).toBe(false);
    expect(extensionCommandTestOnly.isErrnoCode({ code: "EEXIST" }, "EEXIST")).toBe(true);
    expect(extensionCommandTestOnly.isErrnoCode(null, "EEXIST")).toBe(false);

    expect(
      extensionCommandTestOnly.buildExtensionPolicyDetails({
        mode: "warn",
        trust_mode: "enforce",
        require_provenance: true,
        trusted_extensions: [" trusted ", ""],
        default_sandbox_profile: "strict",
        allowed_extensions: ["alpha"],
        blocked_extensions: ["beta"],
        allowed_capabilities: [" commands "],
        blocked_capabilities: [" services "],
        allowed_surfaces: ["cli"],
        blocked_surfaces: ["mcp"],
        allowed_commands: ["one"],
        blocked_commands: ["two"],
        allowed_actions: ["act"],
        blocked_actions: ["block"],
        allowed_services: ["svc"],
        blocked_services: ["bad"],
        extension_overrides: [
          {
            name: " zed ",
            disabled: true,
            require_trusted: true,
            require_provenance: true,
            sandbox_profile: "restricted",
            allowed_capabilities: ["cap"],
            blocked_capabilities: ["blocked-cap"],
            allowed_surfaces: ["surface"],
            blocked_surfaces: ["hidden"],
            allowed_commands: ["cmd"],
            blocked_commands: ["cmd-blocked"],
            allowed_actions: ["action"],
            blocked_actions: ["action-blocked"],
            allowed_services: ["service"],
            blocked_services: ["service-blocked"],
          },
          { name: " " },
        ],
      } as never),
    ).toMatchObject({
      mode: "warn",
      trust_mode: "enforce",
      require_provenance: true,
      trusted_extensions: ["trusted"],
      extension_overrides: [
        {
          name: "zed",
          disabled: true,
          require_trusted: true,
          require_provenance: true,
          sandbox_profile: "restricted",
          allowed_capabilities: ["cap"],
          blocked_services: ["service-blocked"],
        },
      ],
    });

    expect(_testOnlyBundledCatalog.parsePackageCatalogFields(undefined)).toBeUndefined();
    expect(_testOnlyBundledCatalog.parsePackageCatalogFields("alias, category,display_name")).toEqual([
      "alias",
      "category",
      "display_name",
    ]);
    expect(() => _testOnlyBundledCatalog.parsePackageCatalogFields(" ")).toThrow(/requires a comma-separated/);
    expect(() => _testOnlyBundledCatalog.parsePackageCatalogFields("alias,nope")).toThrow(/Unknown package catalog/);
    expect(
      _testOnlyBundledCatalog.projectPackageCatalogEntry(
        { alias: "guide", catalog: { category: "ops", display_name: "Guide" }, package_name: "@unbrained/pm-guide" },
        ["alias", "category", "display_name", "package_name", "missing"],
      ),
    ).toEqual({
      alias: "guide",
      category: "ops",
      display_name: "Guide",
      package_name: "@unbrained/pm-guide",
      missing: null,
    });
    expect(
      _testOnlyBundledCatalog.projectPackageCatalogEntry(
        {
          alias: "guide",
        },
        ["category", "display_name"],
      ),
    ).toEqual({
      category: null,
      display_name: null,
    });
  });

  it("covers extension helper fallback and lock edge branches", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-helpers-"));
    try {
      expect(extensionCommandTestOnly.resolveAction("explore", {})).toBe("explore");
      expect(
        extensionCommandTestOnly.buildExtensionPolicyDetails({
          mode: "warn",
          trust_mode: "enforce",
        } as never),
      ).toMatchObject({
        require_provenance: false,
        default_sandbox_profile: "none",
        trusted_extensions: [],
        allowed_extensions: [],
        blocked_extensions: [],
        allowed_capabilities: [],
        blocked_capabilities: [],
        allowed_surfaces: [],
        blocked_surfaces: [],
        allowed_commands: [],
        blocked_commands: [],
        allowed_actions: [],
        blocked_actions: [],
        allowed_services: [],
        blocked_services: [],
        extension_overrides: [],
      });
      expect(
        extensionCommandTestOnly
          .buildExtensionPolicyDetails({
            mode: "warn",
            trust_mode: "warn",
            require_provenance: false,
            trusted_extensions: [],
            default_sandbox_profile: "none",
            allowed_extensions: [],
            blocked_extensions: [],
            allowed_capabilities: [],
            blocked_capabilities: [],
            allowed_surfaces: [],
            blocked_surfaces: [],
            allowed_commands: [],
            blocked_commands: [],
            allowed_actions: [],
            blocked_actions: [],
            allowed_services: [],
            blocked_services: [],
            extension_overrides: [{ name: "beta" }, { name: "alpha" }],
          } as never)
          .extension_overrides.map((entry) => entry.name),
      ).toEqual(["alpha", "beta"]);

      const sourceDir = path.join(tempRoot, "source");
      const destinationDir = path.join(tempRoot, "destination");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(path.join(sourceDir, "manifest.json"), "{\"name\":\"copy\"}\n", "utf8");
      await expect(
        copyExtensionDirectoryForInstall(sourceDir, destinationDir, async () => {
          throw new Error("copy boom");
        }),
      ).rejects.toThrow("copy boom");

      let copyCalls = 0;
      await extensionCommandTestOnly.copyExtensionDirectoryWithoutSelfNesting(sourceDir, sourceDir, async () => {
        copyCalls += 1;
      });
      expect(copyCalls).toBe(0);

      const mutableSettings = {
        extensions: {
          enabled: ["alpha"],
          disabled: ["alpha", "beta"],
        },
      };
      expect(extensionCommandTestOnly.clearExtensionState(mutableSettings as never, "alpha")).toBe(true);
      expect(mutableSettings.extensions.enabled).toEqual([]);
      expect(mutableSettings.extensions.disabled).toEqual(["beta"]);

      const sortableSettings = {
        extensions: {
          enabled: ["gamma", "alpha", "beta"],
          disabled: ["delta", "beta", "alpha"],
        },
      };
      expect(extensionCommandTestOnly.clearExtensionState(sortableSettings as never, "beta")).toBe(true);
      expect(sortableSettings.extensions.enabled).toEqual(["alpha", "gamma"]);
      expect(sortableSettings.extensions.disabled).toEqual(["alpha", "delta"]);

      const listResult = await extensionCommandTestOnly.listInstalledExtensions(
        path.join(tempRoot, "missing-extensions-root"),
        "project",
        mutableSettings as never,
        createEmptyManagedExtensionState(),
      );
      expect(listResult.extensions).toEqual([]);
      expect(listResult.warnings).toEqual([]);

      const managedMissingRoot = path.join(tempRoot, "managed-missing-root");
      const managedMissingDirectory = path.join(managedMissingRoot, "managed-missing");
      await mkdir(managedMissingDirectory, { recursive: true });
      const managedMissingState = upsertManagedEntry(createEmptyManagedExtensionState(), {
        name: "managed-missing",
        directory: "managed-missing",
        scope: "project",
        manifest_version: "1.0.0",
        manifest_entry: "index.js",
        capabilities: [],
        installed_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        source: {
          kind: "local",
          input: "./managed-missing",
          location: "./managed-missing",
        },
      });
      const managedMissingList = await extensionCommandTestOnly.listInstalledExtensions(
        managedMissingRoot,
        "project",
        {
          extensions: {
            enabled: ["managed-missing"],
            disabled: [],
          },
        } as never,
        managedMissingState,
      );
      expect(managedMissingList.extensions).toEqual([
        expect.objectContaining({
          name: "managed-missing",
          directory: "managed-missing",
          enabled: true,
          active: true,
        }),
      ]);
      expect(managedMissingList.warnings).toEqual(expect.arrayContaining(["extension_manifest_missing:project:managed-missing"]));

      const noReference = await extensionCommandTestOnly.checkGithubUpdate(
        {
          kind: "github",
          input: "owner/repo",
          location: ".",
          repository: "https://example.test/repo.git",
        } as never,
        async () => "\n\n",
      );
      expect(noReference).toMatchObject({
        available: null,
        error: "no_remote_reference_found",
      });
      const missingCommit = await extensionCommandTestOnly.checkGithubUpdate(
        {
          kind: "github",
          input: "owner/repo",
          location: ".",
          repository: "https://example.test/repo.git",
        } as never,
        async () => "0123456789abcdef\trefs/heads/main\n",
      );
      expect(missingCommit).toMatchObject({
        available: null,
        remote_commit: "0123456789abcdef",
        error: "missing_installed_commit",
      });
      const nonErrorFailure = await extensionCommandTestOnly.checkGithubUpdate(
        {
          kind: "github",
          input: "owner/repo",
          location: ".",
          repository: "https://example.test/repo.git",
        } as never,
        async () => {
          throw "runner-failed";
        },
      );
      expect(nonErrorFailure).toMatchObject({
        available: null,
        error: "runner-failed",
      });

      const readonlyRoot = path.join(tempRoot, "readonly-root");
      const readonlyLockRoot = path.join(readonlyRoot, "runtime", "extension-install-locks");
      await mkdir(readonlyLockRoot, { recursive: true });
      await chmod(readonlyLockRoot, 0o555);
      await expect(
        extensionCommandTestOnly.withExtensionInstallLock(readonlyRoot, "denied-ext", async () => "nope"),
      ).rejects.toBeTruthy();
      await chmod(readonlyLockRoot, 0o755);

      const busyRoot = path.join(tempRoot, "busy-root");
      const busyLockPath = path.join(busyRoot, "runtime", "extension-install-locks", "busy-ext.lock");
      await mkdir(busyLockPath, { recursive: true });
      await expect(
        extensionCommandTestOnly.withExtensionInstallLock(
          busyRoot,
          "busy-ext",
          async () => "never",
          {
            attempts: 2,
            delay_ms: 1,
          },
        ),
      ).rejects.toThrow(/Timed out waiting for extension install lock/);

      const cleanupRoot = path.join(tempRoot, "cleanup-root");
      const cleanupLockRoot = path.join(cleanupRoot, "runtime", "extension-install-locks");
      const cleanupResult = await extensionCommandTestOnly.withExtensionInstallLock(cleanupRoot, "cleanup-ext", async () => {
        await chmod(cleanupLockRoot, 0o555);
        return "cleanup-ok";
      });
      expect(cleanupResult).toBe("cleanup-ok");
      await chmod(cleanupLockRoot, 0o755);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("covers extension reload and adopt residual branches", async () => {
    await withTempPmPath(async (context) => {
      const brokenLoadDirectory = path.join(context.pmPath, "extensions", "broken-load");
      await mkdir(brokenLoadDirectory, { recursive: true });
      await writeFile(
        path.join(brokenLoadDirectory, "manifest.json"),
        `${JSON.stringify({ name: "broken-load", version: "1.0.0", entry: "index.js", capabilities: [] }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(path.join(brokenLoadDirectory, "index.js"), "export const broken = ;\n", "utf8");

      const brokenActivationDirectory = path.join(context.pmPath, "extensions", "broken-activation");
      await mkdir(brokenActivationDirectory, { recursive: true });
      await writeFile(
        path.join(brokenActivationDirectory, "manifest.json"),
        `${JSON.stringify({ name: "broken-activation", version: "1.0.0", entry: "index.js", capabilities: [] }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(brokenActivationDirectory, "index.js"),
        "module.exports = { activate() { throw new Error('activation boom'); } };\n",
        "utf8",
      );

      const brokenManifestDirectory = path.join(context.pmPath, "extensions", "broken-manifest");
      await mkdir(brokenManifestDirectory, { recursive: true });
      await writeFile(path.join(brokenManifestDirectory, "manifest.json"), "{\n", "utf8");

      await writeManagedExtensionState(path.join(context.pmPath, "extensions"), {
        version: 1,
        entries: [
          {
            name: "broken-load",
            directory: "broken-load",
            scope: "project",
            manifest_version: "1.0.0",
            manifest_entry: "index.js",
            capabilities: [],
            installed_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            source: {
              kind: "local",
              input: "./broken-load",
              location: brokenLoadDirectory,
            },
          },
          {
            name: "broken-activation",
            directory: "broken-activation",
            scope: "project",
            manifest_version: "1.0.0",
            manifest_entry: "index.js",
            capabilities: [],
            installed_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            source: {
              kind: "local",
              input: "./broken-activation",
              location: brokenActivationDirectory,
            },
          },
          {
            name: "broken-manifest",
            directory: "broken-manifest",
            scope: "project",
            manifest_version: "1.0.0",
            manifest_entry: "index.js",
            capabilities: [],
            installed_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            source: {
              kind: "local",
              input: "./broken-manifest",
              location: brokenManifestDirectory,
            },
          },
        ],
      });

      const positionalReload = await runExtension("reload", {}, { path: context.pmPath });
      const reloadDetails = positionalReload.details as {
        failed_extensions?: unknown[];
        activation_failures?: unknown[];
        failed_count?: number;
        activation_failed_count?: number;
      };
      expect(positionalReload.action).toBe("reload");
      expect(reloadDetails.failed_count ?? reloadDetails.failed_extensions?.length ?? 0).toBeGreaterThan(0);
      expect(
        (reloadDetails.failed_count ?? reloadDetails.failed_extensions?.length ?? 0) +
          (reloadDetails.activation_failed_count ?? reloadDetails.activation_failures?.length ?? 0),
      ).toBeGreaterThan(0);

      await expect(runExtension("missing-extension", { adopt: true, project: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("covers adopt-all same-name sorting and manage action branches", async () => {
    await withTempPmPath(async (context) => {
      const alphaDir = path.join(context.pmPath, "extensions", "alpha-dir");
      const betaDir = path.join(context.pmPath, "extensions", "beta-dir");
      await writeTestExtension({
        root: alphaDir,
        name: "shared-name",
      });
      await writeTestExtension({
        root: betaDir,
        name: "shared-name",
      });

      const adoptAll = await runExtension(undefined, { adoptAll: true, project: true }, { path: context.pmPath });
      expect(adoptAll.action).toBe("adopt-all");
      const adoptedDirectories = (
        adoptAll.details as { extensions?: Array<{ directory?: string }> }
      ).extensions?.map((entry) => entry.directory) ?? [];
      expect(adoptedDirectories).toEqual(["alpha-dir", "beta-dir"]);

      const managed = await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath });
      expect(managed.action).toBe("manage");
      expect(managed.details).toMatchObject({
        triage: expect.any(Object),
      });
    });
  });

  it("covers legacy bundled alias source and fallback alias discovery branches", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-bundled-legacy-"));
    const previousPackageRoot = process.env[PM_PACKAGE_ROOT_ENV];
    process.env[PM_PACKAGE_ROOT_ENV] = tempRoot;
    try {
      const legacyOnlyPath = path.join(tempRoot, ".agents", "pm", "extensions", "beads");
      await mkdir(legacyOnlyPath, { recursive: true });
      await writeFile(
        path.join(legacyOnlyPath, "manifest.json"),
        `${JSON.stringify({ name: "legacy-beads", version: "1.0.0", entry: "index.js" }, null, 2)}\n`,
        "utf8",
      );
      const legacyResolved = await resolveBundledExtensionAliasSource("beads");
      expect([
        legacyOnlyPath,
        path.join(process.cwd(), "packages", "pm-beads"),
      ]).toContain(legacyResolved);

      const packageRoot = path.join(tempRoot, "packages", "pm-beads");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify(
          {
            name: "@example/pm-beads-custom",
            version: "1.0.0",
            pm: {
              aliases: ["beads-custom"],
              extensions: ["extensions/beads-custom"],
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeTestExtension({ root: path.join(packageRoot, "extensions", "beads-custom"), name: "beads-custom-ext" });
      const aliases = await listBundledPackageAliases();
      expect(aliases).toEqual(expect.arrayContaining(["beads", "beads-custom"]));
    } finally {
      if (previousPackageRoot === undefined) {
        delete process.env[PM_PACKAGE_ROOT_ENV];
      } else {
        process.env[PM_PACKAGE_ROOT_ENV] = previousPackageRoot;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("covers extension doctor triage residual branches", () => {
    const runtimeState = applyDoctorRuntimeActivationState(
      [
        {
          name: "not-loaded-ext",
          enabled: true,
        },
      ] as never,
      {
        loaded: [],
        failed: [],
      } as never,
      {
        failed: [],
        registrations: { commands: [] },
        commands: { handlers: [], overrides: [] },
      } as never,
    );
    expect(runtimeState[0]).toMatchObject({
      activation_status: "not_loaded",
      runtime_active: false,
    });

    const invalidLayerRemediation = buildRegistrationCollisionRemediation(
      ["extension_command_handler_collision:surface:invalid-layer:alpha:project:beta"],
      {
        deactivate: "pm extension --deactivate <name> --project",
        doctor: "pm extension --doctor --project --detail deep --trace",
      },
    );
    expect(invalidLayerRemediation === null || invalidLayerRemediation.includes("Extension registration collisions")).toBe(true);

    expect(
      classifyDoctorActivationFailureWarnings([
        null as never,
        { name: "ext-z", trace: { capability: "search" } },
        { name: "ext-a", trace: { missing_capability: "schema" } },
      ]),
    ).toEqual([
      "extension_capability_missing:ext-a:schema",
      "extension_capability_missing:ext-z:search",
    ]);
    expect(classifyDoctorActivationFailureWarnings("invalid" as never)).toEqual([]);

    const triage = buildExtensionTriageSummary(
      "project",
      [
        "extension_command_handler_collision:cmd:project:ext-a:global:ext-b",
        "extension_command_handler_collision:cmd2:project:ext-a:global:ext-c",
      ],
      [
        {
          name: "ext-a",
          managed: true,
          enabled: true,
          active: true,
          update_available: false,
          update_check_status: "checked",
          command_paths: ["z", "a"],
          action_paths: ["beta", "alpha"],
        },
        {
          name: "ext-b",
          managed: false,
          enabled: true,
          active: true,
          update_available: false,
          update_check_status: "skipped_unmanaged",
          directory: "todos",
          command_paths: ["b", "a"],
          action_paths: [],
        },
        {
          name: "ext-c",
          managed: false,
          enabled: true,
          active: true,
          update_available: false,
          update_check_status: "skipped_unmanaged",
          directory: "beads",
          command_paths: ["c"],
          action_paths: [],
        },
      ] as never,
      {},
    );
    expect(triage.warning_count).toBeGreaterThan(0);
    expect(triage.unmanaged_expected_extensions).toEqual(["ext-b", "ext-c"]);
    expect(triage.remediation.some((entry) => entry.includes("collisions"))).toBe(true);

    const globalCollisionTriage = buildExtensionTriageSummary(
      "global",
      ["extension_command_handler_collision:cmd:global:unknown-a:project:unknown-b"],
      [] as never,
      {},
    );
    const collisionPlan = (globalCollisionTriage as {
      collision_plan?: {
        next_best_command?: string;
        remediation_candidates?: unknown[];
      };
    }).collision_plan;
    expect(collisionPlan?.next_best_command?.includes("--global") ?? true).toBe(true);
    if (collisionPlan?.remediation_candidates) {
      expect(collisionPlan.remediation_candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ extension: "unknown-a" }),
          expect.objectContaining({ extension: "unknown-b" }),
        ]),
      );
    }

    const blockedPolicyTriage = buildExtensionTriageSummary(
      "project",
      ["extension_policy_blocked_capability:ext-a:search"],
      [] as never,
      {},
    );
    expect(blockedPolicyTriage.policy_blocked_count).toBe(1);
    const neutralPolicyTriage = buildExtensionTriageSummary(
      "project",
      ["extension_policy_notice:ext-a"],
      [] as never,
      {},
    );
    expect(neutralPolicyTriage.policy_warning_count).toBe(1);
  });

  it("sorts activation failure diagnostics deterministically", () => {
    const diagnostics = extensionCommandTestOnly.collectActivationFailureDiagnostics([
      {
        layer: "project",
        name: "zeta",
        entry_path: "/tmp/zeta/index.js",
        error: "zeta failed",
      },
      {
        layer: "global",
        name: "alpha",
        entry_path: "/tmp/alpha/index.js",
        error: "alpha failed",
        trace: {
          method: "registerItemFields",
          registration_index: 1,
          expected_schema: "item_fields",
          missing_capability: "schema",
          hint: "Add schema capability.",
        },
      },
      {
        layer: "project",
        name: "beta",
        entry_path: "/tmp/beta/index.js",
        error: "beta failed",
        trace: {
          method: "registerCommand",
          registration_index: 2,
          expected_schema: "commands",
          command: "beta ping",
          capability: "commands",
        },
      },
    ] as never);
    expect(diagnostics.map((entry: { layer: string; name: string }) => `${entry.layer}:${entry.name}`)).toEqual([
      "global:alpha",
      "project:beta",
      "project:zeta",
    ]);
    expect(diagnostics[0]).toMatchObject({
      missing_capability: "schema",
      hint: "Add schema capability.",
      trace: expect.objectContaining({
        method: "registerItemFields",
        missing_capability: "schema",
      }),
    });
    expect(diagnostics[1]).toMatchObject({
      name: "beta",
      trace: expect.objectContaining({
        command: "beta ping",
        capability: "commands",
      }),
    });
    expect(diagnostics[1]).not.toHaveProperty("hint");
  });

  it("parses, validates, coerces, and strips loose extension command options", () => {
    const definitions = [
      { long: "--count", short: "-c", value_type: "number", required: true },
      { long: "--enabled", value_type: "boolean", default: "true" },
      { long: "--label", type: "string", default: 42 },
      { long: "--tag", short: "-t", value_type: "string", list: true, default: "triage, coverage" },
      { long: "--disabled", enabled: false },
      { long: "--constructor" },
      { short: "-x", value_type: "number" },
    ];

    expect(collectLooseCommandOptionKeysForDefinitions(definitions)).toEqual(
      new Set(["count", "c", "enabled", "label", "tag", "t", "disabled", "x"]),
    );

    const parsed = parseLooseCommandOptions([
      "--count",
      "2",
      "-t=alpha,beta",
      "--tag",
      "gamma",
      "--no-enabled",
      "-x",
      "5",
      "--constructor",
      "ignored",
      "--",
      "--label",
      "positional",
    ]);
    expect(parsed).toMatchObject({
      count: "2",
      tag: "gamma",
      t: "alpha,beta",
      enabled: false,
      x: "5",
      label: "positional",
    });
    expect(Object.hasOwn(parsed, "constructor")).toBe(false);

    const coerced = coerceLooseCommandOptionsWithFlagDefinitions(parsed, definitions);
    expect(coerced).toMatchObject({
      count: 2,
      enabled: false,
      label: "positional",
      tag: ["gamma"],
      x: 5,
    });

    const defaulted = coerceLooseCommandOptionsWithFlagDefinitions({ count: "3", t: ["one,two", "three"] }, definitions);
    expect(defaulted).toMatchObject({
      count: 3,
      enabled: true,
      label: "42",
      tag: ["one", "two", "three"],
    });
    expect(Object.hasOwn(defaulted, "t")).toBe(false);

    expect(
      stripLooseCommandOptionTokens(
        ["run", "--count", "9", "--enabled", "positional", "--tag=one,two", "-x", "7", "--", "--count", "kept"],
        definitions,
      ),
    ).toEqual(["run", "positional", "--count", "kept"]);
    expect(stripLooseCommandOptionTokens(["--count", "1"], [])).toEqual(["--count", "1"]);
    expect(stripLooseCommandOptionTokens(["--other", "value"], [{ long: "--constructor" }])).toEqual(["--other", "value"]);

    expect(() => validateLooseCommandOptionsWithFlagDefinitions({ missing: true }, definitions, "demo run")).toThrow(
      /Unknown option '--missing'/,
    );
    expect(() => validateLooseCommandOptionsWithFlagDefinitions({ disabled: true, count: 1 }, definitions, "demo run")).toThrow(
      /Option '--disabled' is disabled/,
    );
    expect(() => validateLooseCommandOptionsWithFlagDefinitions({}, definitions, "demo run")).toThrow(
      /Missing required option '--count'/,
    );
    expect(() => validateLooseCommandOptionsWithFlagDefinitions({ count: 1 }, definitions, "demo run")).not.toThrow();
  });

  it("covers loose extension option helper fallbacks and repeated short flags", () => {
    const parsed = parseLooseCommandOptions(["-n=value", "-n", "next", "-v", "--empty=", "--no-active"]);
    expect(parsed).toMatchObject({
      n: ["value", "next"],
      v: true,
      empty: "",
      active: false,
    });

    const noDefinitionsOptions = { raw: "value" };
    expect(coerceLooseCommandOptionsWithFlagDefinitions(noDefinitionsOptions, [])).toBe(noDefinitionsOptions);
    expect(
      coerceLooseCommandOptionsWithFlagDefinitions(
        { plain: "value", count: Number.POSITIVE_INFINITY, active: "0", maybe: "false", emptyNumber: "" },
        [
          { long: "--plain" },
          { long: "--count", value_type: "number" },
          { long: "--active", value_type: "boolean" },
          { long: "--maybe", value_type: "boolean" },
          { long: "--empty-number", value_type: "number" },
          { long: "--tags", list: true, default: ["one,two", "three"] },
        ],
      ),
    ).toMatchObject({
      plain: "value",
      count: Number.POSITIVE_INFINITY,
      active: false,
      maybe: false,
      emptyNumber: "",
      tags: ["one", "two", "three"],
    });

    expect(
      stripLooseCommandOptionTokens(["--enabled", "kept", "--name", "removed"], [
        { long: "--enabled", value_type: "boolean" },
        { long: "--name", value_type: "string" },
      ]),
    ).toEqual(["kept"]);
  });

  it("normalizes managed extension state helpers across tie-breakers and source variants", () => {
    const baseEntry = {
      name: "Alpha",
      directory: "b-dir",
      scope: "project" as const,
      manifest_version: "1.0.0",
      manifest_entry: "index.js",
      capabilities: ["schema", "commands", "commands"],
      installed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      source: { kind: "local" as const, input: "./alpha", location: "/tmp/alpha" },
    };

    const normalized = normalizeManagedState({
      version: 1,
      entries: [
        "bad",
        { ...baseEntry, source: { kind: "bad", input: "./bad", location: "/tmp/bad" } },
        { ...baseEntry, name: "Alpha", directory: "a-dir" },
      ],
    });
    expect(normalized?.entries).toEqual([
      expect.objectContaining({
        name: "Alpha",
        directory: "a-dir",
        capabilities: ["commands", "schema"],
      }),
    ]);

    expect(
      managedExtensionSourcesEquivalent(
        { kind: "local", input: "one", location: "/tmp/one" },
        { kind: "local", input: "two", location: "/tmp/one" },
      ),
    ).toBe(false);
    expect(
      managedExtensionSourcesEquivalent(
        { kind: "builtin", input: "guide", location: "builtin", name: "guide-shell" },
        { kind: "builtin", input: "guide", location: "builtin", name: "other" },
      ),
    ).toBe(false);
    expect(
      managedExtensionSourcesEquivalent(
        { kind: "local", input: "same", location: "/tmp/same" },
        { kind: "local", input: "same", location: "/tmp/same" },
      ),
    ).toBe(true);
  });

  it("parses local and GitHub install sources deterministically", () => {
    const local = parseExtensionInstallSource("./extensions/sample");
    expect(local.kind).toBe("local");
    expect(local.absolute_path).toBe(path.resolve(process.cwd(), "./extensions/sample"));

    const githubTree = parseExtensionInstallSource(
      "https://github.com/unbraind/pm-cli/tree/main/.agents/pm/extensions/sample",
    );
    expect(githubTree).toMatchObject({
      kind: "github",
      owner: "unbraind",
      repo: "pm-cli",
      ref: "main",
      subpath: ".agents/pm/extensions/sample",
    });

    const githubDomain = parseExtensionInstallSource("github.com/unbraind/pm-cli/sample");
    expect(githubDomain).toMatchObject({
      kind: "github",
      owner: "unbraind",
      repo: "pm-cli",
      subpath: "sample",
    });

    const githubFlag = parseExtensionInstallSource("unbraind/pm-cli/sample", { forceGithub: true, ref: "main" });
    expect(githubFlag).toMatchObject({
      kind: "github",
      owner: "unbraind",
      repo: "pm-cli",
      ref: "main",
      subpath: "sample",
    });

    expect(parseExtensionInstallSource("https://github.com/unbraind/pm-cli.git")).toMatchObject({
      kind: "github",
      owner: "unbraind",
      repo: "pm-cli",
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

  it("covers install-source and manifest parser edge cases without network access", async () => {
    expect(() => parseExtensionInstallSource("npm:")).toThrowError(/must include a package spec/);
    expect(() => parseExtensionInstallSource("npm:pm-example", { forceGithub: true })).toThrowError(
      /cannot be combined with npm:/,
    );
    expect(() => parseExtensionInstallSource("npm:pm-example", { ref: "main" })).toThrowError(
      /cannot be combined with npm:/,
    );
    expect(parseExtensionInstallSource("github.com/unbraind/pm-cli/tree/main/extensions/demo", { ref: "release" })).toMatchObject({
      kind: "github",
      repo: "pm-cli",
      ref: "release",
      subpath: "extensions/demo",
    });

    expect(parseExtensionManifest(null)).toBeNull();
    expect(parseExtensionManifest({ name: "", version: "1.0.0", entry: "index.js" })).toBeNull();
    expect(parseExtensionManifest({ name: "demo", version: "", entry: "index.js" })).toBeNull();
    expect(parseExtensionManifest({ name: "demo", version: "1.0.0", entry: "" })).toBeNull();
    expect(parseExtensionManifest({ name: "demo", version: "1.0.0", entry: "index.js", priority: 1.5 })).toBeNull();
    expect(parseExtensionManifest({ name: "demo", version: "1.0.0", entry: "index.js", capabilities: "commands" })).toBeNull();
    expect(parseExtensionManifest({ name: "demo", version: "1.0.0", entry: "index.js", capabilities: ["commands", 1] })).toBeNull();
    expect(parseExtensionManifest({ name: "demo", version: "1.0.0", entry: "index.js", capabilities: ["Commands", "commands", ""] }))
      .toMatchObject({
        name: "demo",
        priority: 100,
        capabilities: ["commands"],
      });
    expect(normalizeManagedDirectoryName(" Demo Extension! ")).toBe("demo-extension");
    expect(() => normalizeManagedDirectoryName("!!!")).toThrow(/non-empty directory name/);
    expect(() => normalizeManagedDirectoryName(".")).toThrow(/must not resolve/);

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-validate-"));
    try {
      const missingManifestDir = path.join(tempRoot, "missing-manifest");
      await mkdir(missingManifestDir, { recursive: true });
      await expect(validateExtensionDirectory(missingManifestDir)).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });

      const badJsonDir = path.join(tempRoot, "bad-json");
      await mkdir(badJsonDir, { recursive: true });
      await writeFile(path.join(badJsonDir, "manifest.json"), "{ nope", "utf8");
      await expect(validateExtensionDirectory(badJsonDir)).rejects.toThrow(/Failed to parse extension manifest/);

      const invalidManifestDir = path.join(tempRoot, "invalid-manifest");
      await mkdir(invalidManifestDir, { recursive: true });
      await writeFile(path.join(invalidManifestDir, "manifest.json"), JSON.stringify({ name: "invalid" }), "utf8");
      await expect(validateExtensionDirectory(invalidManifestDir)).rejects.toThrow(/is invalid/);

      const missingEntryDir = path.join(tempRoot, "missing-entry");
      await mkdir(missingEntryDir, { recursive: true });
      await writeFile(
        path.join(missingEntryDir, "manifest.json"),
        JSON.stringify({ name: "missing-entry", version: "1.0.0", entry: "index.js" }),
        "utf8",
      );
      await expect(validateExtensionDirectory(missingEntryDir)).rejects.toThrow(/Extension entry file is missing/);

      const outsideEntryDir = path.join(tempRoot, "outside-entry");
      await mkdir(outsideEntryDir, { recursive: true });
      await writeFile(
        path.join(outsideEntryDir, "manifest.json"),
        JSON.stringify({ name: "outside-entry", version: "1.0.0", entry: "../escape.js" }),
        "utf8",
      );
      await expect(validateExtensionDirectory(outsideEntryDir)).rejects.toThrow(/resolves outside extension directory/);

      const validDir = path.join(tempRoot, "valid");
      await writeTestExtension({ root: validDir, name: "valid-ext" });
      await expect(validateExtensionDirectory(validDir)).resolves.toMatchObject({
        directory: validDir,
        manifest: { name: "valid-ext", version: "1.0.0", entry: "index.js" },
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("covers npm install-source helper branches without registry access", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-install-source-helpers-"));
    try {
      const packageRoot = path.join(tempRoot, "package-root");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "pm-helper-package",
          version: "1.2.3",
          dependencies: {
            leftpad: " 1.0.0 ",
            skipped: "",
          },
          optionalDependencies: {
            leftpad: "2.0.0",
            optional: "^3.0.0",
          },
          peerDependencies: {
            peer: "~4.0.0",
          },
        }),
        "utf8",
      );

      expect(_testOnlyInstallSources.runtimeDependencyInstallSpecs({ dependencies: "bad" })).toEqual([]);
      expect(
      _testOnlyInstallSources.runtimeDependencyInstallSpecs({
          dependencies: { leftpad: " 1.0.0 ", skipped: "", bad: 1 },
          optionalDependencies: { leftpad: "2.0.0", optional: "^3.0.0" },
          peerDependencies: { peer: "~4.0.0" },
        }),
      ).toEqual(["leftpad@1.0.0", "optional@^3.0.0", "peer@~4.0.0"]);
      expect(wrapNpmPackResolutionError("pm-helper-package", new Error("permission denied"))).toBeNull();
    expect(_testOnlyInstallSources.npmPackageNameFromSpec("@scope/pkg@1.2.3")).toBe("@scope/pkg");
    expect(_testOnlyInstallSources.npmPackageNameFromSpec("alias@file:../pkg")).toBe("alias");
      expect(_testOnlyInstallSources.npmPackageNameFromSpec("@broken")).toBe("@broken");
      expect(_testOnlyInstallSources.npmPackageNameFromSpec("   ")).toBe("");
      expect(isNpmNotFoundError("npm ERR! code E404 404 Not Found")).toBe(true);
      expect(isNpmPackNotFoundError("resource was NOT FOUND")).toBe(true);
      expect(buildNpmNotFoundRecovery("pm-helper-package").context.recovery?.next_best_command).toBe(
        "pm install --project github.com/unbraind/pm-helper-package",
      );
      expect(() => parseExtensionInstallSource("owner/.git", { forceGithub: true })).toThrow(/GitHub/);

      await expect(
        runGitCommand(["status"], async () => ({ stdout: undefined, stderr: "" } as never)),
      ).resolves.toBe("");
      await expect(
        runGitCommand(["status"], async () => {
          throw "git-string-error";
        }),
      ).rejects.toThrow(/git-string-error/);

      const runtimeDepRoot = path.join(tempRoot, "runtime-dep");
      await mkdir(runtimeDepRoot, { recursive: true });
      await writeFile(
        path.join(runtimeDepRoot, "package.json"),
        JSON.stringify({ name: "runtime-dep", version: "1.0.0", main: "index.js" }),
        "utf8",
      );
      await writeFile(path.join(runtimeDepRoot, "index.js"), "module.exports = { ok: true };\n", "utf8");
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "pm-helper-package",
          version: "1.2.3",
          dependencies: { "runtime-dep": `file:${runtimeDepRoot}` },
          devDependencies: { "dev-only": "1.0.0" },
        }),
        "utf8",
      );
      await writeFile(path.join(packageRoot, "package-lock.json"), "{}\n", "utf8");
      await writeFile(path.join(packageRoot, "npm-shrinkwrap.json"), "{}\n", "utf8");
      await _testOnlyInstallSources.installNpmPackageRuntimeDependencies(packageRoot);
      const rewrittenPackageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
      expect(rewrittenPackageJson.devDependencies).toBeUndefined();
      await expect(readdir(path.join(packageRoot, "node_modules", "runtime-dep"))).resolves.toEqual(
        expect.arrayContaining(["index.js", "package.json"]),
      );
      await expect(readFile(path.join(packageRoot, "package-lock.json"), "utf8")).rejects.toThrow();
      await expect(readFile(path.join(packageRoot, "npm-shrinkwrap.json"), "utf8")).rejects.toThrow();

      const missingManifestRoot = path.join(tempRoot, "missing-package-json");
      await mkdir(missingManifestRoot, { recursive: true });
      await expect(_testOnlyInstallSources.installNpmPackageRuntimeDependencies(missingManifestRoot)).resolves.toBeUndefined();

      const invalidManifestRoot = path.join(tempRoot, "invalid-package-json");
      await mkdir(invalidManifestRoot, { recursive: true });
      await writeFile(path.join(invalidManifestRoot, "package.json"), "{ nope", "utf8");
      await expect(_testOnlyInstallSources.installNpmPackageRuntimeDependencies(invalidManifestRoot)).resolves.toBeUndefined();

      const primitiveManifestRoot = path.join(tempRoot, "primitive-package-json");
      await mkdir(primitiveManifestRoot, { recursive: true });
      await writeFile(path.join(primitiveManifestRoot, "package.json"), '"not-object"\n', "utf8");
      await expect(_testOnlyInstallSources.installNpmPackageRuntimeDependencies(primitiveManifestRoot)).resolves.toBeUndefined();

      expect(_testOnlyInstallSources.npmPackageNameFromSpec("@scope/pkg@file:../pkg")).toBe("@scope/pkg");
      expect(_testOnlyInstallSources.npmPackageNameFromSpec("plain@1.0.0")).toBe("plain");
      expect(
        _testOnlyInstallSources.parsePackedNpmPackage(
          JSON.stringify([{ filename: "pkg-1.0.0.tgz", name: "pkg", version: "1.0.0" }]),
          tempRoot,
        ),
      ).toEqual({
        tarball: path.join(tempRoot, "pkg-1.0.0.tgz"),
        package: "pkg",
        version: "1.0.0",
      });
      expect(_testOnlyInstallSources.parsePackedNpmPackage("npm notice\nlegacy.tgz\n", tempRoot)).toEqual({
        tarball: path.join(tempRoot, "legacy.tgz"),
      });
      expect(
        _testOnlyInstallSources.parsePackedNpmPackage(
          JSON.stringify({ filename: "not-an-array.tgz" }),
          tempRoot,
        ),
      ).toEqual({
        tarball: path.join(tempRoot, '{"filename":"not-an-array.tgz"}'),
      });
      expect(
        _testOnlyInstallSources.parsePackedNpmPackage(
          JSON.stringify([{ filename: "pkg-2.0.0.tgz", name: 42, version: false }]),
          tempRoot,
        ),
      ).toEqual({
        tarball: path.join(tempRoot, "pkg-2.0.0.tgz"),
      });
      expect(() => _testOnlyInstallSources.parsePackedNpmPackage("\n", tempRoot)).toThrow(/did not report/);
      await expect(_testOnlyInstallSources.runNpmCommand(["--version"], path.join(tempRoot, "missing-cwd"))).rejects.toThrow(
        /npm command failed:/,
      );
      await expect(
        _testOnlyInstallSources.runNpmCommand(
          ["--version"],
          undefined,
          async () => ({ stdout: undefined, stderr: "" } as never),
        ),
      ).resolves.toBe("");
      await expect(
        _testOnlyInstallSources.runNpmCommand(["--version"], undefined, async () => {
          throw "npm-string-error";
        }),
      ).rejects.toThrow(/npm-string-error/);

      await writeTestExtension({
        root: packageRoot,
        directory: "extensions/only",
        manifestOverrides: { name: "only-ext" },
      });
      await expect(_testOnlyInstallSources.resolvePackageExtensionDirectory(packageRoot, "pkg")).resolves.toBe(
        path.join(packageRoot, "extensions/only"),
      );
      const localResolved = await _testOnlyInstallSources.resolveNpmSourceDirectory({
        kind: "npm",
        input: `npm:${packageRoot}`,
        spec: packageRoot,
      });
      await expect(localResolved.cleanup()).resolves.toBeUndefined();

      const localNoPackageJsonRoot = path.join(tempRoot, "local-no-package-json");
      await writeTestExtension({
        root: localNoPackageJsonRoot,
        directory: "extensions/only",
        manifestOverrides: { name: "local-no-package-json-ext" },
      });
      const localNoPackageJsonResolved = await _testOnlyInstallSources.resolveNpmSourceDirectory({
        kind: "npm",
        input: `npm:${localNoPackageJsonRoot}`,
        spec: localNoPackageJsonRoot,
      });
      expect(localNoPackageJsonResolved.package).toBeUndefined();
      expect(localNoPackageJsonResolved.version).toBeUndefined();
      await expect(localNoPackageJsonResolved.cleanup()).resolves.toBeUndefined();

      const emptyPackageRoot = path.join(tempRoot, "empty-package");
      await mkdir(emptyPackageRoot, { recursive: true });
      await expect(_testOnlyInstallSources.resolvePackageExtensionDirectory(emptyPackageRoot, "empty")).rejects.toThrow(
        /Unable to locate a pm extension manifest/,
      );

      const multiPackageRoot = path.join(tempRoot, "multi-package");
      await writeTestExtension({
        root: multiPackageRoot,
        directory: "extensions/b",
        manifestOverrides: { name: "b-ext" },
      });
      await writeTestExtension({
        root: multiPackageRoot,
        directory: "extensions/a",
        manifestOverrides: { name: "a-ext" },
      });
      await expect(_testOnlyInstallSources.resolvePackageExtensionDirectory(multiPackageRoot, "multi")).rejects.toThrow(
        /Candidates: extensions\/a, extensions\/b/,
      );

      const cwd = process.cwd();
      process.chdir(tempRoot);
      try {
        const resolvedRelativePackSpec = await _testOnlyInstallSources.resolveNpmPackSpec("./package-root");
        await expect(realpath(fileURLToPath(resolvedRelativePackSpec))).resolves.toBe(await realpath(packageRoot));
        await expect(_testOnlyInstallSources.resolveNpmPackSpec("./missing-package-root")).resolves.toBe(
          "./missing-package-root",
        );
        await expect(_testOnlyInstallSources.resolveNpmPackSpec("alias@file:")).resolves.toBe("alias@file:");
        await expect(_testOnlyInstallSources.resolveNpmPackSpec("alias@file://server/share")).resolves.toBe(
          "alias@file://server/share",
        );
        const resolvedFileUrlPackSpec = await _testOnlyInstallSources.resolveNpmPackSpec(pathToFileURL(packageRoot).href);
        await expect(realpath(fileURLToPath(resolvedFileUrlPackSpec))).resolves.toBe(await realpath(packageRoot));
        const missingFileUrlSpec = pathToFileURL(path.join(tempRoot, "missing-file-url-package")).href;
        await expect(_testOnlyInstallSources.resolveNpmPackSpec(missingFileUrlSpec)).resolves.toBe(missingFileUrlSpec);
        await expect(_testOnlyInstallSources.resolveNpmPackSpec("alias@file:./package-root")).resolves.toBe(
          `alias@${pathToFileURL(packageRoot).href}`,
        );
        expect(normalizeNpmLocalFileAliasSpec("alias@file:/tmp/pm-absolute-path")).toBe(
          `alias@${pathToFileURL("/tmp/pm-absolute-path").href}`,
        );
        await expect(_testOnlyInstallSources.resolveNpmPackSpec("https://registry.example/pkg.tgz")).resolves.toBe(
          "https://registry.example/pkg.tgz",
        );
        await expect(_testOnlyInstallSources.resolveNpmPackSpec("pm-package")).resolves.toBe("pm-package");
      } finally {
        process.chdir(cwd);
      }

      await expect(
        _testOnlyInstallSources.resolveNpmSourceDirectory({
          kind: "npm",
          input: "npm:./definitely-missing-package-root",
          spec: "./definitely-missing-package-root",
        }),
      ).rejects.toThrow();
      await expect(
        _testOnlyInstallSources.resolveNpmSourceDirectoryWithRunner(
          {
            kind: "npm",
            input: "npm:pm-missing-helper",
            spec: "pm-missing-helper",
          },
          async () => {
            throw new Error("npm ERR! code E404 404 Not Found");
          },
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("builds bundled package catalog entries from a temporary package root", async () => {
    await withTempPmPath(async (context) => {
      const previousPackageRoot = process.env[PM_PACKAGE_ROOT_ENV];
      const packageRoot = path.join(context.tempRoot, "package-root");
      const bundledPackageRoot = path.join(packageRoot, "packages", "pm-wave");
      const extensionRoot = path.join(bundledPackageRoot, "extensions", "wave");
      process.env[PM_PACKAGE_ROOT_ENV] = packageRoot;
      try {
        await mkdir(extensionRoot, { recursive: true });
        await writeFile(
          path.join(bundledPackageRoot, "package.json"),
          JSON.stringify({
            name: "@example/pm-wave",
            version: "1.2.3",
            description: "Wave package",
            private: false,
            keywords: ["wave", "coverage"],
            homepage: "https://example.test/wave",
            repository: { url: "https://example.test/repo.git" },
            bugs: { url: "https://example.test/issues" },
            pm: {
              aliases: ["wave", "Wave"],
              extensions: ["extensions/wave"],
              docs: ["README.md"],
              examples: ["examples/demo.md"],
              catalog: {
                display_name: "Wave",
                category: "testing",
                summary: "Catalog summary",
                links: {
                  docs: "https://example.test/docs",
                },
                media: {
                  image: "https://example.test/image.png",
                },
                tags: ["catalog"],
              },
            },
          }),
          "utf8",
        );
        await writeFile(
          path.join(extensionRoot, "manifest.json"),
          JSON.stringify({ name: "wave-extension", version: "1.0.0", entry: "./index.js" }),
          "utf8",
        );
        await writeFile(path.join(extensionRoot, "index.js"), "export function activate() {}\n", "utf8");

        await expect(resolveBundledExtensionAliasSource("wave")).resolves.toBe(bundledPackageRoot);
        await expect(resolveBundledAliasManifestName("wave")).resolves.toBe("wave-extension");

        const legacyBeadsSource = path.join(packageRoot, "legacy-beads-source");
        await mkdir(legacyBeadsSource, { recursive: true });
        await writeFile(
          path.join(legacyBeadsSource, "package.json"),
          JSON.stringify({
            name: "@example/pm-beads",
            version: "1.0.0",
            pm: {
              extensions: [],
            },
          }),
          "utf8",
        );
        const legacyPackageRoot = path.join(packageRoot, "packages", "pm-beads");
        await symlink(legacyBeadsSource, legacyPackageRoot);
        const beadsSource = await resolveBundledExtensionAliasSource("beads");
        expect([legacyPackageRoot, path.join(process.cwd(), "packages", "pm-beads")]).toContain(beadsSource);

        await mkdir(path.join(packageRoot, "packages", "not-a-bundle"), { recursive: true });
        await writeFile(path.join(packageRoot, "packages", "pm-no-manifest"), "not a directory", "utf8");
        await mkdir(path.join(packageRoot, "packages", "pm-empty-package"), { recursive: true });
        const legacyExtensionRoot = path.join(packageRoot, ".agents", "pm", "extensions", "todos");
        await mkdir(legacyExtensionRoot, { recursive: true });
        await writeFile(
          path.join(legacyExtensionRoot, "manifest.json"),
          JSON.stringify({ name: "todos-extension", version: "1.0.0", entry: "index.js" }),
          "utf8",
        );
        const todosSource = await resolveBundledExtensionAliasSource("todos");
        expect([legacyExtensionRoot, path.join(process.cwd(), "packages", "pm-todos")]).toContain(todosSource);
        await expect(resolveBundledExtensionAliasSource("unknown-alias")).resolves.toBeNull();

        const beforeInstall = await buildBundledPackageCatalog("project", { path: context.pmPath });
        expect(beforeInstall.packages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              alias: "wave",
              available: true,
              installed: false,
              package_name: "@example/pm-wave",
              package_version: "1.2.3",
              description: "Catalog summary",
              catalog: expect.objectContaining({
                links: expect.objectContaining({
                  docs: "https://example.test/docs",
                  npm: "https://www.npmjs.com/package/%40example%2Fpm-wave",
                }),
              }),
              install_command: "pm install wave --project",
            }),
          ]),
        );
        const globalCatalog = await buildBundledPackageCatalog("global", { path: context.pmPath });
        expect(globalCatalog.scope).toBe("global");
        expect(globalCatalog.packages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              alias: "wave",
              install_command: "pm install wave --global",
            }),
          ]),
        );

        await writeManagedExtensionState(path.join(context.pmPath, "extensions"), {
          version: 1,
          entries: [
            {
              name: "wave-extension",
              directory: "wave-extension",
              scope: "project",
              manifest_version: "1.0.0",
              manifest_entry: "./index.js",
              capabilities: [],
              installed_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              source: { kind: "builtin", input: "wave", location: "wave", name: "wave" },
            },
          ],
        });
        const afterInstall = await buildBundledPackageCatalog("project", { path: context.pmPath });
        expect(afterInstall.packages).toEqual(
          expect.arrayContaining([expect.objectContaining({ alias: "wave", installed: true })]),
        );
      } finally {
        if (previousPackageRoot === undefined) {
          delete process.env[PM_PACKAGE_ROOT_ENV];
        } else {
          process.env[PM_PACKAGE_ROOT_ENV] = previousPackageRoot;
        }
      }
    });
  });

  it("summarizes doctor runtime status and remediation branches", () => {
    const extensions = applyDoctorRuntimeActivationState(
      [
        {
          name: "blank-command-ext",
          directory: "blank-command-ext",
          version: "1.0.0",
          entry: "index.js",
          scope: "project",
          active: true,
          enabled: true,
          runtime_active: null,
          activation_status: "unknown",
          managed: true,
          update_check_status: "failed",
          update_check_reason: "network",
        },
        {
          name: "disabled-ext",
          directory: "disabled-ext",
          version: "1.0.0",
          entry: "index.js",
          scope: "project",
          active: false,
          enabled: false,
          runtime_active: null,
          activation_status: "unknown",
          managed: false,
          update_check_status: "skipped_unmanaged",
          update_check_reason: "unmanaged",
        },
      ],
      {
        loaded: [{ layer: "project", name: "blank-command-ext" }],
        failed: [],
      } as never,
      {
        failed: [],
        registrations: { commands: [{ name: " ", command: " ", action: " " }] },
        commands: {
          handlers: [{ name: "blank-command-ext", command: " " }],
          overrides: [{ name: "blank-command-ext", command: " " }],
        },
      } as never,
    );

    expect(extensions).toEqual([
      expect.objectContaining({ name: "blank-command-ext", runtime_active: true, activation_status: "ok" }),
      expect.objectContaining({ name: "disabled-ext", runtime_active: false, activation_status: "not_loaded" }),
    ]);

    const contract = buildCapabilityContractMetadata();
    expect(contract.capabilities).toEqual(expect.arrayContaining(["commands", "schema"]));
    expect(contract.legacy_aliases).toMatchObject({ migration: "schema", validation: "schema" });

    const triage = buildExtensionTriageSummary(
      "project",
      [
        "extension_capability_legacy_alias:project:legacy:migration->schema",
        "extension_capability_missing:blank-command-ext:schema",
        "extension_command_definition_legacy_handler_alias:project:blank-command-ext:sync",
        "extension_load_failed_module_mode_mismatch:project:esm-ext",
        "extension_manager_state_invalid_json:project",
        "extension_pm_min_version_unsatisfied:project:old-ext:required=>=9.0.0:current=1.0.0",
        "extension_policy_violation_registration:project:policy-ext:reason=surface_blocked",
        "extension_update_check_failed:blank-command-ext",
      ],
      extensions,
      { doctor: true },
    );

    expect(triage.warning_codes).toEqual(expect.arrayContaining([
      "extension_capability_legacy_alias",
      "extension_command_definition_legacy_handler_alias",
      "extension_manager_state_invalid_json",
      "extension_pm_min_version_unsatisfied",
      "extension_update_check_failed",
    ]));
    expect(triage.remediation).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Legacy extension capability aliases"),
        expect.stringContaining("Extension command definitions using legacy handler"),
        expect.stringContaining("Extension pm version-bound warnings"),
        expect.stringContaining("Review and repair project managed extension state file"),
        expect.stringContaining("Run pm extension --manage --project after validating network"),
      ]),
    );
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
      await writeTestExtension({
        root: sourceDir,
        name: "reload-source-ext",
        manifestOverrides: {
          entry: "./index.js",
        },
      });

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
      // pm-fl0c B-1 (2026-05-28) + Codex P2 follow-up: extension-only scaffold
      // must NOT import `@unbrained/pm-cli/sdk` (no package.json with the dep
      // → ERR_MODULE_NOT_FOUND when the loader imports the file URL). Instead
      // it emits the original `export function activate(api)` shape with a
      // JSDoc @param hint so editors still narrow the api parameter.
      expect(entry).not.toContain('import { defineExtension }');
      expect(entry).toContain('@param {import("@unbrained/pm-cli/sdk").ExtensionApi}');
      expect(entry).toContain("export function activate(api)");
      expect(entry).toContain("export default {");
      expect(entry).toContain('name: "starter-ext ping"');

      const rerun = await runExtension(scaffoldPath, { scaffold: true, project: true }, { path: context.pmPath });
      const rerunFiles = (rerun.details as { files?: Array<{ status: string }> }).files ?? [];
      expect(rerunFiles.length).toBeGreaterThan(0);
      expect(rerunFiles.every((entry) => entry.status === "unchanged")).toBe(true);
    });
  });

  it("scaffolds package-root metadata via package init while keeping installable extension resources", async () => {
    await withTempPmPath(async (context) => {
      const scaffoldPath = path.join(context.tempRoot, "starter-package");
      const scaffold = await runExtension(scaffoldPath, {
        init: true,
        project: true,
        vocabulary: "package",
      }, { path: context.pmPath });
      expect(scaffold.action).toBe("init");
      expect(scaffold.details).toMatchObject({
        extension: {
          name: "starter-package",
          command: "starter-package ping",
        },
        target_path: scaffoldPath,
        created_directory: true,
      });

      const packageJson = JSON.parse(await readFile(path.join(scaffoldPath, "package.json"), "utf8")) as Record<string, unknown>;
      expect(packageJson).toMatchObject({
        name: "pm-starter-package",
        private: true,
        type: "module",
        pm: {
          aliases: ["starter-package"],
          extensions: ["."],
          docs: ["README.md"],
          examples: ["README.md"],
        },
      });
      expect(packageJson.peerDependencies).toMatchObject({
        "@unbrained/pm-cli": "*",
      });

      const manifest = JSON.parse(await readFile(path.join(scaffoldPath, "manifest.json"), "utf8")) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        name: "starter-package",
        entry: "./index.js",
        capabilities: ["commands"],
      });
      const entry = await readFile(path.join(scaffoldPath, "index.js"), "utf8");
      expect(entry).not.toContain('import { defineExtension }');
      expect(entry).toContain('@param {import("@unbrained/pm-cli/sdk").ExtensionApi}');
      expect(entry).toContain("export function activate(api)");
      expect(entry).toContain('name: "starter-package ping"');

      const install = await runExtension(scaffoldPath, { install: true, project: true }, { path: context.pmPath });
      expect(install.details).toMatchObject({
        extension: {
          name: "starter-package",
        },
        activated: true,
        command_paths: ["starter-package ping"],
        action_paths: ["starter-package-ping"],
        command_discovery: {
          package_name: "starter-package",
          extension_name: "starter-package",
          command_paths: ["starter-package ping"],
          action_paths: ["starter-package-ping"],
          help_commands: ["pm starter-package ping --help"],
          next_steps: ["pm starter-package ping --help"],
        },
      });
      const invoked = spawnSync(process.execPath, [path.join(process.cwd(), "dist/cli.js"), "--path", context.pmPath, "starter-package", "ping", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PM_TELEMETRY_DISABLED: "1",
          PM_SENTRY_DISABLED: "1",
        },
      });
      expect(invoked.status).toBe(0);
      expect(JSON.parse(invoked.stdout) as Record<string, unknown>).toMatchObject({
        ok: true,
        command: "starter-package ping",
      });
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

  it("preflights scaffold conflicts before writing any scaffold files", async () => {
    await withTempPmPath(async (context) => {
      const conflictPath = path.join(context.tempRoot, "partial-conflict");
      await mkdir(conflictPath, { recursive: true });
      await writeFile(path.join(conflictPath, "index.js"), "conflicting entrypoint\n", "utf8");

      await expect(runExtension(conflictPath, { init: true, project: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
      });
      await expect(readFile(path.join(conflictPath, "manifest.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("installs bundled first-party package aliases via extension install", async () => {
    await withTempPmPath(async (context) => {
      const beadsInstall = await runExtension("beads", { install: true, project: true }, { path: context.pmPath });
      expect(beadsInstall.details).toMatchObject({
        extension: {
          name: "builtin-beads-import",
        },
        source: {
          kind: "builtin",
          input: "beads",
          location: "beads",
          name: "beads",
        },
        activated: true,
        command_paths: expect.arrayContaining(["beads import"]),
        action_paths: expect.arrayContaining(["beads-import"]),
        command_discovery: {
          package_name: "beads",
          extension_name: "builtin-beads-import",
          command_paths: expect.arrayContaining(["beads import"]),
          action_paths: expect.arrayContaining(["beads-import"]),
          help_commands: expect.arrayContaining(["pm beads import --help"]),
          next_steps: expect.arrayContaining(["pm beads import --help"]),
        },
      });

      const todosInstall = await runExtension("todos", { install: true, project: true }, { path: context.pmPath });
      expect(todosInstall.details).toMatchObject({
        extension: {
          name: "builtin-todos-import-export",
        },
        source: {
          kind: "builtin",
          input: "todos",
          location: "todos",
          name: "todos",
        },
        activated: true,
      });

      const calendarInstall = await runExtension("calendar", { install: true, project: true }, { path: context.pmPath });
      expect(calendarInstall.details).toMatchObject({
        extension: {
          name: "builtin-calendar",
        },
        source: {
          kind: "builtin",
          input: "calendar",
          location: "calendar",
          name: "calendar",
        },
        activated: true,
      });

      const templatesInstall = await runExtension("templates", { install: true, project: true }, { path: context.pmPath });
      expect(templatesInstall.details).toMatchObject({
        extension: {
          name: "builtin-templates",
        },
        source: {
          kind: "builtin",
          input: "templates",
          location: "templates",
          name: "templates",
        },
        activated: true,
      });

      const managedState = await readManagedExtensionState(path.join(context.pmPath, "extensions"));
      expect(managedState.state.entries.map((entry) => entry.source)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "builtin", name: "beads", input: "beads", location: "beads" }),
          expect.objectContaining({ kind: "builtin", name: "todos", input: "todos", location: "todos" }),
          expect.objectContaining({ kind: "builtin", name: "calendar", input: "calendar", location: "calendar" }),
          expect.objectContaining({ kind: "builtin", name: "templates", input: "templates", location: "templates" }),
        ]),
      );
      for (const entry of managedState.state.entries) {
        if (entry.source.kind === "builtin") {
          expect(path.isAbsolute(entry.source.input)).toBe(false);
          expect(path.isAbsolute(entry.source.location)).toBe(false);
        }
      }
    });
  });

  it("activates the command-kit exemplar package and surfaces its command/flag/parser registrations", async () => {
    const commandKitModule = await import("../../../packages/pm-command-kit/extensions/command-kit/index.ts");
    const { activate: activateCommandKit, manifest: commandKitManifest, rewriteEchoOptions, runEchoCommand } = commandKitModule;
    expect(commandKitModule.default).toMatchObject({ manifest: commandKitManifest });
    expect(commandKitManifest).toMatchObject({
      name: "builtin-command-kit",
      capabilities: ["commands", "schema", "parser"],
      activation: {
        commands: ["command-kit echo", "list"],
      },
    });

    const commands: Array<Record<string, unknown>> = [];
    const parsers: Array<{ command: string; override: unknown }> = [];
    const flagRegistrations: Array<{ target: string; flags: Array<Record<string, unknown>> }> = [];
    activateCommandKit({
      registerCommand: (definition: Record<string, unknown>) => commands.push(definition),
      registerParser: (command: string, override: unknown) => parsers.push({ command, override }),
      registerFlags: (target: string, flags: Array<Record<string, unknown>>) => flagRegistrations.push({ target, flags }),
    } as never);

    expect(commands).toHaveLength(1);
    const echoDefinition = commands[0];
    expect(echoDefinition).toMatchObject({
      name: "command-kit echo",
      action: "command-kit-echo",
      description: expect.stringContaining("exemplar"),
      intent: expect.stringContaining("CommandDefinition"),
      run: expect.any(Function),
    });
    expect(echoDefinition.arguments).toEqual([
      { name: "message", required: true, variadic: true, description: expect.any(String) },
    ]);
    expect((echoDefinition.flags as Array<{ long?: string }>).map((flag) => flag.long)).toEqual([
      "--upper",
      "--shout",
      "--repeat",
      "--decorations",
    ]);
    expect(echoDefinition.examples).toHaveLength(3);
    expect(echoDefinition.failure_hints).toHaveLength(2);

    expect(parsers).toEqual([{ command: "command-kit echo", override: rewriteEchoOptions }]);
    expect(flagRegistrations).toEqual([
      {
        target: "list",
        flags: [expect.objectContaining({ long: "--kit-note", value_type: "string" })],
      },
    ]);

    const parserDelta = rewriteEchoOptions({
      command: "command-kit echo",
      args: ["hello"],
      options: { shout: true, repeat: "2", decorations: " star , star ,spark" },
      global: {},
      pm_root: "/tmp",
    });
    expect(parserDelta.options).toMatchObject({ upper: true, repeat: 2, decorations: ["star", "spark"] });
    expect(parserDelta.options).not.toHaveProperty("shout");

    // Invalid/out-of-range --repeat falls back to 1 (toPositiveInteger guard),
    // the string "true" alias toggles --upper, and an omitted --decorations key
    // leaves the option untouched.
    const fallbackDelta = rewriteEchoOptions({
      command: "command-kit echo",
      args: ["hi"],
      options: { shout: "true", repeat: "not-a-number" },
      global: {},
      pm_root: "/tmp",
    });
    expect(fallbackDelta.options).toMatchObject({ upper: true, repeat: 1 });
    expect(fallbackDelta.options).not.toHaveProperty("decorations");

    // No --shout and a non-"true" string value: neither shout branch fires, so
    // --upper is left untouched (the if-false arm), and --decorations is set.
    const noShoutDelta = rewriteEchoOptions({
      command: "command-kit echo",
      args: ["hi"],
      options: { shout: "maybe", repeat: 3, decorations: "a,b" },
      global: {},
      pm_root: "/tmp",
    });
    expect(noShoutDelta.options).not.toHaveProperty("upper");
    expect(noShoutDelta.options).not.toHaveProperty("shout");
    expect(noShoutDelta.options).toMatchObject({ repeat: 3, decorations: ["a", "b"] });

    const negativeRepeatResult = runEchoCommand({
      command: "command-kit echo",
      args: ["hi"],
      options: { repeat: -5, upper: "true", decorations: ["", "  "] },
      global: {},
      pm_root: "/tmp",
    });
    expect(negativeRepeatResult).toMatchObject({ repeat: 1, upper: true, message: "HI", decorations: [] });

    // No repeat option (nullish -> String(value ?? "") arm), decorations as a
    // comma-string (split arm), and upper unset (lowercase passthrough arm).
    const plainResult = runEchoCommand({
      command: "command-kit echo",
      args: ["Hello"],
      options: { decorations: "star, spark ,star" },
      global: {},
      pm_root: "/tmp",
    });
    expect(plainResult).toMatchObject({
      repeat: 1,
      upper: false,
      message: "Hello",
      decorations: ["star", "spark"],
    });

    // decorations as a non-array/non-string value -> [] arm; options provided as
    // an array is ignored (the `!Array.isArray(context.options)` guard arm).
    const arrayOptionsResult = runEchoCommand({
      command: "command-kit echo",
      args: ["solo"],
      options: ["ignored"] as never,
      global: {},
      pm_root: "/tmp",
    });
    expect(arrayOptionsResult).toMatchObject({ message: "solo", repeat: 1, upper: false, decorations: [] });

    const numericDecorations = runEchoCommand({
      command: "command-kit echo",
      args: ["solo"],
      options: { decorations: 42 },
      global: {},
      pm_root: "/tmp",
    });
    expect(numericDecorations).toMatchObject({ decorations: [] });

    const echoResult = runEchoCommand({
      command: "command-kit echo",
      args: ["hello", "world"],
      options: parserDelta.options ?? {},
      global: {},
      pm_root: "/tmp",
    });
    expect(echoResult).toMatchObject({
      action: "command-kit-echo",
      message: "HELLO WORLD",
      lines: ["HELLO WORLD", "HELLO WORLD"],
      repeat: 2,
      upper: true,
    });
    expect(() =>
      runEchoCommand({ command: "command-kit echo", args: [" "], options: {}, global: {}, pm_root: "/tmp" }),
    ).toThrow(/requires a message argument/);
    expect(() => runEchoCommand({ command: "command-kit echo", args: null, options: null } as never)).toThrow(
      /requires a message argument/,
    );

    await withTempPmPath(async (context) => {
      const install = await runExtension("command-kit", { install: true, project: true }, { path: context.pmPath });
      expect(install.details).toMatchObject({
        extension: {
          name: "builtin-command-kit",
        },
        source: {
          kind: "builtin",
          input: "command-kit",
          name: "command-kit",
        },
        activated: true,
        command_paths: expect.arrayContaining(["command-kit echo"]),
        action_paths: expect.arrayContaining(["command-kit-echo"]),
      });

      const listWithInjectedFlag = context.runCli(["list", "--kit-note", "smoke", "--json"], { expectJson: true });
      expect(listWithInjectedFlag.code).toBe(0);
      expect((listWithInjectedFlag.json as { items?: unknown[] }).items).toEqual([]);

      const echoWithLeadingBooleanFlag = context.runCli(["command-kit", "echo", "--upper", "hello", "--json"], {
        expectJson: true,
      });
      expect(echoWithLeadingBooleanFlag.code).toBe(0);
      expect(echoWithLeadingBooleanFlag.json).toMatchObject({ message: "HELLO", upper: true });
    });
  });

  it("lists bundled first-party package catalog metadata", async () => {
    await withTempPmPath(async (context) => {
      const beforeInstall = await runExtension(undefined, { catalog: true, project: true, vocabulary: "package" }, { path: context.pmPath });
      expect(beforeInstall.action).toBe("catalog");
      expect(beforeInstall.details).toMatchObject({
        total: 10,
        scope: "project",
        installable_resource_kinds: ["extensions"],
        metadata_only_resource_kinds: ["docs", "examples", "assets", "prompts"],
        packages: [
          {
            alias: "beads",
            available: true,
            installed: false,
            package_name: "@unbrained/pm-beads",
            installable_resources: {
              extensions: ["extensions/beads"],
            },
            metadata_only_resources: {
              docs: ["README.md"],
              examples: ["README.md"],
            },
            catalog: {
              display_name: "Beads Import",
              category: "migration",
            },
          },
          {
            alias: "calendar",
            available: true,
            installed: false,
            package_name: "@unbrained/pm-calendar",
            catalog: {
              display_name: "Calendar Views",
              category: "workflow",
            },
          },
          {
            alias: "command-kit",
            available: true,
            installed: false,
            package_name: "@unbrained/pm-command-kit",
            catalog: {
              display_name: "Command Kit Exemplar",
              category: "sdk",
            },
          },
          {
            alias: "governance-audit",
            available: true,
            installed: false,
            package_name: "@unbrained/pm-governance-audit",
            catalog: {
              display_name: "Governance Audit",
              category: "governance",
            },
          },
          {
            alias: "guide-shell",
            available: true,
            installed: false,
            package_name: "@unbrained/pm-guide-shell",
            catalog: {
              display_name: "Guide + Shell UX",
              category: "workflow",
            },
          },
          {
            alias: "lifecycle-hooks",
            available: true,
            installed: false,
            package_name: "@unbrained/pm-lifecycle-hooks",
            catalog: {
              display_name: "Lifecycle Hooks",
              category: "sdk",
            },
          },
          {
            alias: "linked-test-adapters",
            available: true,
            installed: false,
            package_name: "@unbrained/pm-linked-test-adapters",
            catalog: {
              display_name: "Linked Test Adapters",
              category: "testing",
            },
          },
          {
            alias: "search-advanced",
            available: true,
            installed: false,
            package_name: "@unbrained/pm-search-advanced",
            catalog: {
              display_name: "Advanced Search",
              category: "search",
            },
          },
          {
            alias: "templates",
            available: true,
            installed: false,
            package_name: "@unbrained/pm-templates",
            catalog: {
              display_name: "Create Templates",
              category: "workflow",
            },
          },
          {
            alias: "todos",
            available: true,
            installed: false,
            package_name: "@unbrained/pm-todos",
            catalog: {
              display_name: "Todos Import/Export",
              category: "migration",
            },
          },
        ],
      });
      const beforeInstallPackages = (beforeInstall.details as { packages?: Array<{ alias?: string; catalog?: { links?: { npm?: string } } }> }).packages ?? [];
      expect(beforeInstallPackages.find((entry) => entry.alias === "calendar")?.catalog?.links?.npm).toBeUndefined();
      expect(beforeInstallPackages.find((entry) => entry.alias === "templates")?.catalog?.links?.npm).toBeUndefined();
      expect(beforeInstallPackages.some((entry) => Object.prototype.hasOwnProperty.call(entry, "package_root"))).toBe(false);

      const compactCatalog = await runExtension(
        undefined,
        { catalog: true, project: true, vocabulary: "package", fields: "alias,installed,install_command,category" },
        { path: context.pmPath },
      );
      expect((compactCatalog.details as { packages?: Array<Record<string, unknown>> }).packages?.[0]).toEqual({
        alias: "beads",
        installed: false,
        install_command: "pm install beads --project",
        category: "migration",
      });

      await runExtension("todos", { install: true, project: true }, { path: context.pmPath });
      const afterInstall = await runExtension(undefined, { catalog: true, project: true, vocabulary: "package" }, { path: context.pmPath });
      const packages = (afterInstall.details as { packages?: Array<{ alias?: string; installed?: boolean }> }).packages ?? [];
      expect(packages.find((entry) => entry.alias === "todos")?.installed).toBe(true);
      expect(packages.find((entry) => entry.alias === "beads")?.installed).toBe(false);
      expect(packages.find((entry) => entry.alias === "calendar")?.installed).toBe(false);
      expect(packages.find((entry) => entry.alias === "command-kit")?.installed).toBe(false);
      expect(packages.find((entry) => entry.alias === "governance-audit")?.installed).toBe(false);
      expect(packages.find((entry) => entry.alias === "guide-shell")?.installed).toBe(false);
      expect(packages.find((entry) => entry.alias === "lifecycle-hooks")?.installed).toBe(false);
      expect(packages.find((entry) => entry.alias === "linked-test-adapters")?.installed).toBe(false);
      expect(packages.find((entry) => entry.alias === "search-advanced")?.installed).toBe(false);
      expect(packages.find((entry) => entry.alias === "templates")?.installed).toBe(false);

      const positionalCatalog = await runExtension("catalog", { project: true, vocabulary: "package" }, { path: context.pmPath });
      expect(positionalCatalog.action).toBe("catalog");
    });
  });

  it("validates package catalog field projection and doctor consistency summaries", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runExtension(undefined, { catalog: true, project: true, vocabulary: "package", fields: "," }, { path: context.pmPath }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runExtension(undefined, { catalog: true, project: true, vocabulary: "package", fields: "alias,unknown" }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        context: {
          examples: expect.arrayContaining(["pm package catalog --project --fields alias,package_name,category"]),
        },
      });

      const projected = await runExtension(
        undefined,
        { catalog: true, project: true, vocabulary: "package", fields: "alias,display_name,package_version" },
        { path: context.pmPath },
      );
      expect((projected.details as { packages?: Array<Record<string, unknown>> }).packages?.[0]).toEqual({
        alias: "beads",
        display_name: "Beads Import",
        package_version: expect.any(String),
      });
    });

    expect(buildDoctorConsistencySummary("global", [], [], [], false)).toMatchObject({
      warnings: [],
      summary: { active_project_count: 0, loaded_project_count: 0 },
    });
    expect(buildDoctorConsistencySummary("project", [], [], [], true)).toMatchObject({
      warnings: [],
      summary: { active_project_names: [], loaded_project_names: [] },
    });
    const consistency = buildDoctorConsistencySummary(
      "project",
      [
        { name: "Beta", directory: "beta", active: true } as never,
        { name: "Alpha", directory: "alpha", active: true } as never,
        { name: "Disabled", directory: "disabled", active: false } as never,
      ],
      [{ layer: "project", name: "beta" }],
      [{ name: "missing-but-failed" }],
      false,
    );
    expect(consistency).toEqual({
      warnings: ["extension_doctor_consistency_active_not_loaded:alpha"],
      summary: {
        active_project_count: 2,
        loaded_project_count: 1,
        active_project_names: ["alpha", "beta"],
        loaded_project_names: ["beta"],
        missing_active_project_names: ["alpha"],
      },
    });
    expect(
      buildDoctorConsistencySummary(
        "project",
        [
          { name: "Gamma", directory: "gamma", active: true } as never,
          { name: "Alpha", directory: "alpha", active: true } as never,
        ],
        [
          { layer: "global", name: "ignored" },
          { layer: "project", name: "gamma" },
          { layer: "project", name: "alpha" },
        ],
        [],
        false,
      ),
    ).toMatchObject({
      warnings: [],
      summary: {
        active_project_names: ["alpha", "gamma"],
        loaded_project_names: ["alpha", "gamma"],
        missing_active_project_names: [],
      },
    });
    expect(
      classifyDoctorActivationFailureWarnings([
        { name: "NeedsCapability", trace: { missing_capability: " Schema " } },
        { name: "NeedsCapability", trace: { capability: "schema" } },
        { name: "NoTrace", trace: {} },
        null as never,
      ]),
    ).toEqual(["extension_capability_missing:NeedsCapability:schema"]);
    expect(
      classifyDoctorLoadFailureWarnings([
        { name: "sdk", error: "Cannot find package '@unbrained/pm-cli' imported from extension" },
        { name: "esm", error: "Cannot use import statement outside a module" },
        { name: "esm", error: "Must use import to load ES Module" },
        { name: "other", error: "runtime failed" },
      ]),
    ).toEqual([
      "extension_load_failed_module_mode_mismatch:esm",
      "extension_load_failed_sdk_dependency_missing:sdk",
    ]);
    expect(
      collectUnknownCapabilityGuidance([
        "extension_capability_unknown:project:demo:widgets:allowed=commands,schema:suggested=none",
        "extension_capability_unknown:project:demo:widgets:allowed=commands,schema:suggested=none",
        "extension_capability_legacy_alias:global:legacy:aliases=migration>schema,broken>missing",
        "not_a_capability_warning",
      ]).map((entry) => `${entry.layer}:${entry.name}:${entry.capability}`),
    ).toEqual(["project:demo:widgets", "global:legacy:migration"]);
    expect(buildExtensionTriageSummary("project", [], [])).toMatchObject({
      status: "ok",
      warning_count: 0,
      remediation: ["No immediate action required. Re-run pm extension --manage --project after extension changes."],
    });
    expect(buildExtensionTriageSummary("project", ["plain_warning"], [])).toMatchObject({
      status: "warn",
      warning_codes: ["plain_warning"],
    });
    expect(
      classifyDoctorActivationFailureWarnings([
        { name: "OtherTrace", trace: { capability: " Hooks " } },
        { name: "BlankCapability", trace: { missing_capability: " " } },
        { name: "NoTrace" },
      ]),
    ).toEqual(["extension_capability_missing:OtherTrace:hooks"]);
    expect(
      buildDoctorConsistencySummary(
        "project",
        [
          { name: "Zulu", directory: "zulu", active: true } as never,
          { name: "Alpha", directory: "alpha", active: true } as never,
          { name: "Loaded", directory: "loaded", active: true } as never,
        ],
        [{ layer: "project", name: "loaded" }],
        [],
        false,
      ),
    ).toMatchObject({
      warnings: ["extension_doctor_consistency_active_not_loaded:alpha,zulu"],
      summary: {
        missing_active_project_names: ["alpha", "zulu"],
      },
    });
  });

  it("installs all bundled first-party packages via wildcard and all aliases", async () => {
    await withTempPmPath(async (context) => {
      const wildcardInstall = await runExtension("*", { install: true, project: true }, { path: context.pmPath });
      expect(wildcardInstall.details).toMatchObject({
        installed_all: true,
        installed_count: 10,
        packages: [
          {
            alias: "beads",
            extension: { name: "builtin-beads-import" },
            activated: true,
            command_paths: expect.arrayContaining(["beads import"]),
            action_paths: expect.arrayContaining(["beads-import"]),
            command_discovery: {
              package_name: "beads",
              extension_name: "builtin-beads-import",
              command_paths: expect.arrayContaining(["beads import"]),
              action_paths: expect.arrayContaining(["beads-import"]),
              help_commands: expect.arrayContaining(["pm beads import --help"]),
              next_steps: expect.arrayContaining(["pm beads import --help"]),
            },
          },
          {
            alias: "calendar",
            extension: { name: "builtin-calendar" },
            activated: true,
          },
          {
            alias: "command-kit",
            extension: { name: "builtin-command-kit" },
            activated: true,
          },
          {
            alias: "governance-audit",
            extension: { name: "builtin-governance-audit" },
            activated: true,
          },
          {
            alias: "guide-shell",
            extension: { name: "builtin-guide-shell" },
            activated: true,
          },
          {
            alias: "lifecycle-hooks",
            extension: { name: "builtin-lifecycle-hooks" },
            activated: true,
          },
          {
            alias: "linked-test-adapters",
            extension: { name: "builtin-linked-test-adapters" },
            activated: true,
          },
          {
            alias: "search-advanced",
            extension: { name: "builtin-search-advanced" },
            activated: true,
          },
          {
            alias: "templates",
            extension: { name: "builtin-templates" },
            activated: true,
          },
          {
            alias: "todos",
            extension: { name: "builtin-todos-import-export" },
            activated: true,
          },
        ],
      });

      const allInstall = await runExtension("all", { install: true, project: true }, { path: context.pmPath });
      expect(allInstall.details).toMatchObject({
        installed_all: true,
        installed_count: 10,
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

  it("installs first-party package source via explicit local path", async () => {
    await withTempPmPath(async (context) => {
      const bundledTodosPath = path.resolve(process.cwd(), "packages", "pm-todos");
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
      const bundledBeadsPackage = path.join(tempPackageRoot, "packages", "pm-beads");
      const bundledBeadsDir = path.join(bundledBeadsPackage, "extensions", "beads");
      await mkdir(bundledBeadsPackage, { recursive: true });
      await writeFile(
        path.join(bundledBeadsPackage, "package.json"),
        JSON.stringify(
          {
            name: "@example/env-beads-package",
            version: "1.0.0",
            pm: {
              extensions: ["extensions/beads"],
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeTestExtension({ root: bundledBeadsDir, name: "env-beads-ext" });

      const previousPackageRoot = process.env[PM_PACKAGE_ROOT_ENV];
      process.env[PM_PACKAGE_ROOT_ENV] = tempPackageRoot;
      try {
        const install = await runExtension("beads", { install: true, project: true }, { path: context.pmPath });
        expect(install.details).toMatchObject({
          extension: {
            name: "env-beads-ext",
          },
          source: {
            kind: "builtin",
            input: "beads",
            location: "beads",
            name: "beads",
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

  it("discovers bundled package aliases from package manifests", async () => {
    await withTempPmPath(async (context) => {
      const tempPackageRoot = await mkdtemp(path.join(context.tempRoot, "pm-bundled-root-"));
      const bundledPackage = path.join(tempPackageRoot, "packages", "pm-custom");
      const bundledExtension = path.join(bundledPackage, "extensions", "custom");
      await mkdir(bundledPackage, { recursive: true });
      await writeFile(
        path.join(bundledPackage, "package.json"),
        JSON.stringify(
          {
            name: "@example/pm-custom",
            version: "1.0.0",
            pm: {
              aliases: ["custom"],
              extensions: ["extensions/custom"],
              catalog: {
                display_name: "Custom Package",
                category: "fixture",
                summary: "Manifest-discovered package fixture.",
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeTestExtension({ root: bundledExtension, name: "custom-package-ext" });

      const previousPackageRoot = process.env[PM_PACKAGE_ROOT_ENV];
      process.env[PM_PACKAGE_ROOT_ENV] = tempPackageRoot;
      try {
        const catalog = await runExtension("catalog", { catalog: true, project: true }, { path: context.pmPath });
        expect(catalog.details).toMatchObject({
          packages: expect.arrayContaining([
            expect.objectContaining({
              alias: "custom",
              package_name: "@example/pm-custom",
              catalog: expect.objectContaining({
                links: expect.objectContaining({
                  npm: "https://www.npmjs.com/package/%40example%2Fpm-custom",
                }),
              }),
            }),
          ]),
        });

        const install = await runExtension("custom", { install: true, project: true }, { path: context.pmPath });
        expect(install.details).toMatchObject({
          extension: {
            name: "custom-package-ext",
          },
          source: {
            kind: "builtin",
            input: "custom",
            location: "custom",
            name: "custom",
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

  it("resolves bundled catalog aliases and installed local-source catalog entries", async () => {
    await withTempPmPath(async (context) => {
      const tempPackageRoot = await mkdtemp(path.join(context.tempRoot, "pm-bundled-root-"));
      const bundledPackage = path.join(tempPackageRoot, "packages", "pm-local-catalog");
      const bundledExtension = path.join(bundledPackage, "extensions", "local-catalog");
      const multiPackage = path.join(tempPackageRoot, "packages", "pm-multi-catalog");
      const invalidPackage = path.join(tempPackageRoot, "packages", "pm-invalid-catalog");
      await mkdir(bundledPackage, { recursive: true });
      await writeFile(
        path.join(bundledPackage, "package.json"),
        JSON.stringify(
          {
            name: "@example/pm-local-catalog",
            version: "2.0.0",
            description: "Local-source catalog fixture.",
            keywords: ["catalog"],
            pm: {
              aliases: ["local-catalog", "  "],
              extensions: ["extensions/local-catalog"],
              docs: ["README.md"],
              catalog: {
                display_name: "Local Catalog",
                category: "fixture",
                links: {
                  repository: "https://example.test/repo",
                },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeTestExtension({ root: bundledExtension, name: "local-catalog-ext" });
      await mkdir(multiPackage, { recursive: true });
      await writeFile(
        path.join(multiPackage, "package.json"),
        JSON.stringify({ name: "@example/pm-multi-catalog", version: "1.0.0", pm: { aliases: ["multi-catalog"] } }),
        "utf8",
      );
      await writeTestExtension({ root: path.join(multiPackage, "extensions", "one"), name: "multi-one" });
      await writeTestExtension({ root: path.join(multiPackage, "extensions", "two"), name: "multi-two" });
      await mkdir(path.join(invalidPackage, "extensions", "invalid"), { recursive: true });
      await writeFile(
        path.join(invalidPackage, "package.json"),
        JSON.stringify({ name: "@example/pm-invalid-catalog", version: "1.0.0", pm: { aliases: ["invalid-catalog"] } }),
        "utf8",
      );
      await writeFile(path.join(invalidPackage, "extensions", "invalid", "manifest.json"), '{"name":""}\n', "utf8");

      const extensionsRoot = path.join(context.pmPath, "extensions");
      const installedState = upsertManagedEntry(createEmptyManagedExtensionState(), {
        name: "local-catalog-ext",
        directory: "local-catalog-ext",
        scope: "project",
        manifest_version: "2.0.0",
        manifest_entry: "index.js",
        capabilities: ["commands"],
        installed_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        source: { kind: "local", input: bundledPackage, location: bundledPackage },
      });
      await writeManagedExtensionState(extensionsRoot, installedState);

      const previousPackageRoot = process.env[PM_PACKAGE_ROOT_ENV];
      process.env[PM_PACKAGE_ROOT_ENV] = tempPackageRoot;
      try {
        await expect(resolveBundledExtensionAliasSource(" LOCAL-CATALOG ")).resolves.toBe(bundledPackage);
        await expect(resolveBundledAliasManifestName("local-catalog")).resolves.toBe("local-catalog-ext");
        await expect(resolveBundledAliasManifestName("multi-catalog")).resolves.toBeNull();
        await expect(resolveBundledAliasManifestName("invalid-catalog")).resolves.toBeNull();
        await expect(resolveBundledAliasManifestName("missing-catalog")).resolves.toBeNull();

        const catalog = await buildBundledPackageCatalog("project", { path: context.pmPath });
        expect(catalog.packages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              alias: "local-catalog",
              installed: true,
              package_name: "@example/pm-local-catalog",
              metadata_only_resources: { docs: ["README.md"] },
              catalog: expect.objectContaining({
                display_name: "Local Catalog",
                links: expect.objectContaining({
                  repository: "https://example.test/repo",
                  npm: "https://www.npmjs.com/package/%40example%2Fpm-local-catalog",
                }),
              }),
            }),
          ]),
        );
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
            kind: "builtin",
            input: "todos",
            location: "todos",
            name: "todos",
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

  it("reads managed extension state fallback and hard-fails invalid persisted state", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-state-"));
    try {
      const emptyState = await readManagedExtensionState(tempRoot);
      expect(emptyState.state.entries).toEqual([]);
      expect(emptyState.warnings).toEqual([]);

      const statePath = path.join(tempRoot, ".managed-extensions.json");
      await writeFile(statePath, JSON.stringify({ version: 2, entries: [] }, null, 2), "utf8");
      await expect(readManagedExtensionState(tempRoot)).rejects.toMatchObject({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });

      await writeFile(statePath, "{not-json", "utf8");
      await expect(readManagedExtensionState(tempRoot)).rejects.toMatchObject({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("normalizes managed extension state records, source equivalence, and upserts", async () => {
    const empty = createEmptyManagedExtensionState();
    expect(empty.version).toBe(1);
    expect(empty.entries).toEqual([]);
    expect(normalizeManagedState(null)).toBeNull();
    expect(normalizeManagedState({ version: 1, entries: "bad" })).toBeNull();

    const normalized = normalizeManagedState({
      version: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
      entries: [
        null,
        { name: "", directory: "skip", scope: "project" },
        {
          name: "  Zeta  ",
          directory: " zeta-dir ",
          scope: "project",
          manifest_version: "1.0.0",
          manifest_entry: "index.js",
          capabilities: ["commands", " commands ", ""],
          installed_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          source: {
            kind: "github",
            input: "owner/repo/zeta",
            location: "https://github.com/owner/repo.git",
            owner: "owner",
            repo: "repo",
            ref: "main",
            subpath: "zeta",
            commit: "abc123",
          },
          last_update_check_at: "2026-01-02T00:00:00.000Z",
          last_update_remote_commit: "def456",
          update_available: null,
          update_error: "offline",
        },
        {
          name: "Alpha",
          directory: "alpha-dir",
          scope: "global",
          manifest_version: "1.0.0",
          manifest_entry: "index.js",
          capabilities: ["schema"],
          installed_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          source: { kind: "builtin", input: "alpha", location: "alpha", name: "alpha" },
        },
      ],
    });
    expect(normalized?.entries.map((entry) => `${entry.scope}:${entry.name}:${entry.directory}`)).toEqual([
      "global:Alpha:alpha-dir",
      "project:Zeta:zeta-dir",
    ]);
    expect(normalized?.entries[1]?.capabilities).toEqual(["commands"]);
    expect(normalized?.entries[1]?.source).toMatchObject({
      kind: "github",
      owner: "owner",
      repo: "repo",
      commit: "abc123",
    });

    const firstSource = { kind: "npm", input: "npm:pm-demo", location: "pm-demo", package: "pm-demo", version: "1.0.0" } as const;
    expect(managedExtensionSourcesEquivalent(firstSource, { ...firstSource })).toBe(true);
    expect(managedExtensionSourcesEquivalent(firstSource, { ...firstSource, version: "2.0.0" })).toBe(false);
    expect(
      managedExtensionSourcesEquivalent(
        { kind: "github", input: "owner/repo", location: "repo", repository: "repo", ref: "main" },
        { kind: "github", input: "owner/repo", location: "repo", repository: "repo", ref: "next" },
      ),
    ).toBe(false);
    expect(
      managedExtensionSourcesEquivalent(
        { kind: "github", input: "owner/repo", location: "repo", repository: "repo", ref: "main", subpath: "ext/a" },
        { kind: "github", input: "owner/repo", location: "repo", repository: "repo", ref: "main", subpath: "ext/b" },
      ),
    ).toBe(false);
    expect(
      managedExtensionSourcesEquivalent(
        { kind: "github", input: "owner/repo", location: "repo", repository: "repo", ref: "main", commit: "abc" },
        { kind: "github", input: "owner/repo", location: "repo", repository: "repo", ref: "main", commit: "def" },
      ),
    ).toBe(false);
    expect(managedExtensionSourcesEquivalent({ kind: "builtin", input: "alpha", location: "alpha", name: "alpha" }, { kind: "builtin", input: "alpha", location: "alpha", name: "beta" })).toBe(false);

    const updated = upsertManagedEntry(normalized ?? empty, {
      name: "alpha-renamed",
      directory: "alpha-dir",
      scope: "global",
      manifest_version: "1.0.0",
      manifest_entry: "index.js",
      capabilities: ["commands"],
      installed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      source: { kind: "local", input: "alpha-dir", location: "alpha-dir" },
    });
    expect(updated.entries.map((entry) => entry.name)).toEqual(["alpha-renamed", "Zeta"]);

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-state-write-"));
    try {
      await writeManagedExtensionState(tempRoot, updated);
      const reread = await readManagedExtensionState(tempRoot);
      expect(reread.state.entries.map((entry) => entry.name)).toEqual(["alpha-renamed", "Zeta"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports local install-source resolution failures and file URL package sources", async () => {
    const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pm-extension-source-shapes-")));
    try {
      await expect(resolveInstallSource(parseExtensionInstallSource(path.join(tempRoot, "missing")))).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      const fileSource = path.join(tempRoot, "not-a-directory.js");
      await writeFile(fileSource, "export default {};\n", "utf8");
      await expect(resolveInstallSource(parseExtensionInstallSource(fileSource))).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });

      const emptyPackage = path.join(tempRoot, "empty-package");
      await mkdir(emptyPackage, { recursive: true });
      await writeFile(path.join(emptyPackage, "package.json"), JSON.stringify({ name: "pm-empty" }), "utf8");
      await expect(resolveInstallSource(parseExtensionInstallSource(emptyPackage))).rejects.toThrow(
        /Unable to locate a pm extension manifest/,
      );

      const multiPackage = path.join(tempRoot, "multi-package");
      await mkdir(multiPackage, { recursive: true });
      await writeFile(path.join(multiPackage, "package.json"), JSON.stringify({ name: "pm-multi" }), "utf8");
      await writeTestExtension({ root: path.join(multiPackage, "extensions", "a"), name: "multi-a" });
      await writeTestExtension({ root: path.join(multiPackage, "extensions", "b"), name: "multi-b" });
      await expect(resolveInstallSource(parseExtensionInstallSource(multiPackage))).rejects.toThrow(
        /contains multiple extension manifests/,
      );

      const directExtension = path.join(tempRoot, "direct-extension");
      await writeTestExtension({ root: directExtension, name: "direct-extension" });
      await expect(resolveInstallSource(parseExtensionInstallSource(directExtension))).resolves.toMatchObject({
        directory: directExtension,
        source: { kind: "local", input: directExtension, absolute_path: directExtension },
      });

      const fileUrlPackage = path.join(tempRoot, "file-url-package");
      const fileUrlExtension = path.join(fileUrlPackage, "extensions", "file-url");
      await mkdir(fileUrlPackage, { recursive: true });
      await writeFile(
        path.join(fileUrlPackage, "package.json"),
        JSON.stringify({ name: "pm-file-url-package", version: "0.3.0", pm: { extensions: ["extensions/file-url"] } }, null, 2),
        "utf8",
      );
      await writeTestExtension({ root: fileUrlExtension, name: "file-url-ext" });
      const resolved = await resolveInstallSource(parseExtensionInstallSource(`npm:${pathToFileURL(fileUrlPackage).href}`));
      expect(resolved).toMatchObject({
        directory: fileUrlExtension,
        resolved_subpath: "file-url",
        npm_package: "pm-file-url-package",
        npm_version: "0.3.0",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves Git-backed extension sources from local repositories without network access", async () => {
    const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pm-extension-git-source-")));
    try {
      const repoRoot = path.join(tempRoot, "repo");
      const repoExtension = path.join(repoRoot, ".agents", "pm", "extensions", "fixture");
      await mkdir(repoExtension, { recursive: true });
      await writeTestExtension({ root: repoExtension, name: "git-fixture" });
      expect(runGit(["init", repoRoot]).status).toBe(0);
      expect(runGit(["-C", repoRoot, "config", "user.email", "pm-test@example.com"]).status).toBe(0);
      expect(runGit(["-C", repoRoot, "config", "user.name", "pm test"]).status).toBe(0);
      expect(runGit(["-C", repoRoot, "add", "."]).status).toBe(0);
      expect(runGit(["-C", repoRoot, "commit", "-m", "fixture"]).status).toBe(0);
      expect(runGit(["-C", repoRoot, "branch", "fixture-ref"]).status).toBe(0);

      const resolved = await resolveInstallSource({
        kind: "github",
        input: "local/repo/fixture",
        owner: "local",
        repo: "repo",
        repository: repoRoot,
        subpath: "fixture",
      });
      expect(resolved).toMatchObject({
        directory: expect.stringContaining(path.join(".agents", "pm", "extensions", "fixture")),
        resolved_subpath: ".agents/pm/extensions/fixture",
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      await resolved.cleanup?.();

      const fallbackResolved = await resolveInstallSource({
        kind: "github",
        input: "local/repo/missing",
        owner: "local",
        repo: "repo",
        repository: repoRoot,
        subpath: "missing",
      });
      expect(fallbackResolved.resolved_subpath).toBe(".agents/pm/extensions/fixture");
      await fallbackResolved.cleanup?.();

      const refResolved = await resolveInstallSource({
        kind: "github",
        input: "local/repo/fixture",
        owner: "local",
        repo: "repo",
        repository: repoRoot,
        ref: "fixture-ref",
        subpath: "fixture",
      });
      expect(refResolved.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(refResolved.resolved_subpath).toBe(".agents/pm/extensions/fixture");
      await refResolved.cleanup?.();

      const rootRepo = path.join(tempRoot, "root-repo");
      await mkdir(rootRepo, { recursive: true });
      await writeTestExtension({ root: rootRepo, name: "root-git-fixture" });
      expect(runGit(["init", rootRepo]).status).toBe(0);
      expect(runGit(["-C", rootRepo, "config", "user.email", "pm-test@example.com"]).status).toBe(0);
      expect(runGit(["-C", rootRepo, "config", "user.name", "pm test"]).status).toBe(0);
      expect(runGit(["-C", rootRepo, "add", "."]).status).toBe(0);
      expect(runGit(["-C", rootRepo, "commit", "-m", "root-fixture"]).status).toBe(0);
      const traversalResolved = await resolveInstallSource({
        kind: "github",
        input: "local/root-repo/../outside",
        owner: "local",
        repo: "root-repo",
        repository: rootRepo,
        subpath: "../outside",
      });
      expect(traversalResolved.resolved_subpath).toBe(".");
      await traversalResolved.cleanup?.();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("cleans up failed GitHub source clones", async () => {
    const beforeTmpEntries = new Set((await readdir(os.tmpdir())).filter((entry) => entry.startsWith("pm-extension-source-")));
    await expect(
      resolveInstallSource({
        kind: "github",
        input: "local/missing",
        owner: "local",
        repo: "missing",
        repository: path.join(os.tmpdir(), "pm-definitely-missing-repo"),
      }),
    ).rejects.toThrow(/Git command failed/);
    const afterTmpEntries = (await readdir(os.tmpdir())).filter((entry) => entry.startsWith("pm-extension-source-"));
    expect(afterTmpEntries.filter((entry) => !beforeTmpEntries.has(entry))).toEqual([]);
  });

  it("resolves existing cwd-relative npm package specs as local package sources", async () => {
    const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pm-extension-npm-local-")));
    const previousCwd = process.cwd();
    try {
      const packageRoot = path.join(tempRoot, "packages", "local-package");
      const extensionRoot = path.join(packageRoot, "extensions", "local-package");
      await writeTestExtension({ root: extensionRoot, name: "local-package" });
      await writeFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "pm-local-package",
            version: "0.1.0",
            type: "module",
            pm: {
              extensions: ["extensions/local-package"],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      process.chdir(tempRoot);
      const source = parseExtensionInstallSource("npm:packages/local-package");
      expect(source.kind).toBe("npm");
      const resolved = await resolveInstallSource(source);
      expect(resolved.directory).toBe(extensionRoot);
      expect(resolved.npm_package).toBe("pm-local-package");
    } finally {
      process.chdir(previousCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("normalizes npm file-alias package specs to file URLs before packing", async () => {
    const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pm-extension-npm-file-alias-")));
    const previousCwd = process.cwd();
    try {
      const packageRoot = path.join(tempRoot, "packages", "file-alias-package");
      const extensionRoot = path.join(packageRoot, "extensions", "file-alias-package");
      await writeTestExtension({ root: extensionRoot, name: "file-alias-package" });
      await writeFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "pm-file-alias-package",
            version: "0.2.0",
            type: "module",
            pm: {
              extensions: ["extensions/file-alias-package"],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      process.chdir(tempRoot);
      expect(normalizeNpmLocalFileAliasSpec("pm-file-alias-package@file:packages/file-alias-package")).toMatch(
        /^pm-file-alias-package@file:\/\//,
      );
      const source = parseExtensionInstallSource("npm:pm-file-alias-package@file:packages/file-alias-package");
      expect(source.kind).toBe("npm");
      const resolved = await resolveInstallSource(source);
      try {
        expect(resolved.npm_package).toBe("pm-file-alias-package");
        expect(resolved.npm_version).toBe("0.2.0");
        expect(await readFile(path.join(resolved.directory, "manifest.json"), "utf8")).toContain("file-alias-package");
      } finally {
        await resolved.cleanup?.();
      }
    } finally {
      process.chdir(previousCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the Windows npm command shim for npm package installs", () => {
    expect(resolveNpmCommandName("win32")).toBe("npm.cmd");
    expect(resolveNpmCommandName("linux")).toBe("npm");
    expect(shouldRunNpmCommandInShell("win32")).toBe(true);
    expect(shouldRunNpmCommandInShell("linux")).toBe(false);
  });

  it("classifies missing first-party npm package installs with deterministic fallback recovery", () => {
    const error = wrapNpmPackResolutionError(
      "pm-definitely-missing-for-fallback-test-zzzzzz",
      new Error("npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/package"),
    );
    expect(error).toMatchObject({
      exitCode: EXIT_CODE.NOT_FOUND,
      context: {
        code: "npm_package_not_found",
        recovery: {
          attempted_command:
            "pm install --project npm:pm-definitely-missing-for-fallback-test-zzzzzz",
          normalized_args: [
            "install",
            "--project",
            "npm:pm-definitely-missing-for-fallback-test-zzzzzz",
          ],
          next_best_command:
            "pm install --project github.com/unbraind/pm-definitely-missing-for-fallback-test-zzzzzz",
          fallback_candidates: [
            {
              source: "github.com/unbraind/pm-definitely-missing-for-fallback-test-zzzzzz",
              command: "pm install --project github.com/unbraind/pm-definitely-missing-for-fallback-test-zzzzzz",
              reason: "canonical first-party GitHub repository fallback for unpublished pm packages",
            },
          ],
        },
      },
    });
  });

  it("does not emit first-party fallback candidates for third-party npm 404s", () => {
    const error = wrapNpmPackResolutionError(
      "left-pad-private-missing",
      new Error("npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/package"),
    );
    expect(error).toMatchObject({
      exitCode: EXIT_CODE.NOT_FOUND,
      context: {
        code: "npm_package_not_found",
        recovery: {
          attempted_command: "pm install --project npm:left-pad-private-missing",
          normalized_args: ["install", "--project", "npm:left-pad-private-missing"],
        },
      },
    });
    expect(error?.context.recovery?.fallback_candidates).toBeUndefined();
    expect(error?.context.recovery?.next_best_command).toBeUndefined();
  });

  it("keeps generic not-found matching scoped to npm pack wrapping", () => {
    const genericNotFound = new Error("tar command failed: archive member not found");
    expect(isNpmNotFoundError(genericNotFound)).toBe(false);
    expect(isNpmPackNotFoundError(genericNotFound)).toBe(true);
    expect(wrapNpmPackResolutionError("pm-synthetic", genericNotFound)?.context.code).toBe("npm_package_not_found");
  });

  it("installs, explores, manages, toggles activation, and uninstalls a local extension", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "sample-source-ext");
      await writeTestExtension({
        root: sourceDir,
        name: "sample-ext",
        manifestOverrides: {
          priority: 50,
        },
      });

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
            runtime_active: true,
            activation_status: "ok",
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

  it("reports runtime command paths during explore and keeps them invocable", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "pm-graph-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "pm-graph",
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
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'pm-graph export',",
          "      description: 'Export graph data.',",
          "      run: (context) => ({ ok: true, command: context.command, args: context.args })",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );
      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });

      const explore = await runExtension(undefined, { explore: true, project: true }, { path: context.pmPath });
      const extensions = (explore.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(extensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "pm-graph",
            active: true,
            enabled: true,
            runtime_active: true,
            activation_status: "ok",
            command_paths: ["pm-graph export"],
            action_paths: ["pm-graph-export"],
          }),
        ]),
      );
      expect(explore.details.runtime_probe).toMatchObject({
        requested: true,
        executed: true,
        reason: "explore_defaults_to_runtime_probe",
      });

      const invoked = spawnSync(process.execPath, [path.join(process.cwd(), "dist/cli.js"), "--path", context.pmPath, "pm-graph", "export", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PM_TELEMETRY_DISABLED: "1",
          PM_SENTRY_DISABLED: "1",
        },
      });
      expect(invoked.status).toBe(0);
      expect(JSON.parse(invoked.stdout) as Record<string, unknown>).toMatchObject({
        ok: true,
        command: "pm-graph export",
      });
    });
  });

  it("installs in place when source is already in extension root", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.pmPath, "extensions", "inline-ext");
      await writeTestExtension({
        root: sourceDir,
        manifest: {
          name: "inline-ext",
          version: "1.0.0",
          entry: "index.js",
        },
      });

      const install = await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });
      expect(install.details).toMatchObject({
        installed_in_place: true,
      });
    });
  });

  it("retries when an extension install copy races with an existing destination", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-copy-race-"));
    try {
      const sourceDir = path.join(tempRoot, "source");
      const destinationDir = path.join(tempRoot, "destination");
      await writeTestExtension({
        root: sourceDir,
        name: "race-ext",
      });

      let attempts = 0;
      const raceError = Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" });
      await copyExtensionDirectoryForInstall(sourceDir, destinationDir, async (source, destination, options) => {
        attempts += 1;
        if (attempts === 1) {
          throw raceError;
        }
        await fsPromisesCp(source, destination, options);
      });

      expect(attempts).toBe(2);
      await expect(readFile(path.join(destinationDir, "manifest.json"), "utf8")).resolves.toContain("race-ext");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("covers extension install lock acquisition and cleanup helpers", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-lock-helper-"));
    try {
      const result = await extensionCommandTestOnly.withExtensionInstallLock(tempRoot, "lock-ext", async () => "locked");
      expect(result).toBe("locked");
      await expect(readdir(path.join(tempRoot, "runtime", "extension-install-locks"))).resolves.toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reclaims stale extension install lock directories before acquiring lock", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-lock-stale-"));
    try {
      const lockRoot = path.join(tempRoot, "runtime", "extension-install-locks");
      const lockPath = path.join(lockRoot, "stale-ext.lock");
      await mkdir(lockPath, { recursive: true });
      const staleDate = new Date(Date.now() - 10 * 60 * 1000);
      await utimes(lockPath, staleDate, staleDate);

      const result = await extensionCommandTestOnly.withExtensionInstallLock(tempRoot, "stale-ext", async () => "stale-reclaimed");
      expect(result).toBe("stale-reclaimed");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("times out when a non-stale extension install lock remains held", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-lock-timeout-"));
    try {
      const lockPath = path.join(tempRoot, "runtime", "extension-install-locks", "busy-ext.lock");
      await mkdir(lockPath, { recursive: true });
      await expect(
        extensionCommandTestOnly.withExtensionInstallLock(
          tempRoot,
          "busy-ext",
          async () => "never-acquired",
          { attempts: 1, delay_ms: 0, stale_ms: 60_000 },
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("handles missing lock stat metadata during install lock retries", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-lock-stat-missing-"));
    try {
      const lockRoot = path.join(tempRoot, "runtime", "extension-install-locks");
      const lockPath = path.join(lockRoot, "missing-stat-ext.lock");
      await mkdir(lockRoot, { recursive: true });
      await symlink(path.join(lockRoot, "does-not-exist"), lockPath);
      await expect(
        extensionCommandTestOnly.withExtensionInstallLock(
          tempRoot,
          "missing-stat-ext",
          async () => "unreachable",
          { attempts: 1, delay_ms: 0, stale_ms: 60_000 },
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("sorts managed entries by scope/name/directory tie-breaker", () => {
    const sorted = sortManagedEntries([
      {
        name: "same-name",
        directory: "b-dir",
        scope: "project",
        manifest_version: "1.0.0",
        manifest_entry: "index.js",
        capabilities: [],
        installed_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        source: { kind: "local", input: "./b", location: "./b" },
      },
      {
        name: "same-name",
        directory: "a-dir",
        scope: "project",
        manifest_version: "1.0.0",
        manifest_entry: "index.js",
        capabilities: [],
        installed_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        source: { kind: "local", input: "./a", location: "./a" },
      },
    ]);
    expect(sorted.map((entry) => entry.directory)).toEqual(["a-dir", "b-dir"]);
  });

  it("stages extension copies when the destination is nested inside the source", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-self-nesting-"));
    try {
      const sourceDir = path.join(tempRoot, "source");
      const destinationDir = path.join(sourceDir, ".agents", "pm", "extensions", "root-ext");
      await writeTestExtension({
        root: sourceDir,
        name: "root-ext",
      });
      await mkdir(path.dirname(destinationDir), { recursive: true });

      await copyExtensionDirectoryForInstall(sourceDir, destinationDir);

      await expect(readFile(path.join(destinationDir, "manifest.json"), "utf8")).resolves.toContain("root-ext");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects scaffold targets that already exist as regular files", async () => {
    await withTempPmPath(async (context) => {
      const targetFile = path.join(context.tempRoot, "existing-file-target");
      await writeFile(targetFile, "occupied\n", "utf8");
      await expect(runExtension(targetFile, { init: true, project: true }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("exists and is not a directory"),
      });
    });
  });

  it("marks unmanaged discovered extensions as skipped_unmanaged during manage", async () => {
    await withTempPmPath(async (context) => {
      const unmanagedDir = path.join(context.pmPath, "extensions", "manual-unmanaged");
      await writeTestExtension({ root: unmanagedDir, name: "manual-unmanaged" });

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
      await writeTestExtension({ root: unmanagedDir, name: "builtin-informational-ext" });

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
      await writeTestExtension({ root: unmanagedDir, name: "manual-fix-managed" });

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
      await writeTestExtension({ root: unmanagedDir, name: "manual-parity" });

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
      await writeTestExtension({ root: unmanagedDir, name: "manual-adopt" });

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
      await writeTestExtension({ root: unmanagedDir, name: "manual-adopt-repeat" });

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
      await writeTestExtension({ root: unmanagedDir, name: "manual-adopt-gh" });

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
      await writeTestExtension({ root: firstUnmanagedDir, name: "manual-adopt-all-a" });
      await writeTestExtension({ root: secondUnmanagedDir, name: "manual-adopt-all-b" });

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
      await writeTestExtension({
        root: sourceDir,
        name: "doctor-ext",
        manifestOverrides: {
          capabilities: ["schema"],
        },
        entrySource:
          "export function activate(api) { api.registerItemTypes([{ name: \"DoctorAsset\", folder: \"doctor-assets\" }]); }\n",
      });
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

  it("elides activation failure traces in deep doctor output unless trace is requested", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "doctor-failing-ext");
      await writeTestExtension({
        root: sourceDir,
        name: "doctor-failing-ext",
        manifestOverrides: {
          capabilities: ["commands"],
        },
        entrySource: "export function activate() { throw new Error('doctor activation failed'); }\n",
      });
      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });

      const deepDoctor = await runExtension(undefined, { doctor: true, project: true, detail: "deep" }, { path: context.pmPath });
      const activationWithoutTrace = (deepDoctor.details.deep as { activation?: { failed?: Array<Record<string, unknown>> } }).activation
        ?.failed ?? [];
      expect(activationWithoutTrace).toEqual([
        expect.objectContaining({
          name: "doctor-failing-ext",
        }),
      ]);
      expect(activationWithoutTrace[0]).not.toHaveProperty("trace");
      expect(deepDoctor.details.summary).toMatchObject({
        activation_failure_count: 1,
        has_blocking_failures: true,
      });

      const tracedDoctor = await runExtension(undefined, { doctor: true, project: true, detail: "deep", trace: true }, { path: context.pmPath });
      const activationWithTrace = (tracedDoctor.details.deep as { activation?: { failed?: Array<Record<string, unknown>> } }).activation
        ?.failed ?? [];
      expect(activationWithTrace[0]).toHaveProperty("trace");
      expect(tracedDoctor.details.trace_enabled).toBe(true);
    });
  });

  it("surfaces failed managed GitHub update checks in doctor diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const extensionsRoot = path.join(context.pmPath, "extensions");
      const extensionDir = path.join(extensionsRoot, "github-update-failed");
      await writeTestExtension({ root: extensionDir, name: "github-update-failed" });
      const state = upsertManagedEntry(createEmptyManagedExtensionState(), {
        name: "github-update-failed",
        directory: "github-update-failed",
        scope: "project",
        manifest_version: "1.0.0",
        manifest_entry: "index.js",
        capabilities: ["commands"],
        installed_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        source: {
          kind: "github",
          input: "owner/repo",
          location: ".",
          repository: "https://github.com/owner/repo.git",
          owner: "owner",
          repo: "repo",
        },
        update_error: "network_down",
      });
      await writeManagedExtensionState(extensionsRoot, state);

      const doctor = await runExtension(undefined, { doctor: true, project: true }, { path: context.pmPath });
      expect(doctor.warnings).toEqual(expect.arrayContaining(["extension_update_check_failed:github-update-failed"]));
      expect(doctor.details.summary).toMatchObject({
        update_check_failed_total: 1,
      });
      expect(doctor.details.triage).toMatchObject({
        update_check_failed_total: 1,
        remediation: expect.arrayContaining(["Run pm extension --manage --project after validating network and repository access."]),
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

  it("reports global output service and renderer override diagnostics in doctor", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "output-footgun-source");
      await writeTestExtension({
        root: sourceDir,
        name: "output-footgun-ext",
        manifestOverrides: {
          capabilities: ["services", "renderers"],
        },
        entrySource: [
          "export function activate(api) {",
          "  api.registerService('output_format', () => ({ format: 'toon' }));",
          "  api.registerRenderer('json', () => JSON.stringify({ rendered_by: 'output-footgun-ext' }));",
          "}",
          "",
        ].join("\n"),
      });
      await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });

      const doctor = await runExtension(undefined, { doctor: true, project: true, detail: "deep" }, { path: context.pmPath });
      const summary = doctor.details.summary as {
        warning_codes: string[];
        remediation: string[];
      };

      expect(summary.warning_codes).toEqual(
        expect.arrayContaining([
          "extension_output_renderer_override_global",
          "extension_output_service_override_global",
        ]),
      );
      expect(summary.remediation.join(" ")).toContain("return context.payload/null/undefined");
      expect(JSON.stringify(doctor)).not.toContain("__pm_native_output");
    });
  });

  it("uses flag-form package commands in package doctor remediation", () => {
    const summary = buildExtensionTriageSummary(
      "project",
      ["extension_manifest_missing:manual-package"],
      [
        {
          name: "manual-package",
          directory: "/tmp/manual-package",
          version: "1.0.0",
          entry: "./index.js",
          scope: "project",
          managed: false,
          enabled: true,
          active: true,
          runtime_active: true,
          activation_status: "active",
          update_check_status: "skipped_unmanaged",
          update_check_reason: "unmanaged",
        },
      ],
      { vocabulary: "package" },
    );

    expect(summary.remediation.join(" ")).toContain("pm package --explore --project");
    expect(summary.remediation.join(" ")).toContain("pm package --adopt-all --project");
    expect(summary.remediation.join(" ")).toContain("pm package --install --project <source>");
    expect(summary.remediation.join(" ")).not.toContain("pm package install");
  });

  it("reports actionable package remediation for registration collisions", () => {
    const baseExtension = {
      directory: "/tmp/extension",
      version: "1.0.0",
      entry: "./index.js",
      scope: "project" as const,
      managed: true,
      enabled: true,
      active: true,
      runtime_active: true,
      activation_status: "ok" as const,
      update_check_status: "skipped_non_github" as const,
      update_check_reason: "managed_source_kind_npm",
    };
    const summary = buildExtensionTriageSummary(
      "project",
      [
        "extension_preflight_override_collision:project:pm-starter:project:pm-ts-starter",
        "extension_renderer_collision:json:project:pm-starter:project:pm-ts-starter",
        "extension_command_handler_collision:acme:sync:project:pm-starter:project:pm-ts-starter",
        "extension_command_override_handler_overlap:acme:sync:project:pm-starter:project:pm-ts-starter",
      ],
      [
        {
          ...baseExtension,
          name: "pm-starter",
        },
        {
          ...baseExtension,
          name: "pm-ts-starter",
        },
      ],
      { vocabulary: "package" },
    );

    expect(summary.warning_codes).toEqual(
      expect.arrayContaining([
        "extension_command_handler_collision",
        "extension_command_override_handler_overlap",
        "extension_preflight_override_collision",
        "extension_renderer_collision",
      ]),
    );
    expect(summary.remediation.join(" ")).toContain("Conflicting extensions: pm-starter, pm-ts-starter");
    expect(summary.remediation.join(" ")).not.toContain("Conflicting extensions: project");
    expect(summary.remediation.join(" ")).toContain("pm package --deactivate <name> --project");
    expect(summary.remediation.join(" ")).toContain("pm package --doctor --project --detail deep --trace");
    expect(summary.collision_plan).toMatchObject({
      status: "conflicts_detected",
      collision_count: 4,
      extension_count: 2,
      next_best_command: "pm package --doctor --project --detail deep --trace",
      remediation_candidates: [
        {
          action: "deactivate",
          extension: "pm-starter",
          command: "pm package --deactivate pm-starter --project",
          affected_collisions: 4,
        },
        {
          action: "deactivate",
          extension: "pm-ts-starter",
          command: "pm package --deactivate pm-ts-starter --project",
          affected_collisions: 4,
        },
      ],
    });
    expect(summary.collision_plan?.collisions.map((entry) => entry.surface)).toEqual(
      expect.arrayContaining(["acme:sync", "json", "global"]),
    );

    const ranked = buildExtensionTriageSummary(
      "project",
      [
        "extension_command_handler_collision:alpha:project:many:project:light",
        "extension_command_handler_collision:beta:project:many:project:heavy",
        "extension_command_handler_collision:gamma:project:heavy:project:light",
      ],
      [
        {
          ...baseExtension,
          name: "many",
          command_paths: ["many command"],
        },
        {
          ...baseExtension,
          name: "heavy",
          command_paths: ["heavy one", "heavy two"],
          action_paths: ["heavy:action"],
        },
        {
          ...baseExtension,
          name: "light",
        },
      ],
      { vocabulary: "extension" },
    );
    expect(ranked.collision_plan?.remediation_candidates.map((entry) => entry.extension)).toEqual([
      "light",
      "many",
      "heavy",
    ]);
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

  it("reports missing manifest capabilities as actionable activation diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "doctor-missing-capability-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "doctor-missing-capability-ext",
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
          "    api.registerPreflight(() => ({ ok: true }));",
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
      const triage = doctor.details.triage as { warning_codes?: string[]; remediation?: string[] };
      const deep = doctor.details.deep as {
        trace?: { activation_failures?: Array<Record<string, unknown>> };
      };

      expect(triage.warning_codes).toContain("extension_capability_missing");
      expect(triage.remediation?.join("\n")).toContain("missing_capability");
      expect(deep.trace?.activation_failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "doctor-missing-capability-ext",
            method: "registerPreflight",
            capability: "preflight",
            missing_capability: "preflight",
            expected_schema: '"capabilities": [..., "preflight"]',
          }),
        ]),
      );
    });
  });

  it("validates action flags and missing targets", async () => {
    // Bare invocation now defaults to --explore; verify it returns ok=true instead of throwing
    const bareResult = await runExtension(undefined, {}, { path: ".agents/pm" });
    expect(bareResult.action).toBe("explore");
    expect(bareResult.ok).toBe(true);
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
    await expect(runExtension("init", { init: true, gh: "owner/repo/ext" }, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runExtension("init", { init: true, ref: "main" }, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runExtension("target", { reload: true }, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runExtension("target", { catalog: true }, { path: ".agents/pm" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runExtension("*", { install: true, ref: "main" }, { path: ".agents/pm" })).rejects.toMatchObject({
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

  it("runs default explore and opt-in manage runtime probes without changing default manage semantics", async () => {
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
        reason: "runtime_probe_requested",
      });
      expect(manageProbe.warnings).toEqual(expect.arrayContaining(["extension_activate_failed:project:runtime-probe-ext"]));

      const exploreProbe = await runExtension(undefined, { explore: true, project: true }, { path: context.pmPath });
      const exploreExtensions = (exploreProbe.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(exploreExtensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "runtime-probe-ext",
            runtime_active: false,
            activation_status: "failed",
          }),
        ]),
      );
      expect(exploreProbe.details.runtime_probe).toMatchObject({
        requested: true,
        executed: true,
        reason: "explore_defaults_to_runtime_probe",
      });
    });
  });

  it("surfaces activation failure diagnostics in install and explore flows", async () => {
    await withTempPmPath(async (context) => {
      const sourceDir = path.join(context.tempRoot, "activation-diag-source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, "manifest.json"),
        JSON.stringify(
          {
            name: "activation-diag-ext",
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
        [
          "export function activate(api) {",
          "  api.registerCommand('activation-diag ping', () => ({ ok: true }));",
          "  api.registerItemFields([]);",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const install = await runExtension(sourceDir, { install: true, project: true }, { path: context.pmPath });
      expect(install.warnings).toEqual(expect.arrayContaining(["extension_activate_failed:project:activation-diag-ext"]));
      expect(install.details).toMatchObject({
        runtime_activation_status: "failed",
        activation_diagnostics: {
          failed_count: 1,
          installed_extension_failed: expect.objectContaining({
            name: "activation-diag-ext",
            missing_capability: "schema",
          }),
        },
      });

      const installedFailure = (install.details as { activation_diagnostics?: { installed_extension_failed?: { hint?: unknown } } })
        .activation_diagnostics?.installed_extension_failed;
      expect(typeof installedFailure?.hint).toBe("string");
      expect((installedFailure?.hint as string).toLowerCase()).toContain("schema");

      const explore = await runExtension(undefined, { explore: true, project: true }, { path: context.pmPath });
      const listed = (explore.details.extensions as Array<Record<string, unknown>>) ?? [];
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "activation-diag-ext",
            runtime_active: false,
            activation_status: "failed",
          }),
        ]),
      );
      expect(explore.details).toMatchObject({
        activation_diagnostics: {
          failed_count: 1,
          failed: [
            expect.objectContaining({
              name: "activation-diag-ext",
              missing_capability: "schema",
            }),
          ],
        },
      });
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
