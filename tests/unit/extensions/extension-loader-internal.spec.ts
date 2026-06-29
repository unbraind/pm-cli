import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _testOnlyLoader,
  createEmptyExtensionCommandRegistry,
  createEmptyExtensionHookRegistry,
  createEmptyExtensionParserRegistry,
  createEmptyExtensionPreflightRegistry,
  createEmptyExtensionRegistrationRegistry,
  createEmptyExtensionRendererRegistry,
  createEmptyExtensionServiceRegistry,
} from "../../../src/core/extensions/loader.js";
import { createDefaultExtensionGovernancePolicy } from "../../../src/core/extensions/extension-types.js";
import { hydrateExtensionPolicy } from "../../../src/core/extensions/extension-policy.js";

describe("extension loader internal helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testOnlyLoader.resetCurrentPmCliVersionCacheForTest();
  });

  it("covers version-read fallbacks and compatibility unchecked branches", async () => {
    const manifest = {
      name: "version-ext",
      version: "1.0.0",
      entry: "index.mjs",
      capabilities: [],
    };

    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify({ version: "" }));
    await expect(_testOnlyLoader.readCurrentPmCliVersion()).resolves.toBeNull();

    vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("read failed"));
    await expect(_testOnlyLoader.readCurrentPmCliVersion()).resolves.toBeNull();

    vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("missing package"));
    _testOnlyLoader.resetCurrentPmCliVersionCacheForTest();
    await expect(
      _testOnlyLoader.evaluatePmMinVersionCompatibility("project", { ...manifest, pm_min_version: "1.2.3" } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        allowed: true,
        warning: expect.stringContaining("extension_pm_min_version_unchecked:project:version-ext:required=1.2.3:current=unknown"),
      }),
    );

    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify({ version: "nightly" }));
    _testOnlyLoader.resetCurrentPmCliVersionCacheForTest();
    await expect(
      _testOnlyLoader.evaluatePmMinVersionCompatibility("project", { ...manifest, pm_min_version: "1.2.3" } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        allowed: true,
        warning: expect.stringContaining("extension_pm_min_version_unchecked:project:version-ext:required=1.2.3:current=nightly"),
      }),
    );

    vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("missing package"));
    _testOnlyLoader.resetCurrentPmCliVersionCacheForTest();
    await expect(
      _testOnlyLoader.evaluatePmMaxVersionCompatibility(
        "project",
        { ...manifest, pm_max_version: "9.9.9" } as never,
        "block",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        allowed: true,
        warning: expect.stringContaining("extension_pm_max_version_unchecked:project:version-ext:allowed=9.9.9:current=unknown"),
      }),
    );

    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify({ version: "nightly" }));
    _testOnlyLoader.resetCurrentPmCliVersionCacheForTest();
    await expect(
      _testOnlyLoader.evaluatePmMaxVersionCompatibility(
        "project",
        { ...manifest, pm_max_version: "9.9.9" } as never,
        "block",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        allowed: true,
        warning: expect.stringContaining("extension_pm_max_version_unchecked:project:version-ext:allowed=9.9.9:current=nightly"),
      }),
    );

    await expect(_testOnlyLoader.fingerprintPath("/definitely/missing/path")).resolves.toBe("missing");

    expect(_testOnlyLoader.normalizeExtensionDeactivateTimeout(Number.NaN)).toBe(
      _testOnlyLoader.normalizeExtensionDeactivateTimeout(-1),
    );
    expect(_testOnlyLoader.normalizeExtensionDeactivateTimeout(Number.POSITIVE_INFINITY)).toBe(0);
    expect(_testOnlyLoader.parseManifest({
      name: "activation-ext",
      version: "1.0.0",
      entry: "index.mjs",
      activation: {
        commands: ["  build ", "deploy", "build", ""],
      },
    } as never)?.activation?.commands).toEqual(["build", "deploy"]);
    expect(
      _testOnlyLoader.parseManifest({
        name: "sparse-manifest",
        version: "1.0.0",
        entry: "index.mjs",
        engines: {},
        provenance: {},
        permissions: { fs_read: true },
        activation: {},
      } as never),
    ).toMatchObject({
      name: "sparse-manifest",
      engines: undefined,
      provenance: {},
      permissions: { fs_read: true },
    });
    expect(_testOnlyLoader.compareComparableVersions("1.2.1", "1.2")).toBe(1);
    expect(
      await _testOnlyLoader.resolveExtensionImportHref(
        {
          entry_path: "/tmp/pm-loader-missing-entry.mjs",
          manifest_path: "/tmp/pm-loader-missing-manifest.json",
        } as never,
        { cache_bust: true } as never,
      ),
    ).toContain("pm_ext_reload=");
  });

  it("validates registration helpers and collision collectors", () => {
    expect(_testOnlyLoader.extractRegistrationValidationTrace("not-error")).toBeUndefined();
    const traceError = _testOnlyLoader.createRegistrationValidationError("bad registration", {
      method: "registerCommand",
      registration_index: 0,
      command: "sync",
    } as never);
    expect(_testOnlyLoader.extractRegistrationValidationTrace(traceError)).toEqual(
      expect.objectContaining({
        method: "registerCommand",
        registration_index: 0,
      }),
    );

    expect(() => _testOnlyLoader.normalizeRegistrationRecord("registerThing", [] as never)).toThrow(/object definition/);
    expect(() => _testOnlyLoader.normalizeRuntimeRegistrationRecord("registerThing", [] as never)).toThrow(/object definition/);
    expect(() => _testOnlyLoader.normalizeRegistrationRecordList("registerThing", {} as never)).toThrow(/array of object definitions/);
    expect(() => _testOnlyLoader.assertOptionalStringField("registerThing.value", " ")).toThrow(/non-empty string/);
    expect(_testOnlyLoader.normalizeOptionalStringArrayField("registerThing.values", [" one ", "one", "two "] as never)).toEqual([
      "one",
      "two",
    ]);
    expect(() =>
      _testOnlyLoader.normalizeCommandDefinitionArguments([
        { name: "first", variadic: true },
        { name: "second", variadic: true },
      ] as never),
    ).toThrow(/at most one variadic argument/);
    expect(() => _testOnlyLoader.assertFlagValueTypeAndDefault("flag", { type: "number", default: "nope" })).toThrow(
      /not coercible to number/,
    );
    expect(() => _testOnlyLoader.validateItemFieldDefinitions([{ name: "severity", type: "mysterytype" }] as never)).toThrow(
      /not a known field type/,
    );

    expect(
      _testOnlyLoader.collectCommandCollisionWarnings({
        handlers: [
          { layer: "global", name: "h1", command: "sync" },
          { layer: "project", name: "h2", command: "sync" },
          { layer: "global", name: "h3", command: "build" },
          { layer: "project", name: "h4", command: "build" },
        ],
        overrides: [
          { layer: "global", name: "o1", command: "sync" },
          { layer: "project", name: "o2", command: "sync" },
          { layer: "global", name: "o3", command: "build" },
          { layer: "project", name: "o4", command: "build" },
        ],
      } as never),
    ).toEqual(
      expect.arrayContaining([
        "extension_command_handler_collision:build:project:h4:global:h3",
        "extension_command_handler_collision:sync:project:h2:global:h1",
        "extension_command_override_collision:build:project:o4:global:o3",
        "extension_command_override_collision:sync:project:o2:global:o1",
        "extension_command_override_handler_overlap:sync:global:o1:global:h1",
      ]),
    );

    expect(
      _testOnlyLoader.collectRendererCollisionWarnings({
        overrides: [{ layer: "project", name: "r1", format: "json" }],
      } as never),
    ).toEqual([]);
    expect(
      _testOnlyLoader.collectRendererCollisionWarnings({
        overrides: [
          { layer: "global", name: "r1", format: "json" },
          { layer: "project", name: "r2", format: "json" },
          { layer: "global", name: "r3", format: "toon" },
          { layer: "project", name: "r4", format: "toon" },
        ],
      } as never),
    ).toEqual(
      expect.arrayContaining([
        "extension_renderer_collision:json:project:r2:global:r1",
        "extension_renderer_collision:toon:project:r4:global:r3",
      ]),
    );

    expect(
      _testOnlyLoader.collectParserCollisionWarnings({
        overrides: [{ layer: "project", name: "p1", command: "create" }],
      } as never),
    ).toEqual([]);
    expect(
      _testOnlyLoader.collectParserCollisionWarnings({
        overrides: [
          { layer: "global", name: "p1", command: "create" },
          { layer: "project", name: "p2", command: "create" },
          { layer: "global", name: "p3", command: "update" },
          { layer: "project", name: "p4", command: "update" },
        ],
      } as never),
    ).toEqual(
      expect.arrayContaining([
        "extension_parser_override_collision:create:project:p2:global:p1",
        "extension_parser_override_collision:update:project:p4:global:p3",
      ]),
    );

    expect(
      _testOnlyLoader.getRegistrationCounts({
        commands: [{}, {}],
        flags: [{ flags: [{}, {}] }, { flags: [{}] }],
        item_fields: [{ fields: [{}, {}] }],
        item_types: [{ types: [{}, {}] }],
        migrations: [{}],
        profiles: [{}],
        importers: [{}],
        exporters: [{}],
        search_providers: [{}],
        vector_store_adapters: [{}],
      } as never),
    ).toEqual({
      commands: 2,
      flags: 3,
      item_fields: 2,
      item_types: 2,
      migrations: 1,
      profiles: 1,
      importers: 1,
      exporters: 1,
      search_providers: 1,
      vector_store_adapters: 1,
    });
  });

  it("covers additional loader helper edge branches", () => {
    expect(() =>
      _testOnlyLoader.normalizeCommandDefinitionArguments([
        { name: "input", variadic: true },
        { name: "tail" },
      ] as never),
    ).toThrow(/variadic argument must be the final argument/);
    expect(() =>
      _testOnlyLoader.assertFlagValueTypeAndDefault("flag", {
        value_type: "mystery",
        default: "x",
      }),
    ).toThrow(/not a known flag value type/);
    expect(() => _testOnlyLoader.validateItemFieldDefinitions([{ name: "severity", type: "x" }] as never)).toThrow(
      /not a known field type/,
    );
    expect(_testOnlyLoader.normalizeOptionalStringArrayField("registerThing.values", [" one ", "one"] as never)).toEqual(["one"]);
    expect(
      _testOnlyLoader.collectCommandCollisionWarnings({
        handlers: [{ layer: "project", name: "h1", command: "sync" }],
        overrides: [{ layer: "project", name: "o1", command: "other" }],
      } as never),
    ).toEqual([]);
    expect(
      _testOnlyLoader.collectServiceCollisionWarnings({
        overrides: [
          { layer: "global", name: "s1", service: "item_store_write" },
          { layer: "project", name: "s2", service: "item_store_write" },
          { layer: "global", name: "s3", service: "output_format" },
          { layer: "project", name: "s4", service: "output_format" },
        ],
      } as never),
    ).toEqual(["extension_service_override_collision:item_store_write:project:s2:global:s1"]);
  });

  it("creates extension API and records item type registration", () => {
    const hooks = createEmptyExtensionHookRegistry();
    const commands = createEmptyExtensionCommandRegistry();
    const parsers = createEmptyExtensionParserRegistry();
    const preflight = createEmptyExtensionPreflightRegistry();
    const services = createEmptyExtensionServiceRegistry();
    const renderers = createEmptyExtensionRendererRegistry();
    const registrations = createEmptyExtensionRegistrationRegistry();
    const warnings: string[] = [];
    const policy = hydrateExtensionPolicy(createDefaultExtensionGovernancePolicy());

    const extension = {
      layer: "project",
      name: "schema-extension",
      version: "1.0.0",
      capabilities: ["schema"],
      sandbox_profile: "none",
      permissions: {
        fs_read: true,
      },
    };

    const api = _testOnlyLoader.createExtensionApi(
      extension as never,
      hooks,
      commands,
      parsers,
      preflight,
      services,
      renderers,
      registrations,
      warnings,
      policy,
    );
    api.registerItemTypes([{ name: "Goal", aliases: ["goal"] } as never]);

    expect(registrations.item_types).toEqual([
      {
        layer: "project",
        name: "schema-extension",
        types: [{ name: "Goal", aliases: ["goal"] }],
      },
    ]);

    const blockedPolicy = hydrateExtensionPolicy({
      ...createDefaultExtensionGovernancePolicy(),
      mode: "enforce",
      blocked_surfaces: ["schema.flags"],
    });
    const blockedRegistrations = createEmptyExtensionRegistrationRegistry();
    const blockedApi = _testOnlyLoader.createExtensionApi(
      {
        layer: "project",
        name: "importer-extension",
        version: "1.0.0",
        capabilities: ["importers", "schema"],
      } as never,
      createEmptyExtensionHookRegistry(),
      createEmptyExtensionCommandRegistry(),
      createEmptyExtensionParserRegistry(),
      createEmptyExtensionPreflightRegistry(),
      createEmptyExtensionServiceRegistry(),
      createEmptyExtensionRendererRegistry(),
      blockedRegistrations,
      [],
      blockedPolicy,
    );
    blockedApi.registerImporter(
      "import-data",
      () => undefined,
      {
        action: "import-data",
        flags: [{ long: "--force", value_type: "boolean" }],
      } as never,
    );
    expect(blockedRegistrations.flags).toEqual([]);

    const allowedRegistrations = createEmptyExtensionRegistrationRegistry();
    const allowedApi = _testOnlyLoader.createExtensionApi(
      {
        layer: "project",
        name: "importer-extension-allowed",
        version: "1.0.0",
        capabilities: ["importers", "schema"],
      } as never,
      createEmptyExtensionHookRegistry(),
      createEmptyExtensionCommandRegistry(),
      createEmptyExtensionParserRegistry(),
      createEmptyExtensionPreflightRegistry(),
      createEmptyExtensionServiceRegistry(),
      createEmptyExtensionRendererRegistry(),
      allowedRegistrations,
      [],
      policy,
    );
    allowedApi.registerImporter(
      "import-data",
      () => undefined,
      {
        action: "import-data",
        flags: [{ long: "--force", value_type: "boolean" }],
      } as never,
    );
    expect(allowedRegistrations.flags).toEqual([
      expect.objectContaining({
        target_command: "import-data import",
      }),
    ]);

    const missingCapabilityApi = _testOnlyLoader.createExtensionApi(
      {
        layer: "project",
        name: "missing-capability",
        version: "1.0.0",
        capabilities: ["hooks"],
      } as never,
      createEmptyExtensionHookRegistry(),
      createEmptyExtensionCommandRegistry(),
      createEmptyExtensionParserRegistry(),
      createEmptyExtensionPreflightRegistry(),
      createEmptyExtensionServiceRegistry(),
      createEmptyExtensionRendererRegistry(),
      createEmptyExtensionRegistrationRegistry(),
      [],
      policy,
    );
    expect(() => missingCapabilityApi.registerItemTypes([{ name: "Goal" }] as never)).toThrow(/requires capability 'schema'/);
  });
});
