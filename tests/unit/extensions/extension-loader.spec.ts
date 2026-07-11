import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  _testOnlyLoader,
  activateExtensions,
  deactivateExtensions,
  discoverExtensions,
  loadExtensions,
  nextExtensionReloadToken,
  runCommandHandler,
  runCommandOverride,
  runParserOverride,
  runPreflightOverride,
  resolveExtensionRoots,
  runAfterCommandHooks,
  runBeforeCommandHooks,
  runOnIndexHooks,
  runOnReadHooks,
  runRendererOverride,
  runServiceOverride,
  runServiceOverrideSync,
  runOnWriteHooks,
  type ExtensionApi,
  type ExtensionLoadResult,
  type ExtensionManifest,
} from "../../../src/core/extensions/loader.js";
import {
  createDefaultExtensionGovernancePolicy,
  type ExtensionGovernancePolicy,
  type ExtensionSelfIdentity,
} from "../../../src/core/extensions/extension-types.js";
import {
  KNOWN_ITEM_FIELD_TYPES,
  normalizeItemFieldType,
  suggestKnownItemFieldType,
} from "../../../src/core/extensions/item-field-types.js";
import {
  flattenFlagListValue,
  isFlagDefaultValueCoercible,
  resolveFlagValueKind,
} from "../../../src/core/extensions/flag-value-types.js";
import {
  evaluateExtensionPolicyForExtension,
  evaluateExtensionPolicyForRegistration,
  hydrateExtensionPolicy,
  normalizeExtensionPolicy,
  normalizePmMaxVersionExceededMode,
  normalizePolicySandboxProfile,
  serializeExtensionPolicy,
} from "../../../src/core/extensions/extension-policy.js";
import { readSettings } from "../../../src/core/store/settings.js";
import { collectExtensionCommandHelpDescriptors } from "../../../src/cli/extension-command-help.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

async function createExtension(
  root: string,
  directory: string,
  manifest: Partial<ExtensionManifest> | null,
  entrySource?: string,
): Promise<void> {
  await writeTestExtension({
    root,
    directory,
    manifest,
    entryFilename: typeof manifest?.entry === "string" ? manifest.entry : "index.mjs",
    entrySource: entrySource ?? null,
  });
}

function createTestExtensionPolicy(overrides: Partial<ExtensionGovernancePolicy> = {}): ExtensionGovernancePolicy {
  return {
    ...createDefaultExtensionGovernancePolicy(),
    ...overrides,
  };
}

async function loadSettings(context: TempPmContext) {
  return readSettings(context.pmPath);
}

interface OverrideActivationApi {
  registerCommand: (
    command: string,
    run: (context: {
      result: unknown;
      command: string;
      args: string[];
      options: Record<string, unknown>;
      global: { json: boolean; quiet: boolean; noExtensions: boolean; profile: boolean };
      pm_root: string;
    }) => unknown,
  ) => void;
  registerRenderer: (
    format: "toon" | "json",
    run: (context: {
      format: "toon" | "json";
      command: string;
      args: string[];
      options: Record<string, unknown>;
      global: { json: boolean; quiet: boolean; noExtensions: boolean; profile: boolean };
      pm_root: string;
      result: unknown;
    }) => string,
  ) => void;
}

/**
 * Builds a loaded-extension entry for the given layer whose activate hook
 * registers a `list-open` command override plus a JSON renderer override, both
 * tagging their output with the layer name as `source` so override precedence
 * between layers stays observable.
 */
function buildOverrideLoadedExtension(layer: "global" | "project", name: string, priority: number) {
  return {
    layer,
    directory: name,
    manifest_path: `/tmp/${layer}/${name}/manifest.json`,
    name,
    version: "1.0.0",
    entry: "./index.mjs",
    priority,
    entry_path: `/tmp/${layer}/${name}/index.mjs`,
    module: {
      activate(api: OverrideActivationApi) {
        api.registerCommand("list-open", (context) => ({
          ...(context.result as Record<string, unknown>),
          source: layer,
          limit: context.options.limit,
          json: context.global.json,
        }));
        api.registerRenderer("json", (context) =>
          JSON.stringify({
            source: layer,
            command: context.command,
            limit: context.options.limit,
            json: context.global.json,
            pm_root: context.pm_root,
            result: context.result,
          }),
        );
      },
    },
  };
}

describe("extension loader", () => {
  it("creates independent extension policy defaults", () => {
    const first = createDefaultExtensionGovernancePolicy();
    const second = createDefaultExtensionGovernancePolicy();

    first.allowed_extensions.push("first-only");
    first.extension_overrides.push({ name: "first-override" });

    expect(second.allowed_extensions).toEqual([]);
    expect(second.extension_overrides).toEqual([]);
  });

  it("generates monotonic extension reload tokens with explicit seeds", () => {
    const first = nextExtensionReloadToken(100);
    const second = nextExtensionReloadToken(100);

    expect(first).toMatch(/^\d+-100$/);
    expect(second).toMatch(/^\d+-100$/);
    expect(Number(second.split("-", 1)[0])).toBeGreaterThan(Number(first.split("-", 1)[0]));
  });

  it("covers loader pure helper fallback branches", () => {
    expect(_testOnlyLoader.parseComparableVersion(" v1.2.3-beta ")).toEqual([1, 2, 3]);
    expect(_testOnlyLoader.parseComparableVersion(">= 2026.6.13")).toEqual([2026, 6, 13]);
    expect(_testOnlyLoader.parseComparableVersion("latest")).toBeNull();
    expect(_testOnlyLoader.compareComparableVersions("1.2", "1.2.0")).toBe(0);
    expect(_testOnlyLoader.compareComparableVersions("1.2.1", "1.2.0")).toBe(1);
    expect(_testOnlyLoader.compareComparableVersions("1.1.9", "1.2.0")).toBe(-1);
    expect(_testOnlyLoader.compareComparableVersions("nightly", "1.0.0")).toBeNull();
    expect(
      _testOnlyLoader.sanitizeRegistrationValue({
        zed: 1n,
        alpha: Symbol.for("pm"),
        nested: [() => true, { beta: "value" }],
      }),
    ).toEqual({
      alpha: "Symbol(pm)",
      nested: ["[Function]", { beta: "value" }],
      zed: "1",
    });

    expect(_testOnlyLoader.resolveCommandDefinitionAction("team sync", undefined)).toBe("team-sync");
    expect(() => _testOnlyLoader.resolveCommandDefinitionAction("team sync", 42)).toThrow(/non-empty string/);
    expect(() => _testOnlyLoader.resolveCommandDefinitionAction("team sync", "!!!")).toThrow(/alphanumeric/);
    expect(() =>
      _testOnlyLoader.normalizeCommandDefinitionArguments([
        { name: "files", variadic: true },
        { name: "extra" },
      ]),
    ).toThrow(/final argument/);
  });

  it("covers managed package metadata and version compatibility helper branches", async () => {
    await withTempPmPath(async (context) => {
      const extensionsRoot = path.join(context.tempRoot, "managed-source-packages");
      await mkdir(extensionsRoot, { recursive: true });
      await writeFile(path.join(extensionsRoot, ".managed-extensions.json"), '"not-an-object"\n', "utf8");
      await expect(_testOnlyLoader.readManagedExtensionSourcePackages(extensionsRoot)).resolves.toEqual(new Map());

      await writeFile(
        path.join(extensionsRoot, ".managed-extensions.json"),
        JSON.stringify({
          entries: [
            null,
            { directory: "dir-ext", name: "name-ext", source: { package: " @scope/pkg " } },
            { directory: "dir-only", source: { package: " @scope/pkg " } },
            { directory: "missing-source", source: { package: "" } },
          ],
        }),
        "utf8",
      );
      await expect(_testOnlyLoader.readManagedExtensionSourcePackages(extensionsRoot)).resolves.toEqual(
        new Map([
          ["directory:dir-ext", "@scope/pkg"],
          ["directory:dir-only", "@scope/pkg"],
          ["name:name-ext", "@scope/pkg"],
        ]),
      );
    });

    const manifest = {
      name: "versioned-ext",
      version: "1.0.0",
      entry: "index.mjs",
      capabilities: [],
      priority: 100,
    } as ExtensionManifest;
    await expect(
      _testOnlyLoader.evaluatePmMinVersionCompatibility("project", { ...manifest, pm_min_version: "not-a-version" }),
    ).resolves.toEqual({
      allowed: false,
      warning: "extension_pm_min_version_invalid:project:versioned-ext:required=not-a-version",
    });
    await expect(
      _testOnlyLoader.evaluatePmMinVersionCompatibility("project", { ...manifest, pm_min_version: "9999.0.0" }),
    ).resolves.toEqual(
      expect.objectContaining({
        allowed: false,
        warning: expect.stringContaining("extension_pm_min_version_unmet:project:versioned-ext:required=9999.0.0"),
      }),
    );
    await expect(
      _testOnlyLoader.evaluatePmMaxVersionCompatibility("project", { ...manifest, pm_max_version: "not-a-version" }, "warn"),
    ).resolves.toEqual({
      allowed: false,
      warning: "extension_pm_max_version_invalid:project:versioned-ext:allowed=not-a-version",
    });
  });

  it("normalizes and evaluates extension policy edge branches", () => {
    expect(normalizePolicySandboxProfile(" Strict ")).toBe("strict");
    expect(normalizePolicySandboxProfile("unknown")).toBe("none");
    expect(normalizePmMaxVersionExceededMode("warn")).toEqual({ global: "warn", project: "warn" });
    expect(normalizePmMaxVersionExceededMode({ global: "warn", project: "bad" })).toEqual({
      global: "warn",
      project: "block",
    });
    expect(normalizePmMaxVersionExceededMode(["warn"] as never)).toEqual({ global: "block", project: "block" });
    expect(
      normalizeExtensionPolicy({
        extensions: {
          policy: createTestExtensionPolicy({
            mode: "mystery" as never,
            trust_mode: "also-mystery" as never,
          }),
        },
      } as never),
    ).toMatchObject({ mode: "off", trustMode: "off" });

    const settings = {
      extensions: {
        policy: createTestExtensionPolicy({
          mode: "warn",
          trust_mode: "warn",
          require_provenance: true,
          default_sandbox_profile: "strict",
          allowed_extensions: ["alpha"],
          blocked_capabilities: ["hooks"],
          blocked_surfaces: ["commands:handler"],
          blocked_commands: ["blocked command"],
          blocked_actions: ["blocked-action"],
          blocked_services: ["output_format"],
          extension_overrides: [
            {
              name: "alpha",
              require_trusted: true,
              require_provenance: true,
              sandbox_profile: "restricted",
              allowed_commands: ["allowed command"],
              blocked_actions: ["override-action"],
            },
            { name: "  " },
          ],
        }),
      },
    };
    const policy = normalizeExtensionPolicy(settings as never);
    const permissivePolicy = normalizeExtensionPolicy({
      extensions: {
        policy: createTestExtensionPolicy({
          mode: "warn",
          trust_mode: "off",
          default_sandbox_profile: "none",
        }),
      },
    } as never);
    expect(evaluateExtensionPolicyForExtension(permissivePolicy, { layer: "project", name: "alpha" })).toEqual({
      allowed: true,
      warning: null,
    });
    expect(policy.blockedSurfaces).toEqual(new Set(["commands.handler"]));
    expect(
      normalizeExtensionPolicy({
        extensions: {
          policy: createTestExtensionPolicy({
            blocked_surfaces: [" :: "],
          }),
        },
      } as never).blockedSurfaces,
    ).toEqual(new Set());

    const serialized = serializeExtensionPolicy(policy);
    expect(serialized.pm_max_version_exceeded_mode).toBe("block");
    expect(serialized.extension_overrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "alpha",
          require_trusted: true,
          require_provenance: true,
          sandbox_profile: "restricted",
          allowed_commands: ["allowed command"],
          blocked_actions: ["override-action"],
        }),
      ]),
    );
    expect(hydrateExtensionPolicy(serialized).blockedSurfaces).toEqual(new Set(["commands.handler"]));
    expect(
      serializeExtensionPolicy(
        normalizeExtensionPolicy({
          extensions: {
            policy: createTestExtensionPolicy({
              extension_overrides: [{ name: "zulu" }, { name: "alpha" }],
            }),
          },
        } as never),
      ).extension_overrides?.map((override) => override.name),
    ).toEqual(["alpha", "zulu"]);

    const alpha = {
      layer: "project" as const,
      name: "alpha",
      trusted: false,
      provenanceVerified: false,
      permissions: { process_spawn: true },
    };
    expect(evaluateExtensionPolicyForExtension(policy, alpha)).toEqual({
      allowed: true,
      warning: "extension_policy_violation_trust:project:alpha:reason=extension_untrusted",
    });
    expect(evaluateExtensionPolicyForExtension(policy, { ...alpha, trusted: true })).toEqual({
      allowed: true,
      warning: "extension_policy_violation_trust:project:alpha:reason=provenance_missing_or_unverified",
    });
    expect(
      evaluateExtensionPolicyForExtension(policy, {
        ...alpha,
        trusted: true,
        provenanceVerified: true,
        permissions: { process_spawn: true },
      }),
    ).toEqual({
      allowed: true,
      warning: "extension_policy_violation_extension:project:alpha:reason=sandbox_restricted_disallows_process_spawn",
    });
    expect(evaluateExtensionPolicyForExtension(policy, { ...alpha, name: "beta", trusted: true, provenanceVerified: true })).toEqual({
      allowed: true,
      warning: "extension_policy_violation_extension:project:beta:reason=extension_not_allowlisted",
    });
    expect(
      evaluateExtensionPolicyForExtension(
        normalizeExtensionPolicy({
          extensions: {
            policy: createTestExtensionPolicy({
              mode: "warn",
              trust_mode: "warn",
            }),
          },
        } as never),
        { layer: "project", name: "open-ext", trusted: true, provenanceVerified: true },
      ),
    ).toEqual({ allowed: true, warning: null });

    expect(evaluateExtensionPolicyForRegistration(policy, alpha, "commands.handler", " register handler ", "commands")).toEqual({
      allowed: true,
      warning:
        "extension_policy_violation_registration:project:alpha:reason=surface_blocked:capability=commands:method=register_handler:surface=commands.handler",
    });
    expect(
      evaluateExtensionPolicyForRegistration(policy, alpha, "commands.handler", "Register Handler", "commands", {
        command: "Blocked   Command",
      }),
    ).toEqual({
      allowed: true,
      warning:
        "extension_policy_violation_registration:project:alpha:reason=surface_blocked:capability=commands:command=blocked command:method=register_handler:surface=commands.handler",
    });
    expect(
      evaluateExtensionPolicyForRegistration(policy, alpha, "services.register", "Register Service", undefined, {
        service: "output_format",
      }),
    ).toEqual({
      allowed: true,
      warning:
        "extension_policy_violation_registration:project:alpha:reason=service_blocked:method=register_service:service=output_format:surface=services.register",
    });
  });

  it("resolves project and global extension roots from PM paths", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      expect(roots).toEqual({
        global: path.join(context.env.PM_GLOBAL_PATH as string, "extensions"),
        project: path.join(context.pmPath, "extensions"),
      });
    });
  });

  it("threads managed npm package identifiers through discovered and loaded extensions", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "package-backed-ext",
        {
          name: "standup",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default {name: 'standup'};\n",
      );
      await writeFile(
        path.join(roots.project, ".managed-extensions.json"),
        `${JSON.stringify(
          {
            version: 1,
            entries: [
              {
                name: "standup",
                directory: "package-backed-ext",
                source: {
                  kind: "npm",
                  input: "npm:@unbraind/pm-slack-standup",
                  location: ".",
                  package: "@unbraind/pm-slack-standup",
                },
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "standup",
          source_package: "@unbraind/pm-slack-standup",
        }),
      ]);

      const loaded = await loadExtensions({ pmRoot: context.pmPath, settings });
      expect(loaded.loaded).toEqual([
        expect.objectContaining({
          name: "standup",
          source_package: "@unbraind/pm-slack-standup",
        }),
      ]);
    });
  });

  it("exposes registered command package identifiers in command help descriptors", () => {
    const descriptors = collectExtensionCommandHelpDescriptors(
      [],
      [
        {
          layer: "project",
          name: "standup",
          source_package: "@unbraind/pm-slack-standup",
          command: "standup",
          action: "standup",
          examples: [],
          failure_hints: [],
          arguments: [],
        },
      ],
      [],
    );

    expect(descriptors.get("standup")?.source).toEqual({
      layer: "project",
      name: "standup",
      package: "@unbraind/pm-slack-standup",
    });
  });

  it("skips blank handler command paths when collecting help descriptors", () => {
    const descriptors = collectExtensionCommandHelpDescriptors(["   ", "tools export"], [], []);
    expect([...descriptors.keys()]).toEqual(["tools export"]);
  });

  it("inherits canonical contracts for flattened extension aliases", () => {
    const descriptors = collectExtensionCommandHelpDescriptors(
      ["csv-export export"],
      [{
        layer: "project",
        name: "csv",
        command: "csv export",
        action: "export",
        examples: ["pm csv export"],
        failure_hints: [],
        arguments: [{ name: "file", required: false }],
      }],
      [{ target_command: "csv export", flags: [{ long: "--output", value_name: "path" }] }],
      new Map([["csv-export export", "csv export"]]),
    );

    expect(descriptors.get("csv-export export")).toMatchObject({
      command: "csv-export export",
      action: "export",
      arguments: [{ name: "file", required: false }],
      flags: [{ long: "--output", value_name: "path" }],
    });

    const unrelated = collectExtensionCommandHelpDescriptors(
      ["hot-reload reload"],
      [{
        layer: "project",
        name: "other",
        command: "hot reload",
        action: "reload",
        examples: [],
        failure_hints: [],
        arguments: [],
      }],
      [],
    );
    expect(unrelated.get("hot-reload reload")?.source).toBeUndefined();
  });

  it("discovers deterministic effective extension order with project precedence", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.global,
        "g-alpha",
        {
          name: "alpha-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default {name: 'alpha-ext'};\n",
      );
      await createExtension(
        roots.global,
        "g-shared",
        {
          name: "shared-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
        },
        "export default {layer: 'global'};\n",
      );
      await createExtension(
        roots.project,
        "p-other",
        {
          name: "other-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default {name: 'other-ext'};\n",
      );
      await createExtension(
        roots.project,
        "p-shared",
        {
          name: "shared-ext",
          version: "2.0.0",
          entry: "./index.mjs",
          priority: 5,
        },
        "export default {layer: 'project'};\n",
      );

      const settings = await loadSettings(context);
      settings.extensions.enabled = [" shared-ext ", "alpha-ext", "shared-ext"];
      settings.extensions.disabled = ["alpha-ext"];

      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.disabled_by_flag).toBe(false);
      expect(discovery.configured_enabled).toEqual(["alpha-ext", "shared-ext"]);
      expect(discovery.configured_disabled).toEqual(["alpha-ext"]);
      expect(discovery.warnings).toEqual([]);
      expect(discovery.discovered.map((entry) => entry.name)).toEqual([
        "alpha-ext",
        "shared-ext",
        "other-ext",
        "shared-ext",
      ]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "shared-ext",
          layer: "project",
          version: "2.0.0",
          priority: 5,
        }),
      ]);
    });
  });

  it("applies extension-level governance policy during discovery", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "policy-allowed",
        {
          name: "policy-allowed-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default { ok: true };\n",
      );
      await createExtension(
        roots.project,
        "policy-blocked",
        {
          name: "policy-blocked-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      settings.extensions.policy = createTestExtensionPolicy({
        mode: "enforce",
        allowed_extensions: ["policy-allowed-ext"],
        blocked_extensions: [],
        allowed_capabilities: [],
        blocked_capabilities: [],
        allowed_surfaces: [],
        blocked_surfaces: [],
        extension_overrides: [],
      });

      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.effective.map((entry) => entry.name)).toEqual(["policy-allowed-ext"]);
      expect(discovery.policy.mode).toBe("enforce");
      expect(discovery.warnings).toEqual(
        expect.arrayContaining([
          "extension_policy_blocked_extension:project:policy-blocked-ext:reason=extension_not_allowlisted",
        ]),
      );
    });
  });

  it("normalizes optional manifest activation command metadata during discovery", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "activation-metadata",
        {
          name: "activation-metadata-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands", "schema"],
          activation: {
            commands: ["  Slow   Command ", "slow command", ""],
          },
        },
        "export default { activate() {} };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "activation-metadata-ext",
          activation: {
            commands: ["slow command"],
          },
        }),
      ]);
    });
  });

  it("rejects invalid manifest activation command metadata", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "invalid-activation-metadata",
        {
          name: "invalid-activation-metadata-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands"],
          activation: {
            commands: ["ok", 42],
          },
        } as Partial<ExtensionManifest>,
        "export default { activate() {} };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.effective).toEqual([]);
      expect(discovery.warnings).toContain("extension_manifest_invalid:project:invalid-activation-metadata");
    });
  });

  it("rejects invalid optional manifest object metadata during discovery", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      const variants: Array<[string, Record<string, unknown>]> = [
        ["invalid-engines", { engines: "pm>=1" }],
        ["invalid-sandbox-profile-type", { sandbox_profile: 1 }],
        ["invalid-sandbox-profile", { sandbox_profile: "wat" }],
        ["invalid-provenance", { provenance: "signed" }],
        ["invalid-permissions", { permissions: "all" }],
        ["invalid-permission-boolean", { permissions: { fs_read: "yes" } }],
      ];

      for (const [directory, extraManifest] of variants) {
        const extensionRoot = path.join(roots.project, directory);
        await mkdir(extensionRoot, { recursive: true });
        await writeFile(
          path.join(extensionRoot, "manifest.json"),
          `${JSON.stringify({
            name: `${directory}-ext`,
            version: "1.0.0",
            entry: "./index.mjs",
            ...extraManifest,
          })}\n`,
          "utf8",
        );
        await writeFile(path.join(extensionRoot, "index.mjs"), "export default { activate() {} };\n", "utf8");
      }

      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings: await loadSettings(context),
      });

      expect(discovery.effective).toEqual([]);
      expect(discovery.warnings).toEqual([
        "extension_manifest_invalid:project:invalid-engines",
        "extension_manifest_invalid:project:invalid-permission-boolean",
        "extension_manifest_invalid:project:invalid-permissions",
        "extension_manifest_invalid:project:invalid-provenance",
        "extension_manifest_invalid:project:invalid-sandbox-profile",
        "extension_manifest_invalid:project:invalid-sandbox-profile-type",
      ]);
    });
  });

  it("surfaces capability policy warnings without blocking in warn mode", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "policy-capability-warn",
        {
          name: "policy-capability-warn-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["hooks"],
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      settings.extensions.policy = createTestExtensionPolicy({
        mode: "warn",
        allowed_extensions: [],
        blocked_extensions: [],
        allowed_capabilities: [],
        blocked_capabilities: ["hooks"],
        allowed_surfaces: [],
        blocked_surfaces: [],
        extension_overrides: [],
      });

      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.effective.map((entry) => entry.name)).toEqual(["policy-capability-warn-ext"]);
      expect(discovery.warnings).toEqual(
        expect.arrayContaining([
          "extension_policy_violation_capability:project:policy-capability-warn-ext:reason=capability_blocked:capability=hooks",
        ]),
      );
    });
  });

  it("enforces trust and provenance policy during discovery", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "trusted-provenance-ok",
        {
          name: "trusted-provenance-ok",
          version: "1.0.0",
          entry: "./index.mjs",
          manifest_version: 2,
          trusted: true,
          provenance: {
            source: "example://trusted",
            verified: true,
          },
        },
        "export default { ok: true };\n",
      );
      await createExtension(
        roots.project,
        "trusted-provenance-missing",
        {
          name: "trusted-provenance-missing",
          version: "1.0.0",
          entry: "./index.mjs",
          manifest_version: 2,
          trusted: true,
        },
        "export default { ok: true };\n",
      );
      await createExtension(
        roots.project,
        "untrusted-extension",
        {
          name: "untrusted-extension",
          version: "1.0.0",
          entry: "./index.mjs",
          manifest_version: 2,
          trusted: false,
          provenance: {
            source: "example://untrusted",
            verified: true,
          },
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      settings.extensions.policy = createTestExtensionPolicy({
        mode: "off",
        trust_mode: "enforce",
        require_provenance: true,
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
        extension_overrides: [],
      });

      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.effective.map((entry) => entry.name)).toEqual(["trusted-provenance-ok"]);
      expect(discovery.warnings).toEqual(
        expect.arrayContaining([
          "extension_policy_blocked_trust:project:trusted-provenance-missing:reason=provenance_missing_or_unverified",
          "extension_policy_blocked_trust:project:untrusted-extension:reason=extension_untrusted",
        ]),
      );
    });
  });

  it("enforces sandbox profile restrictions during discovery", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "sandbox-violating",
        {
          name: "sandbox-violating",
          version: "1.0.0",
          entry: "./index.mjs",
          manifest_version: 2,
          trusted: true,
          provenance: {
            source: "example://sandbox",
            verified: true,
          },
          sandbox_profile: "strict",
          permissions: {
            network: true,
          },
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      settings.extensions.policy = createTestExtensionPolicy({
        mode: "enforce",
        trust_mode: "off",
        require_provenance: false,
        trusted_extensions: [],
        default_sandbox_profile: "strict",
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

      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.effective).toEqual([]);
      expect(discovery.warnings).toEqual(
        expect.arrayContaining([
          "extension_policy_blocked_extension:project:sandbox-violating:reason=sandbox_strict_disallows_network",
        ]),
      );
    });
  });

  it("reports deterministic manifest and entry warnings", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);

      await createExtension(
        roots.project,
        "invalid-capabilities",
        {
          name: "invalid-capabilities-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["hooks", 1 as unknown as string],
        },
        "export default {};\n",
      );
      await createExtension(
        roots.project,
        "invalid-priority",
        {
          name: "invalid-priority-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 1.5,
        },
        "export default {};\n",
      );
      await createExtension(roots.project, "missing-entry", {
        name: "missing-entry-ext",
        version: "1.0.0",
        entry: "./missing.mjs",
      });
      await createExtension(roots.project, "missing-manifest", null);
      await writeFile(path.join(roots.project, "outside-target.mjs"), "export default { escaped: true };\n", "utf8");
      await createExtension(roots.project, "outside-entry", {
        name: "outside-entry-ext",
        version: "1.0.0",
        entry: "../outside-target.mjs",
      });
      await createExtension(roots.project, "symlink-escape", {
        name: "symlink-escape-ext",
        version: "1.0.0",
        entry: "./index.mjs",
      });
      await symlink(
        path.join(roots.project, "outside-target.mjs"),
        path.join(roots.project, "symlink-escape", "index.mjs"),
        "file",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([
        "extension_manifest_invalid:project:invalid-capabilities",
        "extension_manifest_invalid:project:invalid-priority",
        "extension_entry_missing:project:missing-entry-ext",
        "extension_manifest_missing:project:missing-manifest",
        "extension_entry_outside_extension:project:outside-entry-ext",
        "extension_entry_outside_extension:project:symlink-escape-ext",
      ]);
      expect(discovery.effective).toEqual([]);
    });
  });

  it("preserves compatible manifest version metadata during discovery", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "compatible-version",
        {
          name: "compatible-version-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          manifest_version: 2,
          pm_min_version: "0.0.0",
          engines: {
            pm: ">=0.0.0",
            node: ">=20",
          },
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "compatible-version-ext",
          manifest_version: 2,
          pm_min_version: "0.0.0",
          engines: {
            pm: ">=0.0.0",
            node: ">=20",
          },
        }),
      ]);
    });
  });

  it("rejects invalid manifest engines metadata during discovery", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "invalid-engines",
        {
          name: "invalid-engines-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          engines: {
            pm: ">=0.0.0",
            node: "",
          },
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.effective).toEqual([]);
      expect(discovery.warnings).toEqual(["extension_manifest_invalid:project:invalid-engines"]);
    });
  });

  it("rejects malformed optional manifest security and compatibility metadata", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      const cases: Array<[string, Partial<ExtensionManifest>]> = [
        [
          "blank-engine-key",
          {
            name: "blank-engine-key-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            engines: { " ": ">=20" },
          } as Partial<ExtensionManifest>,
        ],
        [
          "invalid-manifest-version",
          {
            name: "invalid-manifest-version-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            manifest_version: 1.5,
          } as Partial<ExtensionManifest>,
        ],
        [
          "invalid-permissions",
          {
            name: "invalid-permissions-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            permissions: { fs_read: "yes" } as never,
          } as Partial<ExtensionManifest>,
        ],
        [
          "invalid-provenance",
          {
            name: "invalid-provenance-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            provenance: { verified: "yes" } as never,
          } as Partial<ExtensionManifest>,
        ],
        [
          "invalid-sandbox",
          {
            name: "invalid-sandbox-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            sandbox_profile: "permissive" as never,
          } as Partial<ExtensionManifest>,
        ],
        [
          "invalid-trusted",
          {
            name: "invalid-trusted-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            trusted: "true" as never,
          } as Partial<ExtensionManifest>,
        ],
        [
          "blank-min",
          {
            name: "blank-min-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            pm_min_version: " ",
          } as Partial<ExtensionManifest>,
        ],
        [
          "non-object-activation",
          {
            name: "non-object-activation-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            activation: "always" as never,
          } as Partial<ExtensionManifest>,
        ],
      ];

      for (const [directory, manifest] of cases) {
        await createExtension(roots.project, directory, manifest, "export default { ok: true };\n");
      }

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.effective).toEqual([]);
      expect(discovery.warnings).toEqual([
        "extension_manifest_invalid:project:blank-engine-key",
        "extension_manifest_invalid:project:blank-min",
        "extension_manifest_invalid:project:invalid-manifest-version",
        "extension_manifest_invalid:project:invalid-permissions",
        "extension_manifest_invalid:project:invalid-provenance",
        "extension_manifest_invalid:project:invalid-sandbox",
        "extension_manifest_invalid:project:invalid-trusted",
        "extension_manifest_invalid:project:non-object-activation",
      ]);
    });
  });

  it("preserves full manifest provenance, permission, and activation metadata", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "full-security-metadata",
        {
          name: "full-security-metadata-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          manifest_version: 3,
          trusted: true,
          provenance: {
            source: " example://source ",
            signature: " sig ",
            attestation: " att ",
            verified: false,
          },
          sandbox_profile: "restricted",
          permissions: {
            fs_read: true,
            fs_write: false,
            network: true,
            env_read: false,
            env_write: true,
            process_spawn: false,
          },
          activation: {
            commands: ["   "],
          },
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "full-security-metadata-ext",
          manifest_version: 3,
          trusted: true,
          provenance: {
            source: "example://source",
            signature: "sig",
            attestation: "att",
            verified: false,
          },
          sandbox_profile: "restricted",
          permissions: {
            fs_read: true,
            fs_write: false,
            network: true,
            env_read: false,
            env_write: true,
            process_spawn: false,
          },
          activation: undefined,
        }),
      ]);
    });
  });

  it("blocks extensions with unmet pm_min_version before loading", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "future-pm",
        {
          name: "future-pm-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          pm_min_version: "9999.1.1",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.effective).toEqual([]);
      expect(discovery.warnings).toEqual([
        expect.stringMatching(/^extension_pm_min_version_unmet:project:future-pm-ext:required=9999\.1\.1:current=/),
      ]);

      const loaded = await loadExtensions({ pmRoot: context.pmPath, settings });
      expect(loaded.loaded).toEqual([]);
      expect(loaded.failed).toEqual([]);
      expect(loaded.warnings).toEqual(discovery.warnings);
    });
  });

  it("preserves and accepts a satisfied pm_max_version during discovery", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "within-max",
        {
          name: "within-max-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          pm_max_version: "9999.0.0",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "within-max-ext",
          pm_max_version: "9999.0.0",
        }),
      ]);
    });
  });

  it("rejects an invalid-shape pm_max_version as a malformed manifest", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "blank-max",
        {
          name: "blank-max-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          pm_max_version: "",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual(["extension_manifest_invalid:project:blank-max"]);
      expect(discovery.effective).toEqual([]);
    });
  });

  it("blocks extensions with an unparseable pm_max_version before loading", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "unparseable-max",
        {
          name: "unparseable-max-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          pm_max_version: "not-a-version",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.effective).toEqual([]);
      expect(discovery.warnings).toEqual([
        "extension_pm_max_version_invalid:project:unparseable-max-ext:allowed=not-a-version",
      ]);

      const loaded = await loadExtensions({ pmRoot: context.pmPath, settings });
      expect(loaded.loaded).toEqual([]);
      expect(loaded.failed).toEqual([]);
      expect(loaded.warnings).toEqual(discovery.warnings);
    });
  });

  it("rejects a range-prefixed pm_max_version instead of treating it as an inclusive bound", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "range-max",
        {
          name: "range-max-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          // ">=" is valid for pm_min_version (engines.pm compat) but nonsensical as an upper bound.
          pm_max_version: ">=2026.6.1",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.effective).toEqual([]);
      expect(discovery.warnings).toEqual([
        "extension_pm_max_version_invalid:project:range-max-ext:allowed=>=2026.6.1",
      ]);
    });
  });

  it("blocks extensions whose pm_max_version is exceeded by the current CLI before loading", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "exceeded-max",
        {
          name: "exceeded-max-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          pm_max_version: "0.0.1",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.effective).toEqual([]);
      expect(discovery.warnings).toEqual([
        expect.stringMatching(/^extension_pm_max_version_exceeded:project:exceeded-max-ext:allowed=0\.0\.1:current=/),
      ]);

      const loaded = await loadExtensions({ pmRoot: context.pmPath, settings });
      expect(loaded.loaded).toEqual([]);
      expect(loaded.failed).toEqual([]);
      expect(loaded.warnings).toEqual(discovery.warnings);
    });
  });

  it("allows exceeded pm_max_version with a warn-only project-layer policy", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "warn-exceeded-max",
        {
          name: "warn-exceeded-max-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          pm_max_version: "0.0.1",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      settings.extensions.policy.pm_max_version_exceeded_mode = {
        project: "warn",
      };
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "warn-exceeded-max-ext",
          layer: "project",
        }),
      ]);
      expect(discovery.warnings).toEqual([
        expect.stringMatching(
          /^extension_pm_max_version_exceeded_warn:project:warn-exceeded-max-ext:allowed=0\.0\.1:current=/,
        ),
      ]);

      const loaded = await loadExtensions({ pmRoot: context.pmPath, settings });
      expect(loaded.loaded.map((entry) => entry.name)).toEqual(["warn-exceeded-max-ext"]);
      expect(loaded.failed).toEqual([]);
      expect(loaded.warnings).toEqual(discovery.warnings);
    });
  });

  it("keeps global pm_max_version blocking when only project layer is warn-only", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.global,
        "global-exceeded-max",
        {
          name: "global-exceeded-max-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          pm_max_version: "0.0.1",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      settings.extensions.policy.pm_max_version_exceeded_mode = {
        project: "warn",
      };
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.effective).toEqual([]);
      expect(discovery.warnings).toEqual([
        expect.stringMatching(/^extension_pm_max_version_exceeded:global:global-exceeded-max-ext:allowed=0\.0\.1:current=/),
      ]);
    });
  });

  it("reports deterministic warnings for unknown manifest capabilities without blocking load", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "unknown-capabilities",
        {
          name: "unknown-capability-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["hooks", "Future-Capability", "search"],
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.warnings).toEqual([
        expect.stringContaining("extension_capability_unknown:project:unknown-capability-ext:future-capability"),
      ]);
      expect(discovery.warnings[0]).toContain("allowed=commands,renderers,hooks,schema,importers,search,parser,preflight,services");
      expect(discovery.warnings[0]).toContain("suggested=none");
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "unknown-capability-ext",
          capabilities: ["future-capability", "hooks", "search"],
        }),
      ]);

      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(loaded.warnings).toEqual([
        expect.stringContaining("extension_capability_unknown:project:unknown-capability-ext:future-capability"),
      ]);
      expect(loaded.warnings[0]).toContain("allowed=commands,renderers,hooks,schema,importers,search,parser,preflight,services");
      expect(loaded.warnings[0]).toContain("suggested=none");
      expect(loaded.loaded.map((entry) => entry.name)).toEqual(["unknown-capability-ext"]);
      expect(loaded.failed).toEqual([]);
    });
  });

  it("includes nearest-match suggestions for unknown capabilities when confidence is high", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "suggested-capability",
        {
          name: "suggested-capability-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["service"],
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.warnings).toHaveLength(1);
      expect(discovery.warnings[0]).toContain("extension_capability_unknown:project:suggested-capability-ext:service");
      expect(discovery.warnings[0]).toContain("suggested=services");
    });
  });

  it("remaps legacy capability aliases and emits a consolidated warning", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "legacy-capability-alias",
        {
          name: "legacy-capability-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["migration", "validation"],
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.warnings).toEqual([
        "extension_capability_legacy_alias:project:legacy-capability-ext:aliases=migration>schema,validation>schema",
      ]);
      expect(discovery.warnings.some((warning) => warning.startsWith("extension_capability_unknown:"))).toBe(false);
      const loaded = await loadExtensions({ pmRoot: context.pmPath, settings });
      expect(loaded.loaded[0]?.capabilities).toEqual(["schema"]);
    });
  });

  it("applies deterministic same-name tie breaks within a layer", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "a-dup",
        {
          name: "dup-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 30,
        },
        "export default { source: 'a' };\n",
      );
      await createExtension(
        roots.project,
        "z-dup",
        {
          name: "dup-ext",
          version: "2.0.0",
          entry: "./index.mjs",
          priority: 30,
        },
        "export default { source: 'z' };\n",
      );
      await createExtension(
        roots.project,
        "beta",
        {
          name: "beta-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
        },
        "export default { source: 'beta' };\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "beta-ext",
          priority: 10,
          version: "1.0.0",
        }),
        expect.objectContaining({
          name: "dup-ext",
          priority: 30,
          version: "2.0.0",
          directory: "z-dup",
        }),
      ]);
    });
  });

  it("accepts entry paths that resolve to extension directory root", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(roots.project, "self-entry", {
        name: "self-entry-ext",
        version: "1.0.0",
        entry: ".",
      });

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "self-entry-ext",
          layer: "project",
          entry: ".",
          entry_path: path.join(roots.project, "self-entry"),
        }),
      ]);
    });
  });

  it("accepts in-tree symlink entry targets after canonical resolution", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(roots.project, "in-tree-symlink", {
        name: "in-tree-symlink-ext",
        version: "1.0.0",
        entry: "./index.mjs",
      });
      const extensionDir = path.join(roots.project, "in-tree-symlink");
      const targetPath = path.join(extensionDir, "nested", "entry.mjs");
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, "export default { inTree: true };\n", "utf8");
      await symlink(targetPath, path.join(extensionDir, "index.mjs"), "file");

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(discovery.warnings).toEqual([]);
      expect(discovery.effective).toEqual([
        expect.objectContaining({
          name: "in-tree-symlink-ext",
          layer: "project",
          entry: "./index.mjs",
          entry_path: path.join(extensionDir, "index.mjs"),
        }),
      ]);
    });
  });

  it("loads extensions and isolates entry load failures", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.global,
        "a-boom",
        {
          name: "boom-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "throw new Error('boom-load');\n",
      );
      await createExtension(
        roots.global,
        "z-good",
        {
          name: "good-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default { ok: true };\n",
      );

      const settings = await loadSettings(context);
      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(loaded.loaded.map((entry) => entry.name)).toEqual(["good-ext"]);
      expect(loaded.failed).toEqual([
        expect.objectContaining({
          layer: "global",
          name: "boom-ext",
        }),
      ]);
      expect(loaded.warnings).toContain("extension_load_failed:global:boom-ext");
    });
  });

  it("keeps discovery complete while filtering imports for command-scoped activation", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "targeted",
        {
          name: "targeted-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands"],
          activation: { commands: ["targeted"] },
        },
        "export const loadedValue = 'targeted';\n",
      );
      await createExtension(
        roots.project,
        "skipped",
        {
          name: "skipped-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands"],
          activation: { commands: ["skipped"] },
        },
        "throw new Error('skipped extension should not import');\n",
      );

      const settings = await loadSettings(context);
      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
        extensionFilter: (extension) => extension.name === "targeted-ext",
      });

      expect(loaded.effective.map((entry) => entry.name)).toEqual(["skipped-ext", "targeted-ext"]);
      expect(loaded.loaded.map((entry) => entry.name)).toEqual(["targeted-ext"]);
      expect(loaded.failed).toEqual([]);
      expect(loaded.warnings).toEqual([]);
    });
  });

  it("cache-busts extension imports with reload tokens and source package name fallback", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "name-backed",
        {
          name: "name-backed-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export const loadedValue = 'first';\n",
      );
      await writeFile(
        path.join(roots.project, ".managed-extensions.json"),
        `${JSON.stringify(
          {
            version: 1,
            entries: [
              { directory: "ignored", source: { package: "   " } },
              { name: "name-backed-ext", source: { package: "pm-name-backed" } },
              "not-an-entry",
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const settings = await loadSettings(context);
      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });

      expect(loaded.loaded).toEqual([
        expect.objectContaining({
          name: "name-backed-ext",
          source_package: "pm-name-backed",
        }),
      ]);
      const firstLoadedModule = loaded.loaded[0]?.module as { loadedValue?: string } | undefined;
      expect(firstLoadedModule?.loadedValue).toBe("first");

      await writeFile(path.join(roots.project, "name-backed", "index.mjs"), "export const loadedValue = 'second';\n", "utf8");
      const reloaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
        cache_bust: true,
        reload_token: "reload-token-1",
      });

      const reloadedModule = reloaded.loaded[0]?.module as { loadedValue?: string } | undefined;
      expect(reloadedModule?.loadedValue).toBe("second");
    });
  });

  it("activates extension hooks with deterministic registration order", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.global,
        "g-alpha-hooks",
        {
          name: "alpha-hook-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 5,
          capabilities: ["hooks"],
        },
        [
          "export default {",
          "  activate(api) {",
          "    api.hooks.beforeCommand(() => {});",
          "    api.hooks.afterCommand(() => {});",
          "    api.hooks.onWrite(() => {});",
          "  }",
          "};",
          "",
        ].join("\n"),
      );
      await createExtension(
        roots.project,
        "p-beta-hooks",
        {
          name: "beta-hook-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 50,
          capabilities: ["hooks"],
        },
        [
          "export default {",
          "  activate(api) {",
          "    api.hooks.beforeCommand(() => {});",
          "    api.hooks.afterCommand(() => {});",
          "    api.hooks.onRead(() => {});",
          "    api.hooks.onIndex(() => {});",
          "  }",
          "};",
          "",
        ].join("\n"),
      );

      const settings = await loadSettings(context);
      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      const activation = await activateExtensions(loaded);

      expect(activation.failed).toEqual([]);
      expect(activation.warnings).toEqual([]);
      expect(activation.hook_counts).toEqual({
        before_command: 2,
        after_command: 2,
        on_write: 1,
        on_read: 1,
        on_index: 1,
      });
      expect(activation.hooks.beforeCommand.map((entry) => entry.name)).toEqual(["alpha-hook-ext", "beta-hook-ext"]);
      expect(activation.hooks.afterCommand.map((entry) => entry.name)).toEqual(["alpha-hook-ext", "beta-hook-ext"]);
    });
  });

  it("enforces registration-surface policy during activation", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      policy: createTestExtensionPolicy({
        mode: "enforce",
        allowed_extensions: [],
        blocked_extensions: [],
        allowed_capabilities: [],
        blocked_capabilities: [],
        allowed_surfaces: [],
        blocked_surfaces: ["commands.handler"],
        extension_overrides: [],
      }),
      loaded: [
        {
          layer: "project",
          directory: "surface-policy-ext",
          manifest_path: "/tmp/project/surface-policy-ext/manifest.json",
          name: "surface-policy-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/surface-policy-ext/index.mjs",
          capabilities: ["commands", "hooks"],
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: { command: string; options: Record<string, unknown> }) => unknown;
                },
              ) => void;
              hooks: {
                beforeCommand: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.registerCommand({
                name: "surface policy command",
                run: (context) => ({ command: context.command, source: "handler" }),
              });
              api.hooks.beforeCommand(() => {});
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.command_handler_count).toBe(0);
    expect(activation.registration_counts.commands).toBe(0);
    expect(activation.hook_counts.before_command).toBe(1);
    expect(activation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "extension_policy_blocked_registration:project:surface-policy-ext:reason=surface_blocked",
        ),
      ]),
    );
  });

  it("enforces schema.flags policy for inline command flag registrations", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      policy: createTestExtensionPolicy({
        mode: "enforce",
        blocked_surfaces: ["schema.flags"],
      }),
      loaded: [
        {
          layer: "project",
          directory: "inline-flags-policy-ext",
          manifest_path: "/tmp/project/inline-flags-policy-ext/manifest.json",
          name: "inline-flags-policy-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/inline-flags-policy-ext/index.mjs",
          capabilities: ["commands", "schema"],
          module: {
            activate(api: ExtensionApi) {
              api.registerCommand({
                name: "inline flags command",
                flags: [{ long: "--inline-blocked", value_type: "boolean" }],
                run: () => ({ ok: true }),
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.command_handler_count).toBe(1);
    expect(activation.registration_counts.commands).toBe(1);
    expect(activation.registration_counts.flags).toBe(0);
    expect(activation.warnings).toEqual([
      "extension_policy_blocked_registration:project:inline-flags-policy-ext:reason=surface_blocked:capability=schema:method=registercommand_flags:surface=schema.flags",
    ]);
  });

  it("enforces command/action/service policy maps during activation", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      policy: createTestExtensionPolicy({
        mode: "enforce",
        trust_mode: "off",
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
        blocked_commands: ["policy blocked command"],
        allowed_actions: [],
        blocked_actions: ["policy-blocked-command"],
        allowed_services: [],
        blocked_services: ["output_format"],
        extension_overrides: [],
      }),
      loaded: [
        {
          layer: "project",
          directory: "command-service-policy-ext",
          manifest_path: "/tmp/project/command-service-policy-ext/manifest.json",
          name: "command-service-policy-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/command-service-policy-ext/index.mjs",
          capabilities: ["commands", "services"],
          module: {
            activate(api: {
              registerCommand: (definition: {
                name: string;
                action: string;
                run: (context: { command: string; options: Record<string, unknown> }) => unknown;
              }) => void;
              registerService: (name: "output_format", handler: (payload: unknown) => unknown) => void;
            }) {
              api.registerCommand({
                name: "policy blocked command",
                action: "policy-blocked-command",
                run: (context) => ({ command: context.command }),
              });
              api.registerService("output_format", (payload) => payload);
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.command_handler_count).toBe(0);
    expect(activation.service_override_count).toBe(0);
    expect(activation.registration_counts.commands).toBe(0);
    expect(activation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "extension_policy_blocked_registration:project:command-service-policy-ext:reason=command_blocked",
        ),
        expect.stringContaining(
          "extension_policy_blocked_registration:project:command-service-policy-ext:reason=service_blocked",
        ),
      ]),
    );
  });

  it("contains activation and runtime hook failures without stopping later hooks", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "activation-boom",
        {
          name: "activation-boom-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        [
          "export default {",
          "  activate() {",
          "    throw new Error('activate-boom');",
          "  }",
          "};",
          "",
        ].join("\n"),
      );
      await createExtension(
        roots.project,
        "runtime-hooks",
        {
          name: "hook-runtime-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["hooks"],
        },
        [
          "export const state = { before: 0, after: 0 };",
          "export default {",
          "  activate(api) {",
          "    api.hooks.beforeCommand(() => {",
          "      throw new Error('before-boom');",
          "    });",
          "    api.hooks.beforeCommand(() => {",
          "      state.before += 1;",
          "    });",
          "    api.hooks.afterCommand(() => {",
          "      state.after += 1;",
          "    });",
          "  }",
          "};",
          "",
        ].join("\n"),
      );

      const settings = await loadSettings(context);
      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      const activation = await activateExtensions(loaded);

      expect(activation.failed).toEqual([
        expect.objectContaining({
          layer: "project",
          name: "activation-boom-ext",
          error: "activate-boom",
        }),
      ]);
      expect(activation.warnings).toContain("extension_activate_failed:project:activation-boom-ext");

      const runtimeLoaded = loaded.loaded.find((entry) => entry.name === "hook-runtime-ext");
      const runtimeModule = runtimeLoaded?.module as { state?: { before: number; after: number } } | undefined;
      expect(runtimeModule?.state).toEqual({
        before: 0,
        after: 0,
      });

      const beforeWarnings = await runBeforeCommandHooks(activation.hooks, {
        command: "list-open",
        args: ["--limit", "1"],
        pm_root: context.pmPath,
      });
      expect(beforeWarnings).toEqual(["extension_hook_failed:project:hook-runtime-ext:beforeCommand"]);
      expect(runtimeModule?.state?.before).toBe(1);

      const afterWarnings = await runAfterCommandHooks(activation.hooks, {
        command: "list-open",
        args: ["--limit", "1"],
        pm_root: context.pmPath,
        ok: true,
      });
      expect(afterWarnings).toEqual([]);
      expect(runtimeModule?.state?.after).toBe(1);
    });
  });

  it("isolates hook context snapshots across callbacks and caller state", async () => {
    const observed: Array<{ command: string; args: string[]; pm_root: string }> = [];
    const hooks = {
      beforeCommand: [
        {
          layer: "project" as const,
          name: "mutate-hook",
          run: (context: { command: string; args: string[]; pm_root: string }) => {
            context.command = "mutated";
            context.args.push("--json");
            context.pm_root = "/tmp/mutated";
          },
        },
        {
          layer: "project" as const,
          name: "observe-hook",
          run: (context: { command: string; args: string[]; pm_root: string }) => {
            observed.push({
              command: context.command,
              args: [...context.args],
              pm_root: context.pm_root,
            });
          },
        },
      ],
      afterCommand: [],
      onWrite: [],
      onRead: [],
      onIndex: [],
    };
    const callerContext = {
      command: "list-open",
      args: ["--limit", "1"],
      pm_root: "/tmp/project",
    };

    const warnings = await runBeforeCommandHooks(hooks, callerContext);
    expect(warnings).toEqual([]);
    expect(observed).toEqual([
      {
        command: "list-open",
        args: ["--limit", "1"],
        pm_root: "/tmp/project",
      },
    ]);
    expect(callerContext).toEqual({
      command: "list-open",
      args: ["--limit", "1"],
      pm_root: "/tmp/project",
    });
  });

  it("supports named activate exports and skips non-activatable modules", async () => {
    const namedState = { write: 0, read: 0, index: 0 };
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "non-object-module",
          manifest_path: "/tmp/project/non-object-module/manifest.json",
          name: "non-object-module",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 100,
          entry_path: "/tmp/project/non-object-module/index.mjs",
          module: 42 as unknown,
        },
        {
          layer: "project",
          directory: "no-activate",
          manifest_path: "/tmp/project/no-activate/manifest.json",
          name: "no-activate",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 100,
          entry_path: "/tmp/project/no-activate/index.mjs",
          module: {
            default: "not-an-object",
          },
        },
        {
          layer: "project",
          directory: "named-activate",
          manifest_path: "/tmp/project/named-activate/manifest.json",
          name: "named-activate",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 100,
          entry_path: "/tmp/project/named-activate/index.mjs",
          module: {
            activate(api: {
              hooks: {
                onWrite: (hook: (context: { path: string; scope: "project" | "global"; op: string }) => void) => void;
                onRead: (hook: (context: { path: string; scope: "project" | "global" }) => void) => void;
                onIndex: (hook: (context: { mode: string; total_items?: number }) => void) => void;
              };
            }) {
              api.hooks.onWrite(() => {
                namedState.write += 1;
              });
              api.hooks.onRead(() => {
                namedState.read += 1;
              });
              api.hooks.onIndex(() => {
                namedState.index += 1;
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.warnings).toEqual([]);
    expect(activation.hook_counts).toEqual({
      before_command: 0,
      after_command: 0,
      on_write: 1,
      on_read: 1,
      on_index: 1,
    });

    const writeWarnings = await runOnWriteHooks(activation.hooks, {
      path: "src/cli/main.ts",
      scope: "project",
      op: "update",
    });
    const readWarnings = await runOnReadHooks(activation.hooks, {
      path: "README.md",
      scope: "project",
    });
    const indexWarnings = await runOnIndexHooks(activation.hooks, {
      mode: "keyword",
      total_items: 3,
    });

    expect(writeWarnings).toEqual([]);
    expect(readWarnings).toEqual([]);
    expect(indexWarnings).toEqual([]);
    expect(namedState).toEqual({
      write: 1,
      read: 1,
      index: 1,
    });
  });

  it("handles malformed manifests and non-Error module failures", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "caps-valid",
        {
          name: "caps-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["hooks", "commands", "hooks"],
        },
        "export default { ok: true };\n",
      );
      await createExtension(
        roots.project,
        "blank-entry",
        {
          name: "blank-entry-ext",
          version: "1.0.0",
          entry: "   ",
        },
        "export default {};\n",
      );
      await createExtension(
        roots.project,
        "string-throw",
        {
          name: "string-throw-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "throw 'string-load-failure';\n",
      );

      const invalidJsonDir = path.join(roots.project, "invalid-json");
      await mkdir(invalidJsonDir, { recursive: true });
      await writeFile(path.join(invalidJsonDir, "manifest.json"), "{not-json", "utf8");
      const nonObjectDir = path.join(roots.project, "non-object");
      await mkdir(nonObjectDir, { recursive: true });
      await writeFile(path.join(nonObjectDir, "manifest.json"), '"not-an-object"\n', "utf8");
      await createExtension(
        roots.project,
        "missing-name",
        {
          name: "  ",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default {};\n",
      );
      await createExtension(
        roots.project,
        "missing-version",
        {
          name: "missing-version-ext",
          version: " ",
          entry: "./index.mjs",
        },
        "export default {};\n",
      );

      const settings = await loadSettings(context);
      const discovery = await discoverExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(discovery.warnings).toEqual([
        "extension_manifest_invalid:project:blank-entry",
        "extension_manifest_invalid:project:invalid-json",
        "extension_manifest_invalid:project:missing-name",
        "extension_manifest_invalid:project:missing-version",
        "extension_manifest_invalid:project:non-object",
      ]);
      expect(discovery.effective.map((entry) => entry.name)).toEqual(["caps-ext", "string-throw-ext"]);

      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
      });
      expect(loaded.loaded.map((entry) => entry.name)).toEqual(["caps-ext"]);
      expect(loaded.failed).toEqual([
        expect.objectContaining({
          layer: "project",
          name: "string-throw-ext",
          error: "string-load-failure",
        }),
      ]);
      expect(loaded.warnings).toEqual([
        "extension_manifest_invalid:project:blank-entry",
        "extension_manifest_invalid:project:invalid-json",
        "extension_manifest_invalid:project:missing-name",
        "extension_manifest_invalid:project:missing-version",
        "extension_manifest_invalid:project:non-object",
        "extension_load_failed:project:string-throw-ext",
      ]);
    });
  });

  it("skips discovery and loading when noExtensions is set", async () => {
    await withTempPmPath(async (context) => {
      const roots = resolveExtensionRoots(context.pmPath);
      await createExtension(
        roots.project,
        "skipped",
        {
          name: "skipped-ext",
          version: "1.0.0",
          entry: "./index.mjs",
        },
        "export default { skipped: true };\n",
      );

      const settings = await loadSettings(context);
      const loaded = await loadExtensions({
        pmRoot: context.pmPath,
        settings,
        noExtensions: true,
      });

      expect(loaded.disabled_by_flag).toBe(true);
      expect(loaded.discovered).toEqual([]);
      expect(loaded.effective).toEqual([]);
      expect(loaded.loaded).toEqual([]);
      expect(loaded.failed).toEqual([]);
      expect(loaded.warnings).toEqual([]);
    });
  });

  it("registers deterministic command and renderer overrides from activated extensions", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        buildOverrideLoadedExtension("global", "global-overrides", 10),
        buildOverrideLoadedExtension("project", "project-overrides", 20),
      ],
      failed: [],
    });

    expect(activation.command_override_count).toBe(2);
    expect(activation.command_handler_count).toBe(0);
    expect(activation.renderer_override_count).toBe(2);

    const commandResult = runCommandOverride(activation.commands, {
      command: "list-open",
      args: ["--limit", "1"],
      options: { limit: "1" },
      global: {
        json: true,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
      result: { count: 1 },
    });
    expect(commandResult).toEqual({
      overridden: true,
      result: { count: 1, source: "project", limit: "1", json: true },
      warnings: [],
    });

    const rendererResult = runRendererOverride(activation.renderers, {
      format: "json",
      command: "list-open",
      args: ["--limit", "1"],
      options: { limit: "1" },
      global: {
        json: true,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
      result: { ok: true },
    });
    expect(rendererResult).toEqual({
      overridden: true,
      rendered: JSON.stringify({
        source: "project",
        command: "list-open",
        limit: "1",
        json: true,
        pm_root: "/tmp/project",
        result: { ok: true },
      }),
      warnings: [],
    });
  });

  it("registers deterministic command handlers from activated extensions", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "global",
          directory: "global-handlers",
          manifest_path: "/tmp/global/global-handlers/manifest.json",
          name: "global-handlers",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/global/global-handlers/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: { command: string; options: Record<string, unknown> }) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: "beads import",
                run: (context) => ({
                  source: "global",
                  command: context.command,
                }),
              });
            },
          },
        },
        {
          layer: "project",
          directory: "project-handlers",
          manifest_path: "/tmp/project/project-handlers/manifest.json",
          name: "project-handlers",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/project-handlers/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: { command: string; options: Record<string, unknown> }) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: "beads import",
                run: (context) => ({
                  source: "project",
                  file: context.options.file,
                }),
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.command_override_count).toBe(0);
    expect(activation.command_handler_count).toBe(2);
    expect(activation.renderer_override_count).toBe(0);

    const handlerResult = await runCommandHandler(activation.commands, {
      command: "beads import",
      args: ["--file", "source.jsonl"],
      options: { file: "source.jsonl" },
      global: {
        json: true,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(handlerResult).toEqual({
      handled: true,
      result: {
        source: "project",
        file: "source.jsonl",
      },
      warnings: [],
    });
  });

  it("reports command handler, override, and overlap collisions", async () => {
    const loaded = [
      {
        layer: "global" as const,
        directory: "global-collisions",
        manifest_path: "/tmp/global/global-collisions/manifest.json",
        name: "global-collisions",
        version: "1.0.0",
        entry: "./index.mjs",
        priority: 10,
        entry_path: "/tmp/global/global-collisions/index.mjs",
        module: {
          activate(api: {
            registerCommand: (
              commandOrDefinition: string | { name: string; run: (context: unknown) => unknown },
              run?: (context: unknown) => unknown,
            ) => void;
          }) {
            api.registerCommand("sync", (context) => context);
            api.registerCommand({ name: "sync", run: (context) => context });
          },
        },
      },
      {
        layer: "project" as const,
        directory: "project-collisions",
        manifest_path: "/tmp/project/project-collisions/manifest.json",
        name: "project-collisions",
        version: "1.0.0",
        entry: "./index.mjs",
        priority: 20,
        entry_path: "/tmp/project/project-collisions/index.mjs",
        module: {
          activate(api: {
            registerCommand: (
              commandOrDefinition: string | { name: string; run: (context: unknown) => unknown },
              run?: (context: unknown) => unknown,
            ) => void;
          }) {
            api.registerCommand("sync", (context) => context);
            api.registerCommand({ name: "sync", run: (context) => context });
          },
        },
      },
    ];

    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: { global: "/tmp/global", project: "/tmp/project" },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded,
      failed: [],
    });

    expect(activation.warnings).toEqual(
      expect.arrayContaining([
        "extension_command_override_collision:sync:project:project-collisions:global:global-collisions",
        "extension_command_handler_collision:sync:project:project-collisions:global:global-collisions",
        "extension_command_override_handler_overlap:sync:global:global-collisions:global:global-collisions",
        "extension_command_override_handler_overlap:sync:project:project-collisions:project:project-collisions",
      ]),
    );
  });

  it("canonicalizes repeated whitespace for extension command names", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "canonical-command-names",
          manifest_path: "/tmp/project/canonical-command-names/manifest.json",
          name: "canonical-command-names",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/canonical-command-names/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                commandOrDefinition:
                  | string
                  | {
                      name: string;
                      run: (context: {
                        command: string;
                        options: Record<string, unknown>;
                        result?: unknown;
                      }) => unknown;
                    },
                run?: (context: { result: unknown }) => unknown,
              ) => void;
            }) {
              api.registerCommand("  beads   import  ", (context) => ({
                ...(context.result as Record<string, unknown>),
                source: "override",
              }));
              api.registerCommand({
                name: "  todos   export  ",
                run: (context) => ({
                  source: "handler",
                  command: context.command,
                  folder: context.options.folder,
                }),
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.command_override_count).toBe(1);
    expect(activation.command_handler_count).toBe(1);
    expect(activation.commands.overrides.map((entry) => entry.command)).toEqual(["beads import"]);
    expect(activation.commands.handlers.map((entry) => entry.command)).toEqual(["todos export"]);

    const overrideResult = runCommandOverride(activation.commands, {
      command: "beads import",
      args: ["--file", "source.jsonl"],
      pm_root: "/tmp/project",
      result: { ok: true },
    });
    expect(overrideResult).toEqual({
      overridden: true,
      result: { ok: true, source: "override" },
      warnings: [],
    });

    const handlerResult = await runCommandHandler(activation.commands, {
      command: "todos export",
      args: ["--folder", ".pm/todos"],
      options: { folder: ".pm/todos" },
      global: {
        json: false,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(handlerResult).toEqual({
      handled: true,
      result: {
        source: "handler",
        command: "todos export",
        folder: ".pm/todos",
      },
      warnings: [],
    });
  });

  it("records command-definition schema metadata and inline flag registrations", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "command-schema-metadata",
          manifest_path: "/tmp/project/command-schema-metadata/manifest.json",
          name: "command-schema-metadata",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/command-schema-metadata/index.mjs",
          capabilities: ["commands", "schema"],
          module: {
            activate(api: {
              registerCommand: (definition: {
                name: string;
                action?: string;
                description?: string;
                intent?: string;
                examples?: string[];
                failure_hints?: string[];
                arguments?: Array<{
                  name: string;
                  required?: boolean;
                  variadic?: boolean;
                  description?: string;
                }>;
                flags?: Array<Record<string, unknown>>;
                run: (context: { command: string; args: string[]; options: Record<string, unknown> }) => unknown;
              }) => void;
            }) {
              api.registerCommand({
                name: "migrate-asset",
                action: "migrate-asset",
                description: "Migrate asset descriptors between schema versions.",
                intent: "Validate source descriptors and write migrated output.",
                examples: [
                  "pm migrate-asset --source assets/source.json --target assets/output.json",
                  "pm migrate-asset A123 --dry-run",
                ],
                failure_hints: [
                  "Ensure --source points to a readable file path.",
                  "Use --dry-run before writing output.",
                ],
                arguments: [
                  {
                    name: "assetId",
                    required: false,
                    description: "Optional asset identifier override.",
                  },
                  {
                    name: "tags",
                    required: false,
                    variadic: true,
                    description: "Optional tags to annotate migration output.",
                  },
                ],
                flags: [
                  {
                    long: "--source",
                    value_name: "path",
                    description: "Path to source descriptor payload.",
                    required: true,
                  },
                  {
                    long: "--dry-run",
                    description: "Preview migration without writing changes.",
                  },
                ],
                run: (context) => ({
                  command: context.command,
                  source: context.options.source,
                  dryRun: context.options.dryRun,
                  args: context.args,
                }),
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.warnings).toEqual([]);
    expect(activation.registration_counts).toMatchObject({
      commands: 1,
      flags: 2,
    });
    expect(activation.registrations.commands).toEqual([
      {
        layer: "project",
        name: "command-schema-metadata",
        command: "migrate-asset",
        action: "migrate-asset",
        description: "Migrate asset descriptors between schema versions.",
        intent: "Validate source descriptors and write migrated output.",
        examples: [
          "pm migrate-asset --source assets/source.json --target assets/output.json",
          "pm migrate-asset A123 --dry-run",
        ],
        failure_hints: [
          "Ensure --source points to a readable file path.",
          "Use --dry-run before writing output.",
        ],
        arguments: [
          {
            name: "assetId",
            description: "Optional asset identifier override.",
          },
          {
            name: "tags",
            variadic: true,
            description: "Optional tags to annotate migration output.",
          },
        ],
      },
    ]);
    expect(activation.registrations.flags).toEqual([
      {
        layer: "project",
        name: "command-schema-metadata",
        target_command: "migrate-asset",
        flags: [
          {
            long: "--source",
            value_name: "path",
            description: "Path to source descriptor payload.",
            required: true,
          },
          {
            long: "--dry-run",
            description: "Preview migration without writing changes.",
          },
        ],
      },
    ]);

    const handlerResult = await runCommandHandler(activation.commands, {
      command: "migrate-asset",
      args: ["A123", "--source", "assets/source.json", "--dry-run"],
      options: {
        source: "assets/source.json",
        dryRun: true,
      },
      global: {
        json: false,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(handlerResult).toEqual({
      handled: true,
      result: {
        command: "migrate-asset",
        source: "assets/source.json",
        dryRun: true,
        args: ["A123", "--source", "assets/source.json", "--dry-run"],
      },
      warnings: [],
    });
  });

  it("accepts legacy command-definition handler aliases with deprecation warning", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "legacy-command-definition-handler",
          manifest_path: "/tmp/project/legacy-command-definition-handler/manifest.json",
          name: "legacy-command-definition-handler",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/legacy-command-definition-handler/index.mjs",
          capabilities: ["commands"],
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  handler: (context: { command: string; options: Record<string, unknown> }) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: "todos export",
                handler: (context) => ({
                  source: "legacy-handler-alias",
                  command: context.command,
                  folder: context.options.folder,
                }),
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.command_handler_count).toBe(1);
    expect(activation.warnings).toEqual([
      "extension_command_definition_legacy_handler_alias:project:legacy-command-definition-handler:todos export",
    ]);

    const handlerResult = await runCommandHandler(activation.commands, {
      command: "todos export",
      args: ["--folder", ".pm/todos"],
      options: { folder: ".pm/todos" },
      global: {
        json: false,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(handlerResult).toEqual({
      handled: true,
      result: {
        source: "legacy-handler-alias",
        command: "todos export",
        folder: ".pm/todos",
      },
      warnings: [],
    });
  });

  it("captures deterministic metadata for extended extension registration APIs", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "registration-baseline",
          manifest_path: "/tmp/project/registration-baseline/manifest.json",
          name: "registration-baseline",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/registration-baseline/index.mjs",
          module: {
            activate(api: {
              registerFlags: (targetCommand: string, flags: Array<Record<string, unknown>>) => void;
              registerItemFields: (fields: Array<Record<string, unknown>>) => void;
              registerMigration: (definition: Record<string, unknown>) => void;
              registerImporter: (name: string, importer: (context: unknown) => unknown) => void;
              registerExporter: (name: string, exporter: (context: unknown) => unknown) => void;
              registerSearchProvider: (provider: Record<string, unknown>) => void;
              registerVectorStoreAdapter: (adapter: Record<string, unknown>) => void;
            }) {
              api.registerFlags("  list-open  ", [{ long: "--example", short: "-e" }]);
              api.registerItemFields([{ name: "custom_field", type: "string" }]);
              api.registerMigration({
                big_count: 3n,
                marker: Symbol.for("migration"),
                version: 2,
                run: () => "ok",
              });
              api.registerImporter("  beads   jsonl  ", (context) => {
                const importerContext = context as {
                  registration: string;
                  action: string;
                  command: string;
                  options: Record<string, unknown>;
                  global: { json: boolean };
                };
                return {
                  registration: importerContext.registration,
                  action: importerContext.action,
                  command: importerContext.command,
                  file: importerContext.options.file,
                  json: importerContext.global.json,
                };
              });
              api.registerExporter("  todos   markdown  ", (context) => {
                const exporterContext = context as {
                  registration: string;
                  action: string;
                  command: string;
                  options: Record<string, unknown>;
                  global: { json: boolean };
                };
                return {
                  registration: exporterContext.registration,
                  action: exporterContext.action,
                  command: exporterContext.command,
                  folder: exporterContext.options.folder,
                  json: exporterContext.global.json,
                };
              });
              api.registerSearchProvider({
                metadata: [null, { tags: ["x", "y"] }],
                name: "semantic-provider",
                query: () => [0.1, 0.2],
              });
              api.registerVectorStoreAdapter({
                name: "vector-adapter",
                upsert: () => true,
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.warnings).toEqual([]);
    expect(activation.registration_counts).toEqual({
      commands: 2,
      flags: 1,
      item_fields: 1,
      migrations: 1,
      profiles: 0,
      importers: 1,
      exporters: 1,
      item_types: 0,
      search_providers: 1,
      vector_store_adapters: 1,
    });
    expect(activation.command_handler_count).toBe(2);
    expect(activation.commands.handlers.map((entry) => entry.command)).toEqual([
      "beads jsonl import",
      "todos markdown export",
    ]);
    expect(activation.registrations.commands).toEqual([
      expect.objectContaining({ command: "beads jsonl import" }),
      expect.objectContaining({ command: "todos markdown export" }),
    ]);
    expect(activation.registrations.flags).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        target_command: "list-open",
        flags: [{ long: "--example", short: "-e" }],
      },
    ]);
    expect(activation.registrations.item_fields).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        fields: [{ name: "custom_field", type: "string" }],
      },
    ]);
    expect(activation.registrations.migrations).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        definition: {
          big_count: "3",
          marker: "Symbol(migration)",
          run: "[Function]",
          version: 2,
        },
      },
    ]);
    expect(activation.registrations.importers).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        importer: "beads jsonl",
      },
    ]);
    expect(activation.registrations.exporters).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        exporter: "todos markdown",
      },
    ]);
    expect(activation.registrations.search_providers).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        definition: {
          metadata: [null, { tags: ["x", "y"] }],
          name: "semantic-provider",
          query: "[Function]",
        },
      },
    ]);
    expect(activation.registrations.vector_store_adapters).toEqual([
      {
        layer: "project",
        name: "registration-baseline",
        definition: {
          name: "vector-adapter",
          upsert: "[Function]",
        },
      },
    ]);

    const importerResult = await runCommandHandler(activation.commands, {
      command: "beads jsonl import",
      args: ["--file", "source.jsonl"],
      options: { file: "source.jsonl" },
      global: {
        json: true,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(importerResult).toEqual({
      handled: true,
      result: {
        registration: "beads jsonl",
        action: "import",
        command: "beads jsonl import",
        file: "source.jsonl",
        json: true,
      },
      warnings: [],
    });

    const exporterResult = await runCommandHandler(activation.commands, {
      command: "todos markdown export",
      args: ["--folder", ".pm/todos"],
      options: { folder: ".pm/todos" },
      global: {
        json: false,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(exporterResult).toEqual({
      handled: true,
      result: {
        registration: "todos markdown",
        action: "export",
        command: "todos markdown export",
        folder: ".pm/todos",
        json: false,
      },
      warnings: [],
    });
  });

  it("registers a full command definition and flags when importer/exporter metadata is provided", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "registration-rich",
          manifest_path: "/tmp/project/registration-rich/manifest.json",
          name: "registration-rich",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/registration-rich/index.mjs",
          module: {
            activate(api: {
              registerImporter: (
                name: string,
                importer: (context: unknown) => unknown,
                options?: Record<string, unknown>,
              ) => void;
              registerExporter: (
                name: string,
                exporter: (context: unknown) => unknown,
                options?: Record<string, unknown>,
              ) => void;
            }) {
              api.registerImporter(
                "jsonl",
                (context) => {
                  const importerContext = context as {
                    registration: string;
                    action: string;
                    command: string;
                    options: Record<string, unknown>;
                  };
                  return {
                    registration: importerContext.registration,
                    action: importerContext.action,
                    command: importerContext.command,
                    file: importerContext.options.file,
                  };
                },
                {
                  action: "jsonl-import",
                  description: "Import JSONL records into pm items.",
                  intent: "ingest external task records",
                  examples: ["pm jsonl import --file source.jsonl"],
                  failure_hints: ["Verify the JSONL source path exists."],
                  arguments: [{ name: "source", required: true, description: "Source file path." }],
                  flags: [
                    {
                      long: "--file",
                      value_name: "path",
                      value_type: "string",
                      description: "Path to the JSONL source file.",
                    },
                  ],
                },
              );
              // Minimal metadata (description only) defaults action from the command path
              // and omits the absent flags/intent fields.
              api.registerExporter("jsonl", () => ({ ok: true }), {
                description: "Export pm items to JSONL.",
              });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.warnings).toEqual([]);
    expect(activation.registration_counts.importers).toBe(1);
    expect(activation.registration_counts.exporters).toBe(1);
    expect(activation.command_handler_count).toBe(2);
    // Auto-created command paths gain full command definitions when metadata is supplied.
    expect(activation.registrations.commands).toEqual([
      {
        layer: "project",
        name: "registration-rich",
        command: "jsonl import",
        action: "jsonl-import",
        examples: ["pm jsonl import --file source.jsonl"],
        failure_hints: ["Verify the JSONL source path exists."],
        arguments: [{ name: "source", required: true, description: "Source file path." }],
        description: "Import JSONL records into pm items.",
        intent: "ingest external task records",
      },
      {
        layer: "project",
        name: "registration-rich",
        command: "jsonl export",
        action: "jsonl-export",
        examples: [],
        failure_hints: [],
        arguments: [],
        description: "Export pm items to JSONL.",
      },
    ]);
    expect(activation.registrations.flags).toEqual([
      {
        layer: "project",
        name: "registration-rich",
        target_command: "jsonl import",
        flags: [
          {
            long: "--file",
            value_name: "path",
            value_type: "string",
            description: "Path to the JSONL source file.",
          },
        ],
      },
    ]);
    expect(activation.registrations.importers).toEqual([
      { layer: "project", name: "registration-rich", importer: "jsonl" },
    ]);
    expect(activation.registrations.exporters).toEqual([
      { layer: "project", name: "registration-rich", exporter: "jsonl" },
    ]);

    const importerResult = await runCommandHandler(activation.commands, {
      command: "jsonl import",
      args: ["--file", "source.jsonl"],
      options: { file: "source.jsonl" },
      global: {
        json: true,
        quiet: false,
        noExtensions: false,
        profile: false,
      },
      pm_root: "/tmp/project",
    });
    expect(importerResult).toEqual({
      handled: true,
      result: {
        registration: "jsonl",
        action: "import",
        command: "jsonl import",
        file: "source.jsonl",
      },
      warnings: [],
    });
  });

  it("fails activation when importer metadata options are not an object", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "invalid-importer-options",
          manifest_path: "/tmp/project/invalid-importer-options/manifest.json",
          name: "invalid-importer-options",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/invalid-importer-options/index.mjs",
          module: {
            activate(api: {
              registerImporter: (
                name: string,
                importer: (context: unknown) => unknown,
                options?: unknown,
              ) => void;
            }) {
              api.registerImporter("jsonl", () => "ok", "not-an-object");
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([expect.objectContaining({ name: "invalid-importer-options" })]);
    expect(activation.warnings).toEqual(["extension_activate_failed:project:invalid-importer-options"]);
    expect(activation.registrations.importers).toEqual([]);
    expect(activation.registrations.commands).toEqual([]);
  });

  it("fails activation when extended registration APIs receive invalid input", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "invalid-register-flags",
          manifest_path: "/tmp/project/invalid-register-flags/manifest.json",
          name: "invalid-register-flags",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/invalid-register-flags/index.mjs",
          module: {
            activate(api: { registerFlags: (targetCommand: string, flags: Array<Record<string, unknown>>) => void }) {
              api.registerFlags("list-open", []);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-register-flags-shape",
          manifest_path: "/tmp/project/invalid-register-flags-shape/manifest.json",
          name: "invalid-register-flags-shape",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 15,
          entry_path: "/tmp/project/invalid-register-flags-shape/index.mjs",
          module: {
            activate(api: { registerFlags: (targetCommand: string, flags: Array<Record<string, unknown>>) => void }) {
              api.registerFlags("list-open", undefined as unknown as Array<Record<string, unknown>>);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-register-item-fields",
          manifest_path: "/tmp/project/invalid-register-item-fields/manifest.json",
          name: "invalid-register-item-fields",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 18,
          entry_path: "/tmp/project/invalid-register-item-fields/index.mjs",
          module: {
            activate(api: {
              registerItemFields: (fields: Array<Record<string, unknown>>) => void;
            }) {
              api.registerItemFields([]);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-register-importer",
          manifest_path: "/tmp/project/invalid-register-importer/manifest.json",
          name: "invalid-register-importer",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/invalid-register-importer/index.mjs",
          module: {
            activate(api: {
              registerImporter: (name: string, importer: (context: unknown) => unknown) => void;
            }) {
              api.registerImporter("beads", undefined as unknown as (context: unknown) => unknown);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-register-importer-name",
          manifest_path: "/tmp/project/invalid-register-importer-name/manifest.json",
          name: "invalid-register-importer-name",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 25,
          entry_path: "/tmp/project/invalid-register-importer-name/index.mjs",
          module: {
            activate(api: {
              registerImporter: (name: string, importer: (context: unknown) => unknown) => void;
            }) {
              api.registerImporter("   ", () => "ok");
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-register-search-provider",
          manifest_path: "/tmp/project/invalid-register-search-provider/manifest.json",
          name: "invalid-register-search-provider",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 30,
          entry_path: "/tmp/project/invalid-register-search-provider/index.mjs",
          module: {
            activate(api: {
              registerSearchProvider: (provider: Record<string, unknown>) => void;
            }) {
              api.registerSearchProvider(undefined as unknown as Record<string, unknown>);
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([
      expect.objectContaining({ name: "invalid-register-flags" }),
      expect.objectContaining({ name: "invalid-register-flags-shape" }),
      expect.objectContaining({ name: "invalid-register-item-fields" }),
      expect.objectContaining({ name: "invalid-register-importer" }),
      expect.objectContaining({ name: "invalid-register-importer-name" }),
      expect.objectContaining({ name: "invalid-register-search-provider" }),
    ]);
    expect(activation.warnings).toEqual([
      "extension_activate_failed:project:invalid-register-flags",
      "extension_activate_failed:project:invalid-register-flags-shape",
      "extension_activate_failed:project:invalid-register-item-fields",
      "extension_activate_failed:project:invalid-register-importer",
      "extension_activate_failed:project:invalid-register-importer-name",
      "extension_activate_failed:project:invalid-register-search-provider",
    ]);
  });

  it("fails activation when command or renderer registration inputs are invalid", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "invalid-command",
          manifest_path: "/tmp/project/invalid-command/manifest.json",
          name: "invalid-command",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/invalid-command/index.mjs",
          module: {
            activate(api: { registerCommand: (command: string, run: (context: unknown) => unknown) => void }) {
              api.registerCommand("   ", (context) => context);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-renderer",
          manifest_path: "/tmp/project/invalid-renderer/manifest.json",
          name: "invalid-renderer",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/invalid-renderer/index.mjs",
          module: {
            activate(api: {
              registerRenderer: (format: "toon" | "json", run: (context: unknown) => string) => void;
            }) {
              api.registerRenderer("xml" as unknown as "toon" | "json", () => "noop");
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-command-missing-handler",
          manifest_path: "/tmp/project/invalid-command-missing-handler/manifest.json",
          name: "invalid-command-missing-handler",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 30,
          entry_path: "/tmp/project/invalid-command-missing-handler/index.mjs",
          module: {
            activate(api: {
              registerCommand: (command: string, run: (context: unknown) => unknown) => void;
            }) {
              api.registerCommand("list-open", undefined as unknown as (context: unknown) => unknown);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-command-definition",
          manifest_path: "/tmp/project/invalid-command-definition/manifest.json",
          name: "invalid-command-definition",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 40,
          entry_path: "/tmp/project/invalid-command-definition/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: unknown) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: "  ",
                run: undefined as unknown as (context: unknown) => unknown,
              });
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-command-definition-run",
          manifest_path: "/tmp/project/invalid-command-definition-run/manifest.json",
          name: "invalid-command-definition-run",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 50,
          entry_path: "/tmp/project/invalid-command-definition-run/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: unknown) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: "beads import",
                run: undefined as unknown as (context: unknown) => unknown,
              });
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-command-definition-object",
          manifest_path: "/tmp/project/invalid-command-definition-object/manifest.json",
          name: "invalid-command-definition-object",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 60,
          entry_path: "/tmp/project/invalid-command-definition-object/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: unknown) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand(undefined as unknown as { name: string; run: (context: unknown) => unknown });
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-command-definition-name-type",
          manifest_path: "/tmp/project/invalid-command-definition-name-type/manifest.json",
          name: "invalid-command-definition-name-type",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 65,
          entry_path: "/tmp/project/invalid-command-definition-name-type/index.mjs",
          module: {
            activate(api: {
              registerCommand: (
                definition: {
                  name: string;
                  run: (context: unknown) => unknown;
                },
              ) => void;
            }) {
              api.registerCommand({
                name: 123 as unknown as string,
                run: (context) => context,
              });
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-renderer-handler",
          manifest_path: "/tmp/project/invalid-renderer-handler/manifest.json",
          name: "invalid-renderer-handler",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 70,
          entry_path: "/tmp/project/invalid-renderer-handler/index.mjs",
          module: {
            activate(api: {
              registerRenderer: (format: "toon" | "json", run: (context: unknown) => string) => void;
            }) {
              api.registerRenderer("json", undefined as unknown as (context: unknown) => string);
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([
      expect.objectContaining({ name: "invalid-command" }),
      expect.objectContaining({ name: "invalid-renderer" }),
      expect.objectContaining({ name: "invalid-command-missing-handler" }),
      expect.objectContaining({ name: "invalid-command-definition" }),
      expect.objectContaining({ name: "invalid-command-definition-run" }),
      expect.objectContaining({ name: "invalid-command-definition-object" }),
      expect.objectContaining({ name: "invalid-command-definition-name-type" }),
      expect.objectContaining({ name: "invalid-renderer-handler" }),
    ]);
    expect(activation.warnings).toEqual([
      "extension_activate_failed:project:invalid-command",
      "extension_activate_failed:project:invalid-renderer",
      "extension_activate_failed:project:invalid-command-missing-handler",
      "extension_activate_failed:project:invalid-command-definition",
      "extension_activate_failed:project:invalid-command-definition-run",
      "extension_activate_failed:project:invalid-command-definition-object",
      "extension_activate_failed:project:invalid-command-definition-name-type",
      "extension_activate_failed:project:invalid-renderer-handler",
    ]);
  });

  it("fails activation when API registrations exceed declared manifest capabilities", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "missing-commands-capability",
          manifest_path: "/tmp/project/missing-commands-capability/manifest.json",
          name: "missing-commands-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/missing-commands-capability/index.mjs",
          capabilities: ["hooks"],
          module: {
            activate(api: { registerCommand: (command: string, run: (context: unknown) => unknown) => void }) {
              api.registerCommand("list-open", (context) => context);
            },
          },
        },
        {
          layer: "project",
          directory: "missing-renderers-capability",
          manifest_path: "/tmp/project/missing-renderers-capability/manifest.json",
          name: "missing-renderers-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/missing-renderers-capability/index.mjs",
          capabilities: ["commands"],
          module: {
            activate(api: { registerRenderer: (format: "toon" | "json", run: (context: unknown) => string) => void }) {
              api.registerRenderer("json", () => "{}");
            },
          },
        },
        {
          layer: "project",
          directory: "missing-hooks-capability",
          manifest_path: "/tmp/project/missing-hooks-capability/manifest.json",
          name: "missing-hooks-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 30,
          entry_path: "/tmp/project/missing-hooks-capability/index.mjs",
          capabilities: ["commands"],
          module: {
            activate(api: { hooks: { beforeCommand: (hook: (context: unknown) => void) => void } }) {
              api.hooks.beforeCommand(() => {});
            },
          },
        },
        {
          layer: "project",
          directory: "missing-schema-capability",
          manifest_path: "/tmp/project/missing-schema-capability/manifest.json",
          name: "missing-schema-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 40,
          entry_path: "/tmp/project/missing-schema-capability/index.mjs",
          capabilities: ["commands"],
          module: {
            activate(api: { registerFlags: (targetCommand: string, flags: Array<Record<string, unknown>>) => void }) {
              api.registerFlags("list-open", [{ long: "--sample" }]);
            },
          },
        },
        {
          layer: "project",
          directory: "missing-importers-capability",
          manifest_path: "/tmp/project/missing-importers-capability/manifest.json",
          name: "missing-importers-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 50,
          entry_path: "/tmp/project/missing-importers-capability/index.mjs",
          capabilities: ["commands"],
          module: {
            activate(api: {
              registerImporter: (name: string, importer: (context: unknown) => unknown) => void;
            }) {
              api.registerImporter("sample", () => "ok");
            },
          },
        },
        {
          layer: "project",
          directory: "missing-search-capability",
          manifest_path: "/tmp/project/missing-search-capability/manifest.json",
          name: "missing-search-capability",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 60,
          entry_path: "/tmp/project/missing-search-capability/index.mjs",
          capabilities: ["commands", "custom-capability"],
          module: {
            activate(api: { registerSearchProvider: (provider: Record<string, unknown>) => void }) {
              api.registerSearchProvider({ name: "sample-search" });
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([
      expect.objectContaining({ name: "missing-commands-capability" }),
      expect.objectContaining({ name: "missing-renderers-capability" }),
      expect.objectContaining({ name: "missing-hooks-capability" }),
      expect.objectContaining({ name: "missing-schema-capability" }),
      expect.objectContaining({ name: "missing-importers-capability" }),
      expect.objectContaining({ name: "missing-search-capability" }),
    ]);
    expect(activation.warnings).toEqual([
      "extension_activate_failed:project:missing-commands-capability",
      "extension_activate_failed:project:missing-renderers-capability",
      "extension_activate_failed:project:missing-hooks-capability",
      "extension_activate_failed:project:missing-schema-capability",
      "extension_activate_failed:project:missing-importers-capability",
      "extension_activate_failed:project:missing-search-capability",
    ]);
  });

  it("fails activation when hook registration handlers are invalid", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "invalid-before-hook",
          manifest_path: "/tmp/project/invalid-before-hook/manifest.json",
          name: "invalid-before-hook",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/invalid-before-hook/index.mjs",
          module: {
            activate(api: {
              hooks: {
                beforeCommand: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.hooks.beforeCommand(undefined as unknown as (context: unknown) => void);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-after-hook",
          manifest_path: "/tmp/project/invalid-after-hook/manifest.json",
          name: "invalid-after-hook",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/invalid-after-hook/index.mjs",
          module: {
            activate(api: {
              hooks: {
                afterCommand: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.hooks.afterCommand(undefined as unknown as (context: unknown) => void);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-on-write-hook",
          manifest_path: "/tmp/project/invalid-on-write-hook/manifest.json",
          name: "invalid-on-write-hook",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 30,
          entry_path: "/tmp/project/invalid-on-write-hook/index.mjs",
          module: {
            activate(api: {
              hooks: {
                onWrite: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.hooks.onWrite(undefined as unknown as (context: unknown) => void);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-on-read-hook",
          manifest_path: "/tmp/project/invalid-on-read-hook/manifest.json",
          name: "invalid-on-read-hook",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 40,
          entry_path: "/tmp/project/invalid-on-read-hook/index.mjs",
          module: {
            activate(api: {
              hooks: {
                onRead: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.hooks.onRead(undefined as unknown as (context: unknown) => void);
            },
          },
        },
        {
          layer: "project",
          directory: "invalid-on-index-hook",
          manifest_path: "/tmp/project/invalid-on-index-hook/manifest.json",
          name: "invalid-on-index-hook",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 50,
          entry_path: "/tmp/project/invalid-on-index-hook/index.mjs",
          module: {
            activate(api: {
              hooks: {
                onIndex: (hook: (context: unknown) => void) => void;
              };
            }) {
              api.hooks.onIndex(undefined as unknown as (context: unknown) => void);
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([
      expect.objectContaining({ name: "invalid-before-hook" }),
      expect.objectContaining({ name: "invalid-after-hook" }),
      expect.objectContaining({ name: "invalid-on-write-hook" }),
      expect.objectContaining({ name: "invalid-on-read-hook" }),
      expect.objectContaining({ name: "invalid-on-index-hook" }),
    ]);
    expect(activation.warnings).toEqual([
      "extension_activate_failed:project:invalid-before-hook",
      "extension_activate_failed:project:invalid-after-hook",
      "extension_activate_failed:project:invalid-on-write-hook",
      "extension_activate_failed:project:invalid-on-read-hook",
      "extension_activate_failed:project:invalid-on-index-hook",
    ]);
  });

  it("contains command override failures and unsupported async overrides", () => {
    const registry = {
      overrides: [
        {
          layer: "project" as const,
          name: "async-ext",
          command: "list-all",
          run: (context: { result: { ok: boolean; nested: { preserved: boolean } } }) => {
            context.result.nested.preserved = false;
            return Promise.resolve({ bad: true });
          },
        },
        {
          layer: "project" as const,
          name: "boom-ext",
          command: "stats",
          run: (context: { result: { ok: boolean; nested: { preserved: boolean } } }) => {
            context.result.nested.preserved = false;
            throw new Error("boom");
          },
        },
      ],
      handlers: [],
    };

    expect(
      runCommandOverride(registry, {
        command: "   ",
        args: [],
        pm_root: "/tmp/project",
        result: { ok: true },
      }),
    ).toEqual({
      overridden: false,
      result: { ok: true },
      warnings: [],
    });

    expect(
      runCommandOverride(registry, {
        command: "get",
        args: [],
        pm_root: "/tmp/project",
        result: { ok: true },
      }),
    ).toEqual({
      overridden: false,
      result: { ok: true },
      warnings: [],
    });

    const listAllResult = {
      ok: true,
      nested: { preserved: true },
    };
    expect(
      runCommandOverride(registry, {
        command: "list-all",
        args: ["--limit", "1"],
        pm_root: "/tmp/project",
        result: listAllResult,
      }),
    ).toEqual({
      overridden: false,
      result: {
        ok: true,
        nested: { preserved: true },
      },
      warnings: ["extension_command_override_async_unsupported:project:async-ext:list-all"],
    });
    expect(listAllResult).toEqual({
      ok: true,
      nested: { preserved: true },
    });

    const statsResult = {
      ok: true,
      nested: { preserved: true },
    };
    expect(
      runCommandOverride(registry, {
        command: "stats",
        args: [],
        pm_root: "/tmp/project",
        result: statsResult,
      }),
    ).toEqual({
      overridden: false,
      result: {
        ok: true,
        nested: { preserved: true },
      },
      warnings: ["extension_command_override_failed:project:boom-ext:stats"],
    });
    expect(statsResult).toEqual({
      ok: true,
      nested: { preserved: true },
    });
  });

  it("contains command handler lookup and failure cases", async () => {
    const registry = {
      overrides: [],
      handlers: [
        {
          layer: "project" as const,
          name: "handler-boom-ext",
          command: "beads import",
          run: () => {
            throw new Error("boom");
          },
        },
      ],
    };

    expect(
      await runCommandHandler(registry, {
        command: "   ",
        args: [],
        options: {},
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      }),
    ).toEqual({
      handled: false,
      result: null,
      warnings: [],
    });

    expect(
      await runCommandHandler(registry, {
        command: "list-open",
        args: [],
        options: {},
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      }),
    ).toEqual({
      handled: false,
      result: null,
      warnings: [],
    });

    expect(
      await runCommandHandler(registry, {
        command: "beads import",
        args: ["--file", "source.jsonl"],
        options: { file: "source.jsonl" },
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      }),
    ).toEqual({
      handled: false,
      result: null,
      warnings: ["extension_command_handler_failed:project:handler-boom-ext:beads import"],
      errorMessage: "boom",
    });
  });

  it("surfaces the message from non-Error objects thrown by a command handler", async () => {
    const registry = {
      overrides: [],
      handlers: [
        {
          layer: "project" as const,
          name: "handler-object-ext",
          command: "beads import",
          run: () => {
            // Extensions may throw a plain/serialized object that carries a message
            // but does not inherit from Error.
            throw { message: "plain-object-boom", code: "E_CUSTOM" };
          },
        },
      ],
    };

    expect(
      await runCommandHandler(registry, {
        command: "beads import",
        args: [],
        options: {},
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      }),
    ).toEqual({
      handled: false,
      result: null,
      warnings: ["extension_command_handler_failed:project:handler-object-ext:beads import"],
      errorMessage: "plain-object-boom",
    });
  });

  it("isolates command handler context snapshots from caller mutation", async () => {
    const registry = {
      overrides: [],
      handlers: [
        {
          layer: "project" as const,
          name: "handler-mutate-ext",
          command: "todos export",
          run: (context: {
            args: string[];
            options: Record<string, unknown>;
            global: { json: boolean; quiet: boolean; noExtensions: boolean; profile: boolean };
          }) => {
            context.args.push("--quiet");
            context.options.folder = "mutated-folder";
            (context.options.nested as { immutable: boolean }).immutable = false;
            context.global.quiet = true;
            return {
              args: context.args,
              options: context.options,
              global: context.global,
            };
          },
        },
      ],
    };

    const callerArgs = ["--folder", ".pm/todos"];
    const callerOptions: Record<string, unknown> = {
      folder: ".pm/todos",
      nested: {
        immutable: true,
      },
    };
    const callerGlobal = {
      json: false,
      quiet: false,
      noExtensions: false,
      profile: false,
    };

    const result = await runCommandHandler(registry, {
      command: "todos export",
      args: callerArgs,
      options: callerOptions,
      global: callerGlobal,
      pm_root: "/tmp/project",
    });

    expect(result).toEqual({
      handled: true,
      result: {
        args: ["--folder", ".pm/todos", "--quiet"],
        options: {
          folder: "mutated-folder",
          nested: {
            immutable: false,
          },
        },
        global: {
          json: false,
          quiet: true,
          noExtensions: false,
          profile: false,
        },
      },
      warnings: [],
    });
    expect(callerArgs).toEqual(["--folder", ".pm/todos"]);
    expect(callerOptions).toEqual({
      folder: ".pm/todos",
      nested: {
        immutable: true,
      },
    });
    expect(callerGlobal).toEqual({
      json: false,
      quiet: false,
      noExtensions: false,
      profile: false,
    });
  });

  it("contains renderer override invalid-result and failure cases", () => {
    const validRegistry = {
      overrides: [
        {
          layer: "project" as const,
          name: "json-renderer",
          format: "json" as const,
          run: (context: { result: unknown }) => JSON.stringify({ wrapped: context.result }),
        },
      ],
    };
    expect(
      runRendererOverride(validRegistry, {
        format: "json",
        result: { ok: true },
      }),
    ).toEqual({
      overridden: true,
      rendered: JSON.stringify({ wrapped: { ok: true } }),
      warnings: [],
    });

    expect(
      runRendererOverride(validRegistry, {
        format: "toon",
        result: { ok: true },
      }),
    ).toEqual({
      overridden: false,
      rendered: null,
      warnings: [],
    });

    const invalidRegistry = {
      overrides: [
        {
          layer: "project" as const,
          name: "invalid-renderer",
          format: "json" as const,
          run: () => 42 as unknown as string,
        },
      ],
    };
    expect(
      runRendererOverride(invalidRegistry, {
        format: "json",
        result: { ok: true },
      }),
    ).toEqual({
      overridden: false,
      rendered: null,
      warnings: ["extension_renderer_invalid_result:project:invalid-renderer:json"],
    });

    const throwingRegistry = {
      overrides: [
        {
          layer: "project" as const,
          name: "boom-renderer",
          format: "toon" as const,
          run: (context: { result: { ok: boolean; nested: { preserved: boolean } } }) => {
            context.result.nested.preserved = false;
            throw new Error("boom");
          },
        },
      ],
    };
    const rendererFallbackResult = {
      ok: true,
      nested: { preserved: true },
    };
    expect(
      runRendererOverride(throwingRegistry, {
        format: "toon",
        result: rendererFallbackResult,
      }),
    ).toEqual({
      overridden: false,
      rendered: null,
      warnings: ["extension_renderer_failed:project:boom-renderer:toon"],
    });
    expect(rendererFallbackResult).toEqual({
      ok: true,
      nested: { preserved: true },
    });
  });

  it("runs parser and preflight overrides with deterministic fallback", async () => {
    const parserResult = await runParserOverride(
      {
        overrides: [
          {
            layer: "project",
            name: "parser-ext",
            command: "create",
            run: (context) => ({
              args: [...context.args, "--synthetic"],
              options: {
                ...context.options,
                estimate: typeof context.options.estimate === "number" ? context.options.estimate : 30,
              },
            }),
          },
        ],
      },
      {
        command: "create",
        args: ["--type", "Task"],
        options: {},
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
      },
    );
    expect(parserResult.overridden).toBe(true);
    expect(parserResult.context.args).toEqual(["--type", "Task", "--synthetic"]);
    expect(parserResult.context.options).toEqual({
      estimate: 30,
    });
    expect(parserResult.warnings).toEqual([]);

    const preflightResult = await runPreflightOverride(
      {
        overrides: [
          {
            layer: "project",
            name: "preflight-ext",
            run: (context) => ({
              options: {
                ...context.options,
                force: true,
              },
              run_extension_migrations: false,
              enforce_mandatory_migration_gate: false,
            }),
          },
        ],
      },
      {
        command: "update",
        args: ["pm-a1b2"],
        options: {},
        global: {
          json: false,
          quiet: false,
          noExtensions: false,
          profile: false,
        },
        pm_root: "/tmp/project",
        decision: {
          enforce_item_format_gate: true,
          run_preflight_item_format_sync: true,
          run_extension_migrations: true,
          enforce_mandatory_migration_gate: true,
        },
      },
    );
    expect(preflightResult.overridden).toBe(true);
    expect(preflightResult.context.options).toEqual({
      force: true,
    });
    expect(preflightResult.decision).toEqual({
      enforce_item_format_gate: true,
      run_preflight_item_format_sync: true,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    });
    expect(preflightResult.warnings).toEqual([]);
  });

  it("runs service overrides in sync and async paths", async () => {
    const serviceRegistry = {
      overrides: [
        {
          layer: "project" as const,
          name: "output-service-ext",
          service: "output_format" as const,
          run: (context: { payload: { result: unknown } }) => JSON.stringify({ wrapped: context.payload.result }),
        },
        {
          layer: "project" as const,
          name: "history-service-ext",
          service: "history_append" as const,
          run: async (context: { payload: { entry: { op: string } } }) => ({
            line: JSON.stringify({ patched: context.payload.entry.op }),
          }),
        },
      ],
    };
    expect(
      runServiceOverrideSync(serviceRegistry, {
        service: "output_format",
        payload: {
          result: { ok: true },
        },
      }),
    ).toEqual({
      handled: true,
      result: JSON.stringify({ wrapped: { ok: true } }),
      warnings: [],
    });
    expect(
      await runServiceOverride(serviceRegistry, {
        service: "history_append",
        payload: {
          entry: { op: "update" },
        },
      }),
    ).toEqual({
      handled: true,
      result: {
        line: JSON.stringify({ patched: "update" }),
      },
      warnings: [],
    });
  });

  it("treats output format service overrides as chained while preserving other service collision warnings", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "service-one",
          manifest_path: "/tmp/project/service-one/manifest.json",
          name: "service-one",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/service-one/index.mjs",
          capabilities: ["services"],
          module: {
            activate(api: {
              registerService: (
                name: "output_format" | "history_append",
                handler: (context: unknown) => unknown,
              ) => void;
            }) {
              api.registerService("output_format", (context) => context);
              api.registerService("history_append", (context) => context);
            },
          },
        },
        {
          layer: "project",
          directory: "service-two",
          manifest_path: "/tmp/project/service-two/manifest.json",
          name: "service-two",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/service-two/index.mjs",
          capabilities: ["services"],
          module: {
            activate(api: {
              registerService: (
                name: "output_format" | "history_append",
                handler: (context: unknown) => unknown,
              ) => void;
            }) {
              api.registerService("output_format", (context) => context);
              api.registerService("history_append", (context) => context);
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.service_override_count).toBe(4);
    expect(activation.warnings).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("extension_service_override_collision:output_format"),
      ]),
    );
    expect(activation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("extension_service_override_collision:history_append:project:service-two:project:service-one"),
      ]),
    );
  });

  it("reports preflight override collisions with the last registration as winner", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "global",
          directory: "preflight-one",
          manifest_path: "/tmp/global/preflight-one/manifest.json",
          name: "preflight-one",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/global/preflight-one/index.mjs",
          capabilities: ["preflight"],
          module: {
            activate(api: ExtensionApi) {
              api.registerPreflight((context) => context);
            },
          },
        },
        {
          layer: "project",
          directory: "preflight-two",
          manifest_path: "/tmp/project/preflight-two/manifest.json",
          name: "preflight-two",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/preflight-two/index.mjs",
          capabilities: ["preflight"],
          module: {
            activate(api: ExtensionApi) {
              api.registerPreflight((context) => context);
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.preflight_override_count).toBe(2);
    expect(activation.warnings).toEqual([
      "extension_preflight_override_collision:project:preflight-two:global:preflight-one",
    ]);
  });

  it("reports parser and renderer collisions while ignoring singleton service registrations", async () => {
    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: {
        global: "/tmp/global",
        project: "/tmp/project",
      },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "global",
          directory: "runtime-one",
          manifest_path: "/tmp/global/runtime-one/manifest.json",
          name: "runtime-one",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/global/runtime-one/index.mjs",
          capabilities: ["parser", "renderers", "services"],
          module: {
            activate(api: ExtensionApi) {
              api.registerParser("create", (context) => context);
              api.registerRenderer("json", () => "{}");
              api.registerService("history_append", (context) => context);
            },
          },
        },
        {
          layer: "project",
          directory: "runtime-two",
          manifest_path: "/tmp/project/runtime-two/manifest.json",
          name: "runtime-two",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 20,
          entry_path: "/tmp/project/runtime-two/index.mjs",
          capabilities: ["parser", "renderers"],
          module: {
            activate(api: ExtensionApi) {
              api.registerParser("create", (context) => context);
              api.registerRenderer("json", () => "{}");
            },
          },
        },
      ],
      failed: [],
    });

    expect(activation.parser_override_count).toBe(2);
    expect(activation.renderer_override_count).toBe(2);
    expect(activation.service_override_count).toBe(1);
    expect(activation.warnings).toEqual([
      "extension_parser_override_collision:create:project:runtime-two:global:runtime-one",
      "extension_renderer_collision:json:project:runtime-two:global:runtime-one",
    ]);
  });
});

function inMemoryLoadResult(
  module: unknown,
  options: {
    name?: string;
    version?: string;
    capabilities?: string[];
    layer?: "global" | "project";
    source_package?: string;
  } = {},
): ExtensionLoadResult {
  return {
    disabled_by_flag: false,
    roots: { global: "", project: "" },
    configured_enabled: [],
    configured_disabled: [],
    discovered: [],
    effective: [],
    warnings: [],
    policy: createDefaultExtensionGovernancePolicy(),
    failed: [],
    loaded: [
      {
        layer: options.layer ?? "project",
        directory: "",
        manifest_path: "",
        name: options.name ?? "test-extension",
        version: options.version ?? "1.2.3",
        entry: "./index.js",
        priority: 0,
        entry_path: "",
        capabilities: options.capabilities ?? [],
        source_package: options.source_package,
        module,
      },
    ],
  };
}

describe("item field type validation (pm-oll8)", () => {
  it("exposes the canonical coercion kinds", () => {
    expect(KNOWN_ITEM_FIELD_TYPES).toEqual(["string", "number", "boolean", "array", "object"]);
  });

  it("normalizes known field types case-insensitively and rejects unknown ones", () => {
    expect(normalizeItemFieldType(" String ")).toBe("string");
    expect(normalizeItemFieldType("OBJECT")).toBe("object");
    expect(normalizeItemFieldType("strnig")).toBeNull();
    expect(normalizeItemFieldType("")).toBeNull();
  });

  it("suggests the closest known field type, including transpositions", () => {
    expect(suggestKnownItemFieldType("strnig")).toBe("string");
    expect(suggestKnownItemFieldType("nubmer")).toBe("number");
    expect(suggestKnownItemFieldType("objet")).toBe("object");
    expect(suggestKnownItemFieldType("")).toBeNull();
    expect(suggestKnownItemFieldType("xkcd-nonsense")).toBeNull();
  });

  it("fails registerItemFields activation for an unknown field type with a did-you-mean hint", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerItemFields([{ name: "severity", type: "strnig" }]);
        },
      },
      { name: "schema-ext", capabilities: ["schema"] },
    );
    const result = await activateExtensions(loadResult);
    expect(result.registration_counts.item_fields).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("is not a known field type");
    expect(result.failed[0].error).toContain('Did you mean "string"');
  });

  it("accepts a valid (case-insensitive) registerItemFields type", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerItemFields([{ name: "severity", type: "STRING" }]);
        },
      },
      { name: "schema-ext", capabilities: ["schema"] },
    );
    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(0);
    expect(result.registration_counts.item_fields).toBe(1);
  });
});

describe("extension self-identity (pm-qo36)", () => {
  it("exposes a frozen, capability-filtered identity to activate via api.extension", async () => {
    let captured: ExtensionSelfIdentity | undefined;
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          captured = api.extension;
        },
      },
      {
        name: "identity-ext",
        version: "2.4.6",
        capabilities: ["commands", "bogus-capability"],
        source_package: "pm-demo",
        layer: "global",
      },
    );
    await activateExtensions(loadResult);
    expect(captured?.name).toBe("identity-ext");
    expect(captured?.layer).toBe("global");
    expect(captured?.version).toBe("2.4.6");
    expect(captured?.capabilities).toEqual(["commands"]);
    expect(captured?.source_package).toBe("pm-demo");
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured?.capabilities)).toBe(true);
  });
});

describe("extension teardown lifecycle (pm-k1e4)", () => {
  it("runs deactivate for loaded extensions that export it", async () => {
    let cleaned = false;
    const loadResult = inMemoryLoadResult({
      activate() {},
      deactivate() {
        cleaned = true;
      },
    });
    const result = await deactivateExtensions(loadResult);
    expect(result).toEqual({ deactivated: 1, warnings: [], failed: [] });
    expect(cleaned).toBe(true);
  });

  it("supports deactivate via the default export and async teardown", async () => {
    let cleaned = 0;
    const loadResult = inMemoryLoadResult({
      default: {
        activate() {},
        async deactivate() {
          cleaned += 1;
        },
      },
    });
    const result = await deactivateExtensions(loadResult);
    expect(result.deactivated).toBe(1);
    expect(cleaned).toBe(1);
  });

  it("skips loaded extensions without a deactivate hook", async () => {
    const loadResult = inMemoryLoadResult({ activate() {} });
    const result = await deactivateExtensions(loadResult);
    expect(result).toEqual({ deactivated: 0, warnings: [], failed: [] });
  });

  it("captures a throwing deactivate as a warning + failure without blocking others", async () => {
    let secondCleaned = false;
    const loadResult: ExtensionLoadResult = {
      ...inMemoryLoadResult(null),
      loaded: [
        inMemoryLoadResult(
          {
            activate() {},
            deactivate() {
              throw new Error("sink close failed");
            },
          },
          { name: "boom", layer: "project" },
        ).loaded[0],
        inMemoryLoadResult(
          {
            activate() {},
            deactivate() {
              secondCleaned = true;
            },
          },
          { name: "ok", layer: "global" },
        ).loaded[0],
      ],
    };
    const result = await deactivateExtensions(loadResult);
    expect(result.deactivated).toBe(1);
    expect(secondCleaned).toBe(true);
    expect(result.warnings).toEqual(["extension_deactivate_failed:project:boom"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ layer: "project", name: "boom" });
    expect(result.failed[0].error).toContain("sink close failed");
  });

  it("times out a hanging deactivate without blocking other teardowns", async () => {
    let secondCleaned = false;
    const loadResult: ExtensionLoadResult = {
      ...inMemoryLoadResult(null),
      loaded: [
        inMemoryLoadResult(
          {
            activate() {},
            deactivate() {
              return new Promise<void>(() => {});
            },
          },
          { name: "stuck", layer: "project" },
        ).loaded[0],
        inMemoryLoadResult(
          {
            activate() {},
            deactivate() {
              secondCleaned = true;
            },
          },
          { name: "ok", layer: "global" },
        ).loaded[0],
      ],
    };
    const result = await deactivateExtensions(loadResult, undefined, { deactivate_timeout_ms: 10 });
    expect(result.deactivated).toBe(1);
    expect(secondCleaned).toBe(true);
    expect(result.warnings).toEqual(["extension_deactivate_failed:project:stuck"]);
    expect(result.failed).toEqual([
      {
        layer: "project",
        name: "stuck",
        error: "extension deactivate timed out after 10ms",
      },
    ]);
  });

  it("normalizes sub-millisecond positive deactivate timeout options to 1ms", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate() {},
        deactivate() {
          return new Promise<void>(() => {});
        },
      },
      { name: "fractional-timeout", layer: "project" },
    );
    const result = await deactivateExtensions(loadResult, undefined, { deactivate_timeout_ms: 0.5 });
    expect(result.deactivated).toBe(0);
    expect(result.failed).toEqual([
      {
        layer: "project",
        name: "fractional-timeout",
        error: "extension deactivate timed out after 1ms",
      },
    ]);
  });

  it("treats a null deactivate options object as default timeout options for JavaScript consumers", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate() {},
        deactivate() {},
      },
      { name: "null-options", layer: "project" },
    );
    const result = await deactivateExtensions(loadResult, undefined, null as never);
    expect(result).toEqual({ deactivated: 1, warnings: [], failed: [] });
  });

  it("consumes late deactivate rejections after timeout", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate() {},
        async deactivate() {
          await new Promise((resolve) => setTimeout(resolve, 25));
          throw new Error("late cleanup failure");
        },
      },
      { name: "late-rejection", layer: "project" },
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await deactivateExtensions(loadResult, undefined, { deactivate_timeout_ms: 1 });
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(result).toEqual({
        deactivated: 0,
        warnings: ["extension_deactivate_failed:project:late-rejection"],
        failed: [
          {
            layer: "project",
            name: "late-rejection",
            error: "extension deactivate timed out after 1ms",
          },
        ],
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("allows hosts to explicitly disable deactivate timeout with zero", async () => {
    let cleaned = false;
    const loadResult = inMemoryLoadResult(
      {
        activate() {},
        async deactivate() {
          await new Promise((resolve) => setTimeout(resolve, 15));
          cleaned = true;
        },
      },
      { name: "no-timeout", layer: "project" },
    );
    const result = await deactivateExtensions(loadResult, undefined, { deactivate_timeout_ms: 0 });
    expect(result).toEqual({ deactivated: 1, warnings: [], failed: [] });
    expect(cleaned).toBe(true);
  });

  it("allows hosts to explicitly disable deactivate timeout with Infinity", async () => {
    let cleaned = false;
    const loadResult = inMemoryLoadResult(
      {
        activate() {},
        async deactivate() {
          cleaned = true;
        },
      },
      { name: "infinite-timeout", layer: "project" },
    );
    const result = await deactivateExtensions(loadResult, undefined, { deactivate_timeout_ms: Infinity });
    expect(result).toEqual({ deactivated: 1, warnings: [], failed: [] });
    expect(cleaned).toBe(true);
  });

  it("ignores non-activatable modules during teardown", async () => {
    const loadResult = inMemoryLoadResult(null);
    const result = await deactivateExtensions(loadResult);
    expect(result.deactivated).toBe(0);
  });

  it("skips deactivate for extensions whose activation failed when given the activation result", async () => {
    let cleaned = false;
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerItemFields([{ name: "sev", type: "strnig" }]);
        },
        deactivate() {
          cleaned = true;
        },
      },
      { name: "boom-ext", capabilities: ["schema"] },
    );
    const activation = await activateExtensions(loadResult);
    expect(activation.failed).toHaveLength(1);
    const result = await deactivateExtensions(loadResult, activation);
    expect(result.deactivated).toBe(0);
    expect(cleaned).toBe(false);
  });

  it("preserves the module `this` binding across activate and deactivate", async () => {
    let deactivatedWithState = false;
    const moduleObject = {
      activate(this: { opened?: boolean }) {
        this.opened = true;
      },
      deactivate(this: { opened?: boolean }) {
        deactivatedWithState = this.opened === true;
      },
    };
    const loadResult = inMemoryLoadResult(moduleObject, { name: "stateful-ext", capabilities: [] });
    await activateExtensions(loadResult);
    const result = await deactivateExtensions(loadResult);
    expect(result.deactivated).toBe(1);
    expect(deactivatedWithState).toBe(true);
  });

  it("warns and skips hook registrations denied by extension policy", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.hooks.beforeCommand(() => undefined);
          api.hooks.afterCommand(() => undefined);
          api.hooks.onWrite(() => undefined);
          api.hooks.onRead(() => undefined);
          api.hooks.onIndex(() => undefined);
        },
      },
      { name: "blocked-hooks", capabilities: ["hooks"] },
    );
    loadResult.policy = createTestExtensionPolicy({
      mode: "enforce",
      blocked_surfaces: ["hooks.beforecommand", "hooks.aftercommand", "hooks.onwrite", "hooks.onread", "hooks.onindex"],
    });

    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(0);
    expect(result.hook_counts.before_command).toBe(0);
    expect(result.hook_counts.after_command).toBe(0);
    expect(result.hook_counts.on_write).toBe(0);
    expect(result.hook_counts.on_read).toBe(0);
    expect(result.hook_counts.on_index).toBe(0);
    expect(result.warnings).toEqual([
      "extension_policy_blocked_registration:project:blocked-hooks:reason=surface_blocked:capability=hooks:method=api.hooks.beforecommand:surface=hooks.beforecommand",
      "extension_policy_blocked_registration:project:blocked-hooks:reason=surface_blocked:capability=hooks:method=api.hooks.aftercommand:surface=hooks.aftercommand",
      "extension_policy_blocked_registration:project:blocked-hooks:reason=surface_blocked:capability=hooks:method=api.hooks.onwrite:surface=hooks.onwrite",
      "extension_policy_blocked_registration:project:blocked-hooks:reason=surface_blocked:capability=hooks:method=api.hooks.onread:surface=hooks.onread",
      "extension_policy_blocked_registration:project:blocked-hooks:reason=surface_blocked:capability=hooks:method=api.hooks.onindex:surface=hooks.onindex",
    ]);
  });

  it("warns and skips vector store registrations denied by extension policy", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerVectorStoreAdapter({ name: "blocked-vector", query: () => [] });
        },
      },
      { name: "blocked-vector-store", capabilities: ["search"] },
    );
    loadResult.policy = createTestExtensionPolicy({
      mode: "enforce",
      blocked_surfaces: ["search.vectorstore"],
    });

    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(0);
    expect(result.registration_counts.vector_store_adapters).toBe(0);
    expect(result.warnings).toEqual([
      "extension_policy_blocked_registration:project:blocked-vector-store:reason=surface_blocked:capability=search:method=registervectorstoreadapter:surface=search.vectorstore",
    ]);
  });

  it("warns and skips non-command registrations denied by extension policy", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerParser("sync", (context) => context);
          api.registerPreflight(() => ({ continue: true }));
          api.registerService("history_append", (context) => context);
          api.registerRenderer("toon", (payload) => String(payload));
          api.registerFlags("sync", [{ long: "--flag" }]);
          api.registerItemFields([{ name: "severity", type: "string" }]);
          api.registerItemTypes([{ name: "bug" }]);
          api.registerMigration({ id: "migrate-severity", run: () => undefined });
          api.registerProfile({
            name: "blocked-profile",
            title: "Blocked profile",
            summary: "Should be denied by policy.",
            types: [],
            statuses: [],
            fields: [],
            workflows: [],
            config: [],
            templates: [],
            packages: [],
          });
          api.registerImporter("jsonl", () => ({ ok: true }));
          api.registerExporter("jsonl", () => ({ ok: true }));
          api.registerSearchProvider({ name: "semantic", query: () => [] });
        },
      },
      {
        name: "blocked-non-command-apis",
        capabilities: ["parser", "preflight", "services", "renderers", "schema", "importers", "search"],
      },
    );
    loadResult.policy = createTestExtensionPolicy({
      mode: "enforce",
      blocked_surfaces: [
        "parser.override",
        "preflight.override",
        "services.override",
        "renderers.override",
        "schema.flags",
        "schema.itemfields",
        "schema.itemtypes",
        "schema.migrations",
        "schema.profiles",
        "importers.importer",
        "importers.exporter",
        "search.provider",
      ],
    });

    const result = await activateExtensions(loadResult);
    expect(result.failed).toEqual([]);
    expect(result.parser_override_count).toBe(0);
    expect(result.preflight_override_count).toBe(0);
    expect(result.service_override_count).toBe(0);
    expect(result.renderer_override_count).toBe(0);
    expect(result.registration_counts).toEqual({
      commands: 0,
      flags: 0,
      item_fields: 0,
      item_types: 0,
      migrations: 0,
      profiles: 0,
      importers: 0,
      exporters: 0,
      search_providers: 0,
      vector_store_adapters: 0,
    });
    expect(result.warnings).toEqual([
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=parser:method=registerparser:surface=parser.override",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=preflight:method=registerpreflight:surface=preflight.override",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=services:method=registerservice:service=history_append:surface=services.override",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=renderers:method=registerrenderer:surface=renderers.override",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=schema:method=registerflags:surface=schema.flags",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=schema:method=registeritemfields:surface=schema.itemfields",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=schema:method=registeritemtypes:surface=schema.itemtypes",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=schema:method=registermigration:surface=schema.migrations",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=schema:method=registerprofile:surface=schema.profiles",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=importers:method=registerimporter:surface=importers.importer",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=importers:method=registerexporter:surface=importers.exporter",
      "extension_policy_blocked_registration:project:blocked-non-command-apis:reason=surface_blocked:capability=search:method=registersearchprovider:surface=search.provider",
    ]);
  });

  it("warns and skips command override registrations denied by extension policy", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerCommand("sync", () => ({ ok: true }));
        },
      },
      { name: "blocked-command-override", capabilities: ["commands"] },
    );
    loadResult.policy = createTestExtensionPolicy({
      mode: "enforce",
      blocked_surfaces: ["commands.override"],
    });

    const result = await activateExtensions(loadResult);
    expect(result.failed).toEqual([]);
    expect(result.command_override_count).toBe(0);
    expect(result.warnings).toEqual([
      "extension_policy_blocked_registration:project:blocked-command-override:reason=surface_blocked:capability=commands:command=sync:method=registercommand:surface=commands.override",
    ]);
  });

  it("fails activation for command and schema registration metadata edge cases", async () => {
    const makeLoaded = (name: string, activate: (api: ExtensionApi) => void) => ({
      ...inMemoryLoadResult({ activate }, { name, capabilities: ["commands", "schema", "services"] }).loaded[0],
      name,
    });
    const activation = await activateExtensions({
      ...inMemoryLoadResult({}, { name: "unused" }),
      loaded: [
        makeLoaded("invalid-command-action", (api) => {
          api.registerCommand({ name: "sync now", action: "!!!", run: () => undefined });
        }),
        makeLoaded("invalid-command-arguments", (api) => {
          api.registerCommand({
            name: "sync args",
            arguments: { name: "target" } as never,
            run: () => undefined,
          });
        }),
        makeLoaded("invalid-command-argument-name", (api) => {
          api.registerCommand({
            name: "sync argname",
            arguments: [{ name: "bad name" }],
            run: () => undefined,
          });
        }),
        makeLoaded("invalid-command-variadic", (api) => {
          api.registerCommand({
            name: "sync variadic",
            arguments: [
              { name: "items", variadic: true },
              { name: "after" },
            ],
            run: () => undefined,
          });
        }),
        makeLoaded("invalid-command-flags", (api) => {
          api.registerCommand({
            name: "sync flags",
            flags: [{}],
            run: () => undefined,
          });
        }),
        makeLoaded("invalid-register-flags-default", (api) => {
          api.registerFlags("sync flags", [{ long: "--count", default: { bad: true } as never }]);
        }),
        makeLoaded("invalid-item-fields-list", (api) => {
          api.registerItemFields({ name: "field", type: "string" } as never);
        }),
        makeLoaded("invalid-item-fields-empty", (api) => {
          api.registerItemFields([]);
        }),
        makeLoaded("invalid-item-types-list", (api) => {
          api.registerItemTypes({ name: "task" } as never);
        }),
        makeLoaded("invalid-item-types-empty", (api) => {
          api.registerItemTypes([]);
        }),
        makeLoaded("invalid-item-type-policies", (api) => {
          api.registerItemTypes([{ name: "task", command_option_policies: { command: "create" } as never }]);
        }),
        makeLoaded("invalid-item-type-policy-entry", (api) => {
          api.registerItemTypes([{ name: "task", command_option_policies: [null] as never }]);
        }),
        makeLoaded("invalid-item-type-policy-command", (api) => {
          api.registerItemTypes([{ name: "task", command_option_policies: [{ command: " ", option: "status" }] }]);
        }),
        makeLoaded("invalid-item-type-policy-option", (api) => {
          api.registerItemTypes([{ name: "task", command_option_policies: [{ command: "create", option: "" }] }]);
        }),
        makeLoaded("invalid-item-type-policy-enabled", (api) => {
          api.registerItemTypes([{ name: "task", command_option_policies: [{ command: "create", option: "status", enabled: "yes" as never }] }]);
        }),
        makeLoaded("invalid-item-type-policy-required", (api) => {
          api.registerItemTypes([{ name: "task", command_option_policies: [{ command: "create", option: "status", required: "yes" as never }] }]);
        }),
        makeLoaded("invalid-item-type-policy-visible", (api) => {
          api.registerItemTypes([{ name: "task", command_option_policies: [{ command: "create", option: "status", visible: "yes" as never }] }]);
        }),
        makeLoaded("invalid-item-type-options", (api) => {
          api.registerItemTypes([{ name: "task", options: { key: "status" } as never }]);
        }),
        makeLoaded("invalid-item-type-option-entry", (api) => {
          api.registerItemTypes([{ name: "task", options: [null] as never }]);
        }),
        makeLoaded("invalid-item-type-option-key", (api) => {
          api.registerItemTypes([{ name: "task", options: [{ key: "" }] }]);
        }),
        makeLoaded("invalid-item-type-option-values", (api) => {
          api.registerItemTypes([{ name: "task", options: [{ key: "status", values: "open" as never }] }]);
        }),
        makeLoaded("invalid-item-type-option-required", (api) => {
          api.registerItemTypes([{ name: "task", options: [{ key: "status", required: "yes" as never }] }]);
        }),
        makeLoaded("invalid-item-type-option-aliases", (api) => {
          api.registerItemTypes([{ name: "task", options: [{ key: "status", aliases: ["ok", ""] }] }]);
        }),
        makeLoaded("invalid-migration-description", (api) => {
          api.registerMigration({ description: 123 as never });
        }),
        makeLoaded("invalid-migration-status", (api) => {
          api.registerMigration({ status: 123 as never });
        }),
        makeLoaded("invalid-migration-run", (api) => {
          api.registerMigration({ run: "now" as never });
        }),
        makeLoaded("invalid-service-name", (api) => {
          api.registerService("unknown" as never, () => undefined);
        }),
        makeLoaded("invalid-migration", (api) => {
          api.registerMigration({ id: 123 as never });
        }),
      ],
      failed: [],
    });

    expect(activation.failed.map((failure) => failure.name)).toEqual([
      "invalid-command-action",
      "invalid-command-arguments",
      "invalid-command-argument-name",
      "invalid-command-variadic",
      "invalid-command-flags",
      "invalid-register-flags-default",
      "invalid-item-fields-list",
      "invalid-item-fields-empty",
      "invalid-item-types-list",
      "invalid-item-types-empty",
      "invalid-item-type-policies",
      "invalid-item-type-policy-entry",
      "invalid-item-type-policy-command",
      "invalid-item-type-policy-option",
      "invalid-item-type-policy-enabled",
      "invalid-item-type-policy-required",
      "invalid-item-type-policy-visible",
      "invalid-item-type-options",
      "invalid-item-type-option-entry",
      "invalid-item-type-option-key",
      "invalid-item-type-option-values",
      "invalid-item-type-option-required",
      "invalid-item-type-option-aliases",
      "invalid-migration-description",
      "invalid-migration-status",
      "invalid-migration-run",
      "invalid-service-name",
      "invalid-migration",
    ]);
    expect(activation.failed.map((failure) => failure.error)).toEqual([
      expect.stringContaining("definition.action must contain alphanumeric characters"),
      expect.stringContaining("definition.arguments must be an array"),
      expect.stringContaining("definition.arguments[0].name must not contain spaces"),
      expect.stringContaining("variadic argument must be the final argument"),
      expect.stringContaining("requires at least one of long or short"),
      expect.stringContaining("default must be a string, number, or boolean"),
      expect.stringContaining("fields requires an array"),
      expect.stringContaining("requires at least one field definition"),
      expect.stringContaining("types requires an array"),
      expect.stringContaining("requires at least one type definition"),
      expect.stringContaining("command_option_policies must be an array"),
      expect.stringContaining("command_option_policies[0] requires an object definition"),
      expect.stringContaining("command_option_policies[0].command requires a non-empty string"),
      expect.stringContaining("command_option_policies[0].option requires a non-empty string"),
      expect.stringContaining("command_option_policies[0].enabled must be a boolean"),
      expect.stringContaining("command_option_policies[0].required must be a boolean"),
      expect.stringContaining("command_option_policies[0].visible must be a boolean"),
      expect.stringContaining("options must be an array"),
      expect.stringContaining("options[0] requires an object definition"),
      expect.stringContaining("options[0].key requires a non-empty string"),
      expect.stringContaining("options[0].values must be an array"),
      expect.stringContaining("options[0].required must be a boolean"),
      expect.stringContaining("options[0].aliases[1] must be a non-empty string"),
      expect.stringContaining("definition.description must be a string"),
      expect.stringContaining("definition.status must be a string"),
      expect.stringContaining("definition.run must be a function"),
      expect.stringContaining("registerService service must be one of"),
      expect.stringContaining("definition.id must be a string"),
    ]);
  });

  it("reports command override and handler overlap collisions", async () => {
    const loadResult: ExtensionLoadResult = {
      ...inMemoryLoadResult({}, { name: "unused" }),
      loaded: [
        {
          ...inMemoryLoadResult({}, { name: "handler-ext", capabilities: ["commands"] }).loaded[0],
          name: "handler-ext",
          module: {
            activate(api: ExtensionApi) {
              api.registerCommand({ name: "sync", run: () => ({ ok: true }) });
            },
          },
        },
        {
          ...inMemoryLoadResult({}, { name: "override-ext", capabilities: ["commands"] }).loaded[0],
          name: "override-ext",
          module: {
            activate(api: ExtensionApi) {
              api.registerCommand("sync", () => ({ override: true }));
            },
          },
        },
      ],
    };

    const result = await activateExtensions(loadResult);
    expect(result.command_handler_count).toBe(1);
    expect(result.command_override_count).toBe(1);
    expect(result.warnings).toEqual([
      "extension_command_override_handler_overlap:sync:project:override-ext:project:handler-ext",
    ]);
  });
});

describe("registerFlags default validation (pm-ltbr)", () => {
  it("accepts a scalar-array default for a list flag", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerFlags("report", [{ long: "--scope", value_type: "string", list: true, default: ["a", "b"] }]);
        },
      },
      { name: "flags-ext", capabilities: ["schema"] },
    );
    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(0);
    expect(result.registration_counts.flags).toBe(1);
  });

  it("rejects a non-scalar element in an array default", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerFlags("report", [{ long: "--scope", list: true, default: ["ok", { bad: true }] as never }]);
        },
      },
      { name: "flags-ext", capabilities: ["schema"] },
    );
    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("default[1] must be a string, number, or boolean");
  });

  it("rejects an array default when list is not true", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerFlags("report", [{ long: "--scope", value_type: "string", default: ["a", "b"] }]);
        },
      },
      { name: "flags-ext", capabilities: ["schema"] },
    );
    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("default cannot be an array unless list is true");
  });

  it("rejects an unknown value_type", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerFlags("report", [{ long: "--limit", value_type: "numbr" as never }]);
        },
      },
      { name: "flags-ext", capabilities: ["schema"] },
    );
    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain('value_type "numbr" is not a known flag value type');
  });

  it("rejects a default that is not coercible under the declared value_type", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerFlags("report", [{ long: "--limit", value_type: "number", default: "abc" }]);
        },
      },
      { name: "flags-ext", capabilities: ["schema"] },
    );
    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("is not coercible to number");
  });

  it("accepts a numeric-string default under a number value_type", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerFlags("report", [{ long: "--limit", value_type: "int", default: "20" }]);
        },
      },
      { name: "flags-ext", capabilities: ["schema"] },
    );
    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(0);
    expect(result.registration_counts.flags).toBe(1);
  });

  it("accepts a comma-string default for a number list flag (split like the runtime)", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerFlags("report", [{ long: "--limits", value_type: "number", list: true, default: "10,20" }]);
        },
      },
      { name: "flags-ext", capabilities: ["schema"] },
    );
    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(0);
    expect(result.registration_counts.flags).toBe(1);
  });

  it("still rejects a non-numeric element inside a list flag comma default", async () => {
    const loadResult = inMemoryLoadResult(
      {
        activate(api: ExtensionApi) {
          api.registerFlags("report", [{ long: "--limits", value_type: "number", list: true, default: "10,abc" }]);
        },
      },
      { name: "flags-ext", capabilities: ["schema"] },
    );
    const result = await activateExtensions(loadResult);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("default[1]");
    expect(result.failed[0].error).toContain("is not coercible to number");
  });
});

describe("flag value type resolution (pm-ltbr/pm-l0jd)", () => {
  it("resolves canonical kinds and aliases case-insensitively", () => {
    expect(resolveFlagValueKind("String")).toBe("string");
    expect(resolveFlagValueKind("number")).toBe("number");
    expect(resolveFlagValueKind("int")).toBe("number");
    expect(resolveFlagValueKind("integer")).toBe("number");
    expect(resolveFlagValueKind("float")).toBe("number");
    expect(resolveFlagValueKind("BOOL")).toBe("boolean");
    expect(resolveFlagValueKind("boolean")).toBe("boolean");
    expect(resolveFlagValueKind("numbr")).toBeNull();
    expect(resolveFlagValueKind(7)).toBeNull();
  });

  it("flattens list values from arrays, comma strings, and scalars", () => {
    expect(flattenFlagListValue("a, b ,,c")).toEqual(["a", "b", "c"]);
    expect(flattenFlagListValue(["a,b", ["c", 2], true])).toEqual(["a", "b", "c", 2, true]);
    expect(flattenFlagListValue([null, undefined, "x"])).toEqual(["x"]);
    expect(flattenFlagListValue(5)).toEqual([5]);
    expect(flattenFlagListValue(null)).toEqual([]);
  });

  it("validates default coercibility per kind", () => {
    expect(isFlagDefaultValueCoercible("anything", "string")).toBe(true);
    expect(isFlagDefaultValueCoercible(3, "number")).toBe(true);
    expect(isFlagDefaultValueCoercible(Number.POSITIVE_INFINITY, "number")).toBe(false);
    expect(isFlagDefaultValueCoercible("12", "number")).toBe(true);
    expect(isFlagDefaultValueCoercible("abc", "number")).toBe(false);
    expect(isFlagDefaultValueCoercible(" ", "number")).toBe(false);
    expect(isFlagDefaultValueCoercible(true, "number")).toBe(false);
    expect(isFlagDefaultValueCoercible(false, "boolean")).toBe(true);
    expect(isFlagDefaultValueCoercible("TRUE", "boolean")).toBe(true);
    expect(isFlagDefaultValueCoercible("0", "boolean")).toBe(true);
    expect(isFlagDefaultValueCoercible("maybe", "boolean")).toBe(false);
    expect(isFlagDefaultValueCoercible(1, "boolean")).toBe(false);
  });
});

describe("extension manifest schema governance", () => {
  it("keeps docs/schemas/extension-manifest.schema.json properties in sync with author-facing manifest fields", async () => {
    const schemaPath = path.join(process.cwd(), "docs", "schemas", "extension-manifest.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as { properties?: Record<string, unknown> };
    const schemaFields = Object.keys(schema.properties ?? {}).sort();
    const authorFacingManifestFields = [
      "$schema",
      "name",
      "version",
      "entry",
      "priority",
      "manifest_version",
      "pm_min_version",
      "pm_max_version",
      "engines",
      "trusted",
      "provenance",
      "sandbox_profile",
      "permissions",
      "capabilities",
      "activation",
    ] satisfies Array<Exclude<keyof ExtensionManifest, "legacy_capability_aliases"> | "$schema">;
    expect(schemaFields).toEqual([...authorFacingManifestFields].sort());
  });
});
