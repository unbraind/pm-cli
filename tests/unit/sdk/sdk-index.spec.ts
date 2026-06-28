import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_ITEM_TYPE_VALUES,
  EXIT_CODE,
  EXTENSION_CAPABILITIES,
  ITEM_TYPE_VALUES,
  PM_CLI_EXPECTED_ERROR_NAME,
  PM_PACKAGE_RESOURCE_KINDS,
  PM_CORE_COMMAND_NAMES,
  PM_PROVIDER_TOOL_PARAMETERS_SCHEMA,
  PM_TOOL_ACTIONS,
  PM_TOOL_ACTION_PARAMETER_CONTRACTS,
  PM_TOOL_PARAMETERS_SCHEMA,
  PM_TOOL_PARAMETERS_SCHEMA_VERSION,
  STATUS_VALUES,
  assertExtensionBlueprint as assertExtensionBlueprintFromBarrel,
  assertExtensionCapabilityUsage as assertExtensionCapabilityUsageFromBarrel,
  assertExtensionDeactivated as assertExtensionDeactivatedFromBarrel,
  assertExtensionManifestCompatible as assertExtensionManifestCompatibleFromBarrel,
  assertExtensionManifestMatchesBlueprint as assertExtensionManifestMatchesBlueprintFromBarrel,
  assertExtensionPreflight as assertExtensionPreflightFromBarrel,
  assertPackageManifest as assertPackageManifestFromBarrel,
  synthesizeExtensionManifest as synthesizeExtensionManifestFromBarrel,
  assertRegisteredCommandContract as assertRegisteredCommandContractFromBarrel,
  assertRegisteredCommandOverride as assertRegisteredCommandOverrideFromBarrel,
  assertRegisteredExporter as assertRegisteredExporterFromBarrel,
  assertRegisteredFlags as assertRegisteredFlagsFromBarrel,
  assertRegisteredHook as assertRegisteredHookFromBarrel,
  assertRegisteredImporter as assertRegisteredImporterFromBarrel,
  assertRegisteredItemField as assertRegisteredItemFieldFromBarrel,
  assertRegisteredItemType as assertRegisteredItemTypeFromBarrel,
  assertRegisteredMigration as assertRegisteredMigrationFromBarrel,
  assertRegisteredParserOverride as assertRegisteredParserOverrideFromBarrel,
  assertRegisteredPreflightOverride as assertRegisteredPreflightOverrideFromBarrel,
  assertRegisteredRendererOverride as assertRegisteredRendererOverrideFromBarrel,
  assertRegisteredSearchProvider as assertRegisteredSearchProviderFromBarrel,
  assertRegisteredServiceOverride as assertRegisteredServiceOverrideFromBarrel,
  assertRegisteredVectorStoreAdapter as assertRegisteredVectorStoreAdapterFromBarrel,
  activateExtensionForTest as activateExtensionForTestFromBarrel,
  createExtensionTestHarness as createExtensionTestHarnessFromBarrel,
  deactivateExtensionForTest as deactivateExtensionForTestFromBarrel,
  runRegisteredCommandForTest as runRegisteredCommandForTestFromBarrel,
  runRegisteredCommandOverrideForTest as runRegisteredCommandOverrideForTestFromBarrel,
  runRegisteredExporterForTest as runRegisteredExporterForTestFromBarrel,
  runRegisteredHookForTest as runRegisteredHookForTestFromBarrel,
  runRegisteredImporterForTest as runRegisteredImporterForTestFromBarrel,
  runRegisteredMigrationForTest as runRegisteredMigrationForTestFromBarrel,
  runRegisteredParserOverrideForTest as runRegisteredParserOverrideForTestFromBarrel,
  runRegisteredPreflightOverrideForTest as runRegisteredPreflightOverrideForTestFromBarrel,
  runRegisteredRendererOverrideForTest as runRegisteredRendererOverrideForTestFromBarrel,
  runRegisteredSearchProviderForTest as runRegisteredSearchProviderForTestFromBarrel,
  runRegisteredServiceOverrideForTest as runRegisteredServiceOverrideForTestFromBarrel,
  runRegisteredVectorStoreAdapterForTest as runRegisteredVectorStoreAdapterForTestFromBarrel,
  appendHistoryEntry,
  createHistoryEntry,
  createPmCliExpectedError,
  clearWorkspaceContractsCache,
  compactFlagAliasContracts,
  defineExtension,
  type ExtensionApi,
  type ExtensionCapability,
  type ExtensionHookRegistry,
  type ExtensionRegistrationRegistry,
  type ExtensionServiceName,
  generateItemId,
  getContracts,
  getWorkspaceContracts,
  getItemPath,
  locateItem,
  normalizeItemId,
  pathExists,
  readFileIfExists,
  readPmPackageManifest,
  readSettings,
  resolvePmRoot,
  resolveSubcommandFlagContractsForCommand,
  isPmExtensionCapabilityContract,
  isPmExtensionPolicyModeContract,
  isPmExtensionPolicySurfaceContract,
  isPmExtensionServiceNameContract,
  isPmToolAction,
  isPmCliExpectedError,
  toCompletionFlagString,
  withFlagAliasMetadata,
  writeFileAtomic,
} from "../../../src/sdk/index.js";
import { _testOnlyCliContracts } from "../../../src/sdk/cli-contracts.js";
import {
  assertExtensionBlueprint,
  assertExtensionCapabilityUsage,
  assertExtensionDeactivated,
  assertExtensionManifestCompatible,
  assertExtensionManifestMatchesBlueprint,
  assertExtensionPreflight,
  assertPackageManifest,
  assertRegisteredCommandContract,
  assertRegisteredCommandOverride,
  assertRegisteredExporter,
  assertRegisteredFlags,
  assertRegisteredHook,
  assertRegisteredImporter,
  assertRegisteredItemField,
  assertRegisteredItemType,
  assertRegisteredMigration,
  assertRegisteredParserOverride,
  assertRegisteredPreflightOverride,
  assertRegisteredRendererOverride,
  assertRegisteredSearchProvider,
  assertRegisteredServiceOverride,
  assertRegisteredVectorStoreAdapter,
  activateExtensionForTest,
  createExtensionTestHarness,
  deactivateExtensionForTest,
  runRegisteredCommandForTest,
  runRegisteredCommandOverrideForTest,
  runRegisteredExporterForTest,
  runRegisteredHookForTest,
  runRegisteredImporterForTest,
  runRegisteredMigrationForTest,
  runRegisteredParserOverrideForTest,
  runRegisteredPreflightOverrideForTest,
  runRegisteredRendererOverrideForTest,
  renderExtensionSurfaceMarkdown,
  runRegisteredSearchProviderForTest,
  runRegisteredServiceOverrideForTest,
  runRegisteredVectorStoreAdapterForTest,
  type ExtensionTestHarness,
} from "../../../src/sdk/testing.js";
import { serializeItemDocument } from "../../../src/core/item/item-format.js";
import { readSettings as readCoreSettings, writeSettings } from "../../../src/core/store/settings.js";
import {
  activateExtensions,
  loadExtensions,
  type ExtensionActivationResult,
  type OutputRendererFormat,
} from "../../../src/core/extensions/loader.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("SDK CLI contract helper tails", () => {
  it("deduplicates provider-compatible action schema aliases", () => {
    const schema = _testOnlyCliContracts.buildActionScopedToolSchema("get");
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.action).toMatchObject({ const: "get" });
    expect(properties.id).toBeDefined();
    expect(Object.keys(properties)).toEqual(Array.from(new Set(Object.keys(properties))));
  });

  it("deduplicates repeated flag contracts in test helpers", () => {
    const unique = _testOnlyCliContracts.toUniqueFlagContracts([
      { flag: "--json" },
      { flag: "--json" },
      { flag: "--path", aliases: ["trackerPath"] },
      { flag: "--path", aliases: ["trackerPath"] },
    ]);
    expect(unique).toEqual([
      { flag: "--json" },
      { flag: "--path", aliases: ["trackerPath"] },
    ]);
  });

  it("covers schema decoration fallbacks for primitive definitions and metadata overrides", () => {
    expect(_testOnlyCliContracts.decorateToolParameterDefinition("customParam", 7)).toMatchObject({
      description: "Custom Param.",
    });
    expect(_testOnlyCliContracts.decorateActionScopedToolParameterDefinition("get", "customParam", 7)).toMatchObject({
      description: "Custom Param.",
    });

    const metadata = _testOnlyCliContracts.toolParameterMetadata;
    const previousActionMetadata = metadata.action;
    delete metadata.action;
    try {
      const actionSchema = _testOnlyCliContracts.buildActionScopedToolSchema("get") as {
        properties?: Record<string, { description?: string }>;
      };
      expect(actionSchema.properties?.action?.description).toBe("Tool action to execute.");

      const providerSchema = _testOnlyCliContracts.buildProviderCompatibleToolSchema() as {
        properties?: Record<string, { description?: string }>;
      };
      expect(providerSchema.properties?.action?.description).toBe("Tool action to execute.");
    } finally {
      metadata.action = previousActionMetadata;
    }

    const contracts = _testOnlyCliContracts.toolActionSchemaContracts as Record<string, Record<string, unknown>>;
    const getContract = contracts.get;
    const previousOptional = getContract.optional;
    const previousOneOf = getContract.oneOfRequired;
    const previousConditional = getContract.conditionalRequired;
    const previousDependent = getContract.dependentAnyOfRequired;
    const previousMutuallyExclusive = getContract.mutuallyExclusive;
    try {
      getContract.optional = undefined;
      getContract.conditionalRequired = [{ property: "full", value: true, required: ["id"] }];
      getContract.dependentAnyOfRequired = [{ property: "mode", anyOfRequired: [["id"], ["query"]] }];
      const schemaWithAllOf = _testOnlyCliContracts.buildActionScopedToolSchema("get") as { allOf?: unknown[] };
      expect(Array.isArray(schemaWithAllOf.allOf)).toBe(true);

      // mutuallyExclusive appends to a pre-existing allOf (populated above by
      // conditionalRequired + dependentAnyOfRequired).
      getContract.mutuallyExclusive = [["id", "query"]];
      const schemaWithExclusiveAllOf = _testOnlyCliContracts.buildActionScopedToolSchema("get") as {
        allOf?: Array<{ not?: { required?: string[] } }>;
      };
      expect(
        schemaWithExclusiveAllOf.allOf?.some((entry) => entry.not?.required?.includes("query") === true),
      ).toBe(true);
      getContract.mutuallyExclusive = undefined;

      getContract.conditionalRequired = undefined;
      const schemaWithoutConditional = _testOnlyCliContracts.buildActionScopedToolSchema("get") as { allOf?: unknown[] };
      expect(Array.isArray(schemaWithoutConditional.allOf)).toBe(true);

      getContract.oneOfRequired = [["id", "query"], ["id"]];
      const schemaWithOneOfVariants = _testOnlyCliContracts.buildActionScopedToolSchema("get") as {
        oneOf?: Array<Record<string, unknown>>;
      };
      expect(Array.isArray(schemaWithOneOfVariants.oneOf)).toBe(true);

      getContract.oneOfRequired = [["id"]];
      const schemaWithSingleOneOf = _testOnlyCliContracts.buildActionScopedToolSchema("get") as {
        oneOf?: Array<Record<string, unknown>>;
      };
      expect(schemaWithSingleOneOf.oneOf?.length).toBe(1);
    } finally {
      getContract.optional = previousOptional;
      getContract.oneOfRequired = previousOneOf;
      getContract.conditionalRequired = previousConditional;
      getContract.dependentAnyOfRequired = previousDependent;
      getContract.mutuallyExclusive = previousMutuallyExclusive;
    }

    const focusSchema = _testOnlyCliContracts.buildActionScopedToolSchema("focus") as {
      allOf?: Array<{ not?: { required?: string[] } }>;
    };
    expect(
      focusSchema.allOf?.some(
        (entry) => entry.not?.required?.includes("id") === true && entry.not?.required?.includes("clear") === true,
      ),
    ).toBe(true);

    const historyRepairSchema = _testOnlyCliContracts.buildActionScopedToolSchema("history-repair") as {
      oneOf?: Array<{ required?: string[]; properties?: Record<string, unknown> }>;
    };
    expect(Array.isArray(historyRepairSchema.oneOf)).toBe(true);
    expect(historyRepairSchema.oneOf?.some((entry) => (entry.required ?? []).includes("all"))).toBe(true);

    expect(
      _testOnlyCliContracts.toProviderCompatibleParameterDefinition("untypedAnyOf", { anyOf: "not-an-array" } as never),
    ).toMatchObject({
      type: "string",
    });
  });
});

function createRegistrationRegistry(): ExtensionRegistrationRegistry {
  return {
    commands: [
      {
        layer: "project",
        name: "hello-ext",
        command: "hello world",
        action: "hello-world",
        description: "Say hello.",
        intent: "exercise sdk testing helpers",
        examples: ["pm hello world target"],
        failure_hints: [],
        arguments: [{ name: "target", required: true }],
      },
    ],
    flags: [
      {
        layer: "project",
        name: "hello-ext",
        target_command: "hello world",
        flags: [{ long: "--shout" }, { short: "-n", long: "--name", value_name: "value" }],
      },
      {
        layer: "global",
        name: "second-hello-ext",
        target_command: "hello world",
        flags: [{ long: "--format", value_name: "value" }],
      },
      {
        layer: "project",
        name: "list-ext",
        target_command: "list",
        flags: [{ long: "--list-note", value_name: "value" }],
      },
    ],
    item_fields: [
      {
        layer: "project",
        name: "schema-ext",
        fields: [
          { name: "severity", type: "string" },
          { name: "impact", type: "number", optional: true },
        ],
      },
    ],
    item_types: [
      {
        layer: "project",
        name: "schema-ext",
        types: [
          {
            name: "Incident",
            folder: "incidents",
            aliases: ["incident"],
            required_create_fields: ["severity"],
          },
        ],
      },
    ],
    migrations: [],
    importers: [
      { layer: "project", name: "todos-ext", importer: "todos" },
      { layer: "global", name: "beads-ext", importer: "beads" },
    ],
    exporters: [{ layer: "project", name: "todos-ext", exporter: "todos" }],
    search_providers: [
      {
        layer: "project",
        name: "search-ext",
        definition: { name: "semantic-local" },
        runtime_definition: { name: "semantic-local" },
      },
    ],
    vector_store_adapters: [
      {
        layer: "project",
        name: "search-ext",
        definition: { name: "pinecone", query: async () => [] },
        runtime_definition: { name: "pinecone", query: async () => [] },
      },
    ],
  };
}

function createHookRegistry(): ExtensionHookRegistry {
  return {
    beforeCommand: [{ layer: "project", name: "audit-ext", run: () => undefined }],
    afterCommand: [],
    onWrite: [
      { layer: "project", name: "first-write-ext", run: () => undefined },
      { layer: "global", name: "second-write-ext", run: () => undefined },
    ],
    onRead: [],
    onIndex: [],
  };
}

describe("public sdk entrypoint", () => {
  it("exposes deterministic capability names", () => {
    expect(EXTENSION_CAPABILITIES).toEqual([
      "commands",
      "renderers",
      "hooks",
      "schema",
      "importers",
      "search",
      "parser",
      "preflight",
      "services",
    ]);
  });

  it("returns extension modules unchanged", () => {
    const extensionModule = defineExtension({
      manifest: {
        name: "test-ext",
        version: "1.0.0",
        entry: "./index.js",
        priority: 10,
        capabilities: ["commands"],
      },
      activate: () => undefined,
    });
    expect(extensionModule.manifest?.name).toBe("test-ext");
    expect(typeof extensionModule.activate).toBe("function");
  });

  it("creates structural expected CLI errors for package authors", () => {
    const cause = new Error("source failure");
    const error = createPmCliExpectedError("Package command requires --file", {
      exitCode: EXIT_CODE.USAGE + 0.8,
      context: {
        code: "missing_file",
        why: "The package command cannot infer a source file.",
      },
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(PM_CLI_EXPECTED_ERROR_NAME);
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.context).toMatchObject({
      code: "missing_file",
      why: "The package command cannot infer a source file.",
    });
    expect(error.cause).toBe(cause);
    expect(Object.keys(error)).not.toContain("cause");
    expect(isPmCliExpectedError(error)).toBe(true);
    expect(isPmCliExpectedError(new Error("plain"))).toBe(false);
    const invalidShape = new Error("invalid shape") as Error & { exitCode: number };
    invalidShape.name = PM_CLI_EXPECTED_ERROR_NAME;
    invalidShape.exitCode = Number.NaN;
    expect(isPmCliExpectedError(invalidShape)).toBe(false);

    expect(() => createPmCliExpectedError("")).toThrow("message must be a non-empty string");
    expect(() => createPmCliExpectedError("bad exit", { exitCode: Number.NaN })).toThrow("finite number");
    expect(() => createPmCliExpectedError("bad exit", { exitCode: EXIT_CODE.SUCCESS })).toThrow("positive exit code");

    const defaultError = createPmCliExpectedError("default usage error");
    expect(defaultError.exitCode).toBe(EXIT_CODE.USAGE);
    expect(defaultError.context).toEqual({});
  });

  it("exposes package resource kind contracts", () => {
    expect(PM_PACKAGE_RESOURCE_KINDS).toEqual([
      "extensions",
      "docs",
      "examples",
      "assets",
      "prompts",
    ]);
  });

  it("exposes runtime enum contract guards for package-author validation", () => {
    expect(isPmToolAction("create")).toBe(true);
    expect(isPmToolAction("not-a-tool-action")).toBe(false);
    expect(isPmExtensionCapabilityContract("commands")).toBe(true);
    expect(isPmExtensionCapabilityContract("unknown-capability")).toBe(false);
    expect(isPmExtensionServiceNameContract("output_format")).toBe(true);
    expect(isPmExtensionServiceNameContract("unknown-service")).toBe(false);
    expect(isPmExtensionPolicyModeContract("enforce")).toBe(true);
    expect(isPmExtensionPolicyModeContract("unknown-mode")).toBe(false);
    expect(isPmExtensionPolicySurfaceContract("commands.handler")).toBe(true);
    expect(isPmExtensionPolicySurfaceContract("unknown-surface")).toBe(false);
  });

  it("asserts package manifest resources for package-author tests", async () => {
    await withTempPmPath(async ({ tempRoot }) => {
      const packageRoot = path.join(tempRoot, "package-author-helper");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "package-author-helper",
          version: "1.0.0",
          keywords: ["pm-package"],
          pm: {
            aliases: ["author-helper"],
            extensions: ["extensions/helper"],
            docs: ["README.md"],
            examples: ["examples/basic.md"],
          },
        }),
        "utf8",
      );

      const manifest = await readPmPackageManifest(packageRoot);

      expect(
        assertPackageManifestFromBarrel(manifest, {
          packageName: "package-author-helper",
          aliases: ["author-helper"],
          resources: {
            extensions: ["extensions/helper"],
            docs: ["README.md"],
          },
        }),
      ).toBe(manifest);
      expect(
        assertPackageManifest(manifest, {
          packageName: "package-author-helper",
        }),
      ).toBe(manifest);
      expect(
        assertPackageManifest(manifest, {
          resources: {
            examples: ["examples/basic.md"],
          },
        }),
      ).toBe(manifest);
      expect(() =>
        assertPackageManifest(manifest, {
          packageName: "wrong-package",
        }),
      ).toThrow('Expected package manifest package_name to be "wrong-package"; received "package-author-helper"');
      expect(() =>
        assertPackageManifest(manifest, {
          aliases: ["missing-alias"],
        }),
      ).toThrow("Expected package manifest aliases to include missing-alias; available: author-helper");
      expect(() =>
        assertPackageManifest(manifest, {
          resources: {
            extensions: ["extensions/missing"],
          },
        }),
      ).toThrow(
        "Expected package manifest pm.extensions to include extensions/missing; available: extensions/helper",
      );

      const emptyManifest = { resources: {} } as Parameters<typeof assertPackageManifest>[0];
      expect(() =>
        assertPackageManifest(emptyManifest, {
          packageName: "missing-package-name",
        }),
      ).toThrow('Expected package manifest package_name to be "missing-package-name"; received "(none)"');
      expect(() =>
        assertPackageManifest(emptyManifest, {
          aliases: ["missing-alias"],
        }),
      ).toThrow("Expected package manifest aliases to include missing-alias; available: (none)");
      expect(() =>
        assertPackageManifest(emptyManifest, {
          resources: {
            docs: ["README.md"],
          },
        }),
      ).toThrow("Expected package manifest pm.docs to include README.md; available: (none)");
    });
  });

  it("asserts registerFlags registrations for package-author tests", () => {
    const registrations = createRegistrationRegistry();

    const fromBarrel = assertRegisteredFlagsFromBarrel(registrations, {
      targetCommand: " hello   world ",
      extensionName: "hello-ext",
      flags: ["--shout", "-n", "--name"],
    });
    expect(fromBarrel.target_command).toBe("hello world");
    expect(fromBarrel.flags).toHaveLength(2);

    expect(
      assertRegisteredFlags(registrations, {
        targetCommand: "list",
      }),
    ).toBe(registrations.flags[2]);
    expect(() =>
      assertRegisteredFlags(registrations, {
        targetCommand: "hello world",
      }),
    ).toThrow(
      'Expected flags for target command "hello world" matched multiple extensions: hello-ext, second-hello-ext. Specify extensionName to choose one registration.',
    );

    expect(() =>
      assertRegisteredFlags(registrations, {
        targetCommand: "",
      }),
    ).toThrow("Expected target command name must be a non-empty string");
    expect(() =>
      assertRegisteredFlags(registrations, {
        targetCommand: "missing command",
      }),
    ).toThrow(
      'Expected flags for target command "missing command" to be registered. Available flag target commands: hello world, list; matching extensions: (none)',
    );
    expect(() =>
      assertRegisteredFlags(registrations, {
        targetCommand: "hello world",
        extensionName: "missing-ext",
      }),
    ).toThrow(
      'Expected flags for target command "hello world" from extension "missing-ext" to be registered. Available flag target commands: hello world, list; matching extensions: hello-ext, second-hello-ext',
    );
    expect(() =>
      assertRegisteredFlags(registrations, {
        targetCommand: "hello world",
        extensionName: "hello-ext",
        flags: ["--missing"],
      }),
    ).toThrow(
      'Expected flags for target command "hello world" to include --missing; missing --missing; available --name, --shout, -n',
    );
  });

  it("exposes stable pm tool contract constants through the sdk barrel", () => {
    expect(BUILTIN_ITEM_TYPE_VALUES).toContain("Task");
    expect(ITEM_TYPE_VALUES).toContain("Plan");
    expect(STATUS_VALUES).toContain("open");
    expect(PM_TOOL_ACTIONS).toContain("create");
    expect(PM_TOOL_ACTIONS).toContain("install");
    expect(PM_TOOL_ACTIONS).toContain("upgrade");
    expect(PM_TOOL_ACTIONS).not.toContain("beads-import");
    expect(PM_TOOL_ACTIONS).not.toContain("todos-export");
    expect(PM_TOOL_ACTIONS).not.toContain("calendar");
    expect(PM_TOOL_ACTIONS).not.toContain("templates-save");
    expect(PM_TOOL_ACTIONS).not.toEqual(
      expect.arrayContaining([
        "comments-audit",
        "completion",
        "dedupe-audit",
        "guide",
        "normalize",
        "reindex",
        "test-runs-list",
        "test-runs-status",
        "test-runs-logs",
        "test-runs-stop",
        "test-runs-resume",
      ]),
    );
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS).not.toHaveProperty("reindex");
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS).not.toHaveProperty("normalize");
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS).not.toHaveProperty("test-runs-list");
    expect(PM_CORE_COMMAND_NAMES).not.toEqual(
      expect.arrayContaining([
        "comments-audit",
        "completion",
        "dedupe-audit",
        "guide",
        "normalize",
        "reindex",
        "test-runs",
      ]),
    );

    expect(PM_TOOL_PARAMETERS_SCHEMA.type).toBe("object");
    expect(PM_TOOL_PARAMETERS_SCHEMA.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            action: expect.objectContaining({ const: "create" }),
          }),
        }),
      ]),
    );
    expect(PM_PROVIDER_TOOL_PARAMETERS_SCHEMA).toMatchObject({
      type: "object",
      properties: {
        action: { type: "string" },
      },
    });
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.create.required).toEqual(expect.arrayContaining(["title"]));
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.init.optional).toEqual(
      expect.arrayContaining(["defaults", "author", "agentGuidance", "typePreset", "withPackages", "verbose"]),
    );
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.schema.required).toEqual(["subcommand"]);
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.schema.optional).toEqual(expect.arrayContaining(["name"]));
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.upgrade.optional).toEqual(expect.arrayContaining(["dryRun"]));
  });

  it("materializes strict and provider-compatible tool schemas through the sdk barrel", () => {
    expect(PM_TOOL_PARAMETERS_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect("$id" in PM_TOOL_PARAMETERS_SCHEMA).toBe(true);
    expect("missing" in PM_TOOL_PARAMETERS_SCHEMA).toBe(false);
    expect(Object.keys(PM_TOOL_PARAMETERS_SCHEMA)).toEqual(
      expect.arrayContaining(["$schema", "$id", "title", "x-schema-version", "type", "oneOf"]),
    );
    expect(Object.getOwnPropertyDescriptor(PM_TOOL_PARAMETERS_SCHEMA, "oneOf")?.configurable).toBe(true);
    expect(Object.getOwnPropertyDescriptor(PM_TOOL_PARAMETERS_SCHEMA, "missing")).toBeUndefined();

    const strictSchema = JSON.parse(JSON.stringify(PM_TOOL_PARAMETERS_SCHEMA)) as {
      oneOf: Array<{ properties?: Record<string, unknown>; anyOf?: unknown; oneOf?: unknown; allOf?: unknown }>;
    };
    expect(strictSchema.oneOf.length).toBe(PM_TOOL_ACTIONS.length);
    const schemaForAction = (action: string) =>
      strictSchema.oneOf.find((entry) => (entry.properties?.action as { const?: string } | undefined)?.const === action);
    expect(schemaForAction("plan")).toMatchObject({
      properties: expect.objectContaining({ action: { const: "plan", description: expect.any(String) } }),
      required: expect.arrayContaining(["action", "subcommand"]),
    });
    expect(schemaForAction("extension-install")).toMatchObject({
      properties: expect.objectContaining({ action: { const: "extension-install", description: expect.any(String) } }),
      anyOf: expect.arrayContaining([
        expect.objectContaining({ required: ["target"] }),
        expect.objectContaining({ required: ["github"] }),
      ]),
    });
    expect(schemaForAction("history-repair")).toMatchObject({
      properties: expect.objectContaining({ action: { const: "history-repair", description: expect.any(String) } }),
      oneOf: expect.arrayContaining([expect.objectContaining({ properties: { all: { const: true } } })]),
    });
    expect(schemaForAction("schema")).toMatchObject({
      properties: expect.objectContaining({ action: { const: "schema", description: expect.any(String) } }),
      allOf: expect.any(Array),
    });

    const providerProperties = PM_PROVIDER_TOOL_PARAMETERS_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(providerProperties.action).toMatchObject({ type: "string", description: expect.any(String) });
    expect(providerProperties.options).toMatchObject({ type: "object", additionalProperties: true });
    expect(providerProperties.id).toMatchObject({ type: "string", description: expect.any(String) });
    expect(providerProperties.all).toMatchObject({ type: "boolean", description: expect.any(String) });
    expect(providerProperties.priority).toMatchObject({ type: "string", description: expect.any(String) });
    expect(providerProperties.priority).not.toHaveProperty("anyOf");
    expect(providerProperties.actualResult).toMatchObject({ type: "string", description: "Actual Result." });
    expect(providerProperties.confidence).toMatchObject({ type: "string", description: "Confidence." });
    expect(providerProperties.confidence).not.toHaveProperty("anyOf");
    expect(providerProperties.unknownFallbackExample).toBeUndefined();
    expect(Object.keys(PM_PROVIDER_TOOL_PARAMETERS_SCHEMA)).toEqual(
      expect.arrayContaining(["title", "x-schema-version", "type", "additionalProperties", "required", "properties"]),
    );
    expect(Object.getOwnPropertyDescriptor(PM_PROVIDER_TOOL_PARAMETERS_SCHEMA, "properties")?.configurable).toBe(true);

    expect(_testOnlyCliContracts.toProviderCompatibleParameterDefinition("noType", { anyOf: [{ enum: ["x"] }] })).toMatchObject({
      type: "string",
      description: "No Type.",
    });
    expect(
      _testOnlyCliContracts.toProviderCompatibleParameterDefinition("typedVariant", {
        anyOf: [{ enum: ["x"] }, { type: "number" }],
      }),
    ).toMatchObject({
      type: "number",
      description: "Typed Variant.",
    });
    const claimSchema = _testOnlyCliContracts.buildActionScopedToolSchema("claim") as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(claimSchema.properties?.action).toMatchObject({ const: "claim" });
    expect(claimSchema.required).toEqual(expect.arrayContaining(["action", "id"]));
    const docsSchema = _testOnlyCliContracts.buildActionScopedToolSchema("docs") as {
      allOf?: Array<{ then?: { anyOf?: Array<{ required?: string[] }> } }>;
    };
    expect(docsSchema.allOf?.some((entry) => entry.then?.anyOf?.some((variant) => variant.required?.includes("addGlob")))).toBe(true);
  });

  it("exposes command flag contract helpers with alias metadata and routing", () => {
    expect(
      withFlagAliasMetadata([
        { flag: "-x" },
        { flag: "--filter_status" },
        { flag: "--filter-status", aliases: ["--status-filter", "--filter_status"] },
        { flag: "--plain" },
      ]),
    ).toEqual([
      { flag: "-x" },
      { flag: "--filter_status" },
      { flag: "--filter-status", aliases: ["--status-filter", "--filter_status"] },
      { flag: "--plain" },
    ]);
    expect(
      compactFlagAliasContracts([
      { flag: "--filter_status" },
      { flag: "--filter-status", aliases: ["--status-filter"] },
      { flag: "--other" },
    ]),
  ).toEqual([
      { flag: "--filter-status", aliases: ["--status-filter", "--filter_status"] },
      { flag: "--other" },
    ]);
    expect(compactFlagAliasContracts([{ flag: "--only_underscore", aliases: ["--legacy"] }])).toEqual([
      { flag: "--only_underscore", aliases: ["--legacy"] },
    ]);
    expect(toCompletionFlagString([{ short: "-x", flag: "--example", aliases: ["--example_alias"] }], false)).toBe(
      "-x --example --example_alias",
    );
    expect(toCompletionFlagString([{ flag: "--json" }])).toContain("--pm-path");

    expect(
      _testOnlyCliContracts.withFlagAliasMetadata([
        { flag: "--json", aliases: ["json"] },
        { flag: "json", aliases: ["json"] },
      ]),
    ).toEqual([
      { flag: "--json", aliases: ["json"] },
      { flag: "json", aliases: ["json"] },
    ]);

    const flagsFor = (command: string | undefined) =>
      resolveSubcommandFlagContractsForCommand(command).map((contract) => contract.flag);
    expect(flagsFor(undefined)).toEqual(expect.arrayContaining(["--json", "--pm-path"]));
    expect(flagsFor(" LIST-OPEN ")).toEqual(expect.arrayContaining(["--status", "--ids"]));
    expect(flagsFor("reindex")).not.toContain("--mode");
    expect(flagsFor("help")).toEqual(expect.arrayContaining(["--json", "--pm-path"]));
    expect(flagsFor("templates")).toEqual(expect.arrayContaining(["--title", "--description"]));
    // Commands with dedicated flag tables but no MCP tool action still resolve
    // their own contracts (not globals-only) for argv normalization + usage.
    expect(flagsFor("guide")).toEqual(expect.arrayContaining(["--list", "--depth"]));
    expect(flagsFor("completion")).toEqual(expect.arrayContaining(["--eager-tags"]));
    expect(flagsFor("dedupe-audit")).toEqual(expect.arrayContaining(["--mode", "--threshold"]));
    expect(flagsFor("dedupe-merge")).toEqual(expect.arrayContaining(["--keep", "--apply"]));
    expect(flagsFor("normalize")).toEqual(expect.arrayContaining(["--filter-status", "--apply"]));
    expect(flagsFor("comments-audit")).toEqual(expect.arrayContaining(["--limit-items", "--latest"]));
    expect(flagsFor("cal")).toEqual(expect.arrayContaining(["--from", "--to"]));
    expect(flagsFor("ctx")).toEqual(expect.arrayContaining(["--depth"]));
    expect(flagsFor("test-runs-worker")).toEqual(expect.arrayContaining(["--status", "--tail"]));
    expect(flagsFor("extension init")).toEqual(expect.arrayContaining(["--project", "--global", "--capability"]));
    expect(flagsFor("extension install")).toEqual(expect.arrayContaining(["--github", "--ref"]));
    expect(flagsFor("extension uninstall")).toEqual(expect.arrayContaining(["--project", "--global"]));
    expect(flagsFor("extension explore")).toEqual(expect.arrayContaining(["--project", "--global"]));
    expect(flagsFor("extension")).toEqual(expect.arrayContaining(["--install", "--catalog"]));
    expect(flagsFor("extension manage")).toEqual(expect.arrayContaining(["--runtime-probe", "--fix-managed-state"]));
    expect(flagsFor("extension describe")).toEqual(expect.arrayContaining(["--project", "--global"]));
    expect(flagsFor("extension reload")).toEqual(expect.arrayContaining(["--watch", "--global"]));
    expect(flagsFor("packages doctor")).toEqual(expect.arrayContaining(["--strict-exit", "--trace"]));
    expect(flagsFor("extension catalog")).toEqual(expect.arrayContaining(["--fields", "--global"]));
    expect(flagsFor("extension adopt")).toEqual(expect.arrayContaining(["--github", "--ref"]));
    expect(flagsFor("extension adopt-all")).toEqual(expect.arrayContaining(["--project", "--global"]));
    expect(flagsFor("extension activate")).toEqual(expect.arrayContaining(["--project", "--global"]));
    expect(flagsFor("extension deactivate")).toEqual(expect.arrayContaining(["--project", "--global"]));
    expect(flagsFor("package unknown")).toEqual(expect.arrayContaining(["--json"]));
    expect(flagsFor("packages")).toEqual(expect.arrayContaining(["--install", "--catalog", "--capability"]));
    expect(flagsFor("extension install extra")).toEqual(expect.arrayContaining(["--json"]));
    expect(flagsFor("package")).toEqual(expect.arrayContaining(["--install", "--catalog"]));
    expect(flagsFor("history-repair")).toEqual(expect.arrayContaining(["--all", "--dry-run"]));
    expect(flagsFor("close-many")).toEqual(expect.arrayContaining(["--filter-status", "--reason"]));
    expect(flagsFor("validate")).toEqual(expect.arrayContaining(["--check-resolution", "--fix-scope"]));
    expect(flagsFor("delete")).toEqual(expect.arrayContaining(["--dry-run"]));
    expect(flagsFor("init")).toEqual(expect.arrayContaining(["--force", "--agent-guidance"]));
    expect(flagsFor("mystery-command")).toEqual(expect.arrayContaining(["--json", "--pm-path"]));
    expect(flagsFor("config")).toEqual(expect.arrayContaining(["--policy", "--criterion"]));
    expect(flagsFor("install")).toEqual(expect.arrayContaining(["--github", "--global"]));
    expect(flagsFor("upgrade")).toEqual(expect.arrayContaining(["--dry-run", "--repair"]));
    expect(flagsFor("create")).toEqual(expect.arrayContaining(["--title", "--type"]));
    expect(flagsFor("append")).toEqual(expect.arrayContaining(["--body"]));
    expect(flagsFor("comments")).toEqual(expect.arrayContaining(["--add"]));
    expect(flagsFor("notes")).toEqual(expect.arrayContaining(["--add"]));
    expect(flagsFor("learnings")).toEqual(expect.arrayContaining(["--add"]));
    expect(flagsFor("files")).toEqual(expect.arrayContaining(["--add", "--add-glob"]));
    expect(flagsFor("docs")).toEqual(expect.arrayContaining(["--add", "--add-glob"]));
    expect(flagsFor("deps")).toEqual(expect.arrayContaining(["--max-depth"]));
    expect(flagsFor("test")).toEqual(expect.arrayContaining(["--run", "--background"]));
    expect(flagsFor("test-all")).toEqual(expect.arrayContaining(["--progress"]));
    expect(flagsFor("telemetry")).toEqual(expect.arrayContaining(["--limit"]));
    expect(flagsFor("health")).toEqual(expect.arrayContaining(["--check-only", "--strict-exit"]));
    expect(flagsFor("gc")).toEqual(expect.arrayContaining(["--dry-run"]));
    expect(flagsFor("stats")).toEqual(expect.arrayContaining(["--storage"]));
    expect(flagsFor("contracts")).toEqual(expect.arrayContaining(["--flags-only"]));
    expect(flagsFor("claim")).toEqual(expect.arrayContaining(["--message"]));
    expect(flagsFor("release")).toEqual(expect.arrayContaining(["--message"]));
    expect(flagsFor("copy")).toEqual(expect.arrayContaining(["--title", "--message"]));
    expect(flagsFor("aggregate")).toEqual(expect.arrayContaining(["--group-by", "--count"]));
    expect(flagsFor("calendar")).toEqual(expect.arrayContaining(["--from", "--to"]));
    expect(flagsFor("context")).toEqual(expect.arrayContaining(["--depth"]));
    expect(flagsFor("get")).toEqual(expect.arrayContaining(["--full"]));
    expect(flagsFor("search")).toEqual(expect.arrayContaining(["--mode", "--semantic"]));
    expect(flagsFor("history")).toEqual(expect.arrayContaining(["--limit", "--verify"]));
    expect(flagsFor("history-redact")).toEqual(expect.arrayContaining(["--literal", "--replacement"]));
    expect(flagsFor("history-compact")).toEqual(expect.arrayContaining(["--before", "--dry-run"]));
    expect(flagsFor("schema")).toEqual(expect.arrayContaining(["--description", "--default-status"]));
    expect(flagsFor("plan")).toEqual(expect.arrayContaining(["--step", "--materialize-type"]));
    expect(flagsFor("activity")).toEqual(expect.arrayContaining(["--from", "--limit"]));
    expect(flagsFor("restore")).toEqual(expect.arrayContaining(["--author", "--message"]));
    expect(flagsFor("update")).toEqual(expect.arrayContaining(["--title", "--status"]));
    expect(flagsFor("update-many")).toEqual(expect.arrayContaining(["--title", "--filter-status"]));
    expect(flagsFor("close")).toEqual(expect.arrayContaining(["--duplicate-of", "--validate-close"]));
    expect(flagsFor("start-task")).toEqual(expect.arrayContaining(["--message"]));
    expect(flagsFor("pause-task")).toEqual(expect.arrayContaining(["--message"]));
    expect(flagsFor("close-task")).toEqual(expect.arrayContaining(["--message"]));
    expect(flagsFor("unknown-command")).toEqual(expect.arrayContaining(["--json", "--pm-path"]));
  });

  it("exposes runtime primitives used by TypeScript pm packages through the sdk barrel", () => {
    expect(typeof pathExists).toBe("function");
    expect(typeof readFileIfExists).toBe("function");
    expect(typeof writeFileAtomic).toBe("function");
    expect(typeof appendHistoryEntry).toBe("function");
    expect(typeof createHistoryEntry).toBe("function");
    expect(typeof generateItemId).toBe("function");
    expect(typeof normalizeItemId).toBe("function");
    expect(typeof getItemPath).toBe("function");
    expect(typeof locateItem).toBe("function");
    expect(typeof readSettings).toBe("function");
    expect(typeof resolvePmRoot).toBe("function");
  });

  it("locates default-prefixed items from the sdk barrel without explicit idPrefix", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-sdk-locate-default-prefix";
      const itemPath = getItemPath(pmPath, "Task", id, "toon");
      await mkdir(path.dirname(itemPath), { recursive: true });
      await writeFile(
        itemPath,
        serializeItemDocument(
          {
            metadata: {
              id,
              title: "SDK locateItem default prefix",
              description: "package authors can omit the default pm id prefix",
              type: "Task",
              status: "open",
              priority: 1,
              tags: ["sdk"],
              created_at: "2026-06-10T00:00:00.000Z",
              updated_at: "2026-06-10T00:00:00.000Z",
            },
            body: "",
          },
          { format: "toon" },
        ),
        "utf8",
      );

      const located = await locateItem(pmPath, id);

      expect(located).toMatchObject({
        id,
        type: "Task",
        item_format: "toon",
      });
    });
  });

  it("re-exports the sdk testing assertion helpers through the barrel", () => {
    expect(typeof assertRegisteredCommandContractFromBarrel).toBe("function");
    expect(typeof assertRegisteredHookFromBarrel).toBe("function");
    expect(typeof assertRegisteredSearchProviderFromBarrel).toBe("function");
    expect(typeof assertRegisteredImporterFromBarrel).toBe("function");
    expect(typeof assertRegisteredExporterFromBarrel).toBe("function");
    expect(typeof assertRegisteredItemFieldFromBarrel).toBe("function");
    expect(typeof assertRegisteredItemTypeFromBarrel).toBe("function");
    expect(typeof assertRegisteredVectorStoreAdapterFromBarrel).toBe("function");
    expect(typeof activateExtensionForTestFromBarrel).toBe("function");
    expect(typeof deactivateExtensionForTestFromBarrel).toBe("function");
    expect(deactivateExtensionForTestFromBarrel).toBe(deactivateExtensionForTest);
    expect(runRegisteredCommandForTestFromBarrel).toBe(runRegisteredCommandForTest);
    // Lock the invoke-verb helpers (hooks + override runners) to the same
    // implementation the testing entrypoint exports.
    expect(runRegisteredHookForTestFromBarrel).toBe(runRegisteredHookForTest);
    expect(runRegisteredParserOverrideForTestFromBarrel).toBe(runRegisteredParserOverrideForTest);
    expect(runRegisteredPreflightOverrideForTestFromBarrel).toBe(runRegisteredPreflightOverrideForTest);
    expect(runRegisteredCommandOverrideForTestFromBarrel).toBe(runRegisteredCommandOverrideForTest);
    expect(runRegisteredRendererOverrideForTestFromBarrel).toBe(runRegisteredRendererOverrideForTest);
    expect(runRegisteredServiceOverrideForTestFromBarrel).toBe(runRegisteredServiceOverrideForTest);
    // Lock the invoke-verb helpers for the executable registration surfaces
    // (search providers, vector store adapters, migrations) to the same
    // implementation the testing entrypoint exports.
    expect(runRegisteredSearchProviderForTestFromBarrel).toBe(runRegisteredSearchProviderForTest);
    expect(runRegisteredVectorStoreAdapterForTestFromBarrel).toBe(runRegisteredVectorStoreAdapterForTest);
    expect(runRegisteredMigrationForTestFromBarrel).toBe(runRegisteredMigrationForTest);
    // Lock the importer/exporter invoke-verb helpers — the final executable
    // registration surfaces — to the same implementation the testing entrypoint
    // exports.
    expect(runRegisteredImporterForTestFromBarrel).toBe(runRegisteredImporterForTest);
    expect(runRegisteredExporterForTestFromBarrel).toBe(runRegisteredExporterForTest);
    expect(assertExtensionDeactivatedFromBarrel).toBe(assertExtensionDeactivated);
    // Lock the unified harness factory — the capstone over every standalone
    // helper — to the same implementation the testing entrypoint exports.
    expect(typeof createExtensionTestHarnessFromBarrel).toBe("function");
    expect(createExtensionTestHarnessFromBarrel).toBe(createExtensionTestHarness);
    // Lock the new override-assertion helpers to the same implementation the
    // testing entrypoint exports (barrel-contract for this PR's SDK surface).
    expect(assertRegisteredCommandOverrideFromBarrel).toBe(assertRegisteredCommandOverride);
    expect(assertRegisteredParserOverrideFromBarrel).toBe(assertRegisteredParserOverride);
    expect(assertRegisteredPreflightOverrideFromBarrel).toBe(assertRegisteredPreflightOverride);
    expect(assertRegisteredRendererOverrideFromBarrel).toBe(assertRegisteredRendererOverride);
    expect(assertRegisteredServiceOverrideFromBarrel).toBe(assertRegisteredServiceOverride);
    expect(assertRegisteredMigrationFromBarrel).toBe(assertRegisteredMigration);
    expect(assertExtensionCapabilityUsageFromBarrel).toBe(assertExtensionCapabilityUsage);
  });

  it("asserts least-privilege capability usage for package-author tests", async () => {
    const activation = await activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.registerCommand({ name: "least hello", action: "least-hello", run: async () => ({ ok: true }) });
          api.registerItemFields([{ name: "severity", type: "string" }]);
        },
      },
      { name: "least-ext", capabilities: ["commands", "schema"] },
    );

    // A manifest that uses every declared capability passes and returns the
    // declared/used/unused breakdown.
    expect(assertExtensionCapabilityUsage(activation, { declared: ["commands", "schema"] })).toEqual({
      declared: ["commands", "schema"],
      used: ["commands", "schema"],
      unused: [],
    });
    // Declaration order and casing are normalized.
    expect(
      assertExtensionCapabilityUsage(activation, { declared: ["Schema", "commands", "commands"] }).declared,
    ).toEqual(["commands", "schema"]);
    // Filtering to the extension by name works.
    expect(assertExtensionCapabilityUsage(activation, { declared: ["commands"], extensionName: "least-ext" }).used).toEqual([
      "commands",
      "schema",
    ]);

    // A single unused capability throws with singular phrasing and the scope.
    expect(() =>
      assertExtensionCapabilityUsage(activation, { declared: ["commands", "schema", "search"], extensionName: "least-ext" }),
    ).toThrow(/extension "least-ext".*\[search\] is declared yet never registered against/s);
    // Multiple unused capabilities throw with plural phrasing.
    expect(() =>
      assertExtensionCapabilityUsage(activation, { declared: ["commands", "schema", "search", "hooks"] }),
    ).toThrow(/\[hooks, search\] are declared yet never registered against/);
    // allowUnused suppresses the failure for conditionally-registered capabilities.
    expect(
      assertExtensionCapabilityUsage(activation, { declared: ["commands", "schema", "search"], allowUnused: ["search"] })
        .unused,
    ).toEqual([]);
    // An unknown declared capability is rejected outright.
    expect(() => assertExtensionCapabilityUsage(activation, { declared: ["made-up"] })).toThrow(
      /declared capability "made-up" to be a known extension capability/,
    );
    // A typo in allowUnused is rejected too, so it cannot silently bypass the guard.
    expect(() =>
      assertExtensionCapabilityUsage(activation, { declared: ["commands"], allowUnused: ["schem"] }),
    ).toThrow(/allowUnused capability "schem" to be a known extension capability/);
  });

  it("deactivates an in-memory extension and asserts a clean teardown", async () => {
    // Full manifest + default options: name comes from the manifest, the layer
    // defaults to "project", no per-hook timeout is forwarded, and no prior
    // activation result is supplied.
    let cleared = false;
    const cleanResult = await deactivateExtensionForTest({
      manifest: { name: "teardown-ext", version: "1.2.3", entry: "./entry.js", priority: 7 },
      activate() {},
      deactivate() {
        cleared = true;
      },
    });
    expect(cleared).toBe(true);
    expect(cleanResult).toEqual({ deactivated: 1, warnings: [], failed: [] });
    // The default expectation (one clean teardown, no failures) passes and the
    // result is returned for chaining.
    expect(assertExtensionDeactivated(cleanResult)).toBe(cleanResult);

    // A bare module with no manifest falls back to the synthetic defaults, and
    // explicit layer/timeout options exercise the non-default branches.
    const bareResult = await deactivateExtensionForTest(
      { activate() {}, deactivate() {} },
      { layer: "global", deactivateTimeoutMs: 1000 },
    );
    expect(bareResult.deactivated).toBe(1);

    // A forwarded activation result whose `failed` entry matches the resolved
    // name/layer skips teardown (the extension never finished activating).
    const skippedResult = await deactivateExtensionForTest(
      {
        activate() {},
        deactivate() {
          throw new Error("should not run for a failed activation");
        },
      },
      {
        name: "skip-me",
        activation: { failed: [{ layer: "project", name: "skip-me", entry_path: "", error: "boom" }] },
      },
    );
    expect(skippedResult).toEqual({ deactivated: 0, warnings: [], failed: [] });

    // A throwing teardown is captured as a best-effort failure rather than
    // propagated, so the result records it without rejecting.
    const failingResult = await deactivateExtensionForTest({
      activate() {},
      deactivate() {
        throw new Error("teardown blew up");
      },
    });
    expect(failingResult.deactivated).toBe(0);
    expect(failingResult.failed).toHaveLength(1);
    expect(failingResult.failed[0]).toMatchObject({ layer: "project", name: "test-extension" });
    expect(failingResult.warnings).toEqual(["extension_deactivate_failed:project:test-extension"]);

    // assertExtensionDeactivated surfaces a deactivated-count mismatch (singular
    // and plural phrasing) and a failure-count mismatch (with and without the
    // failure detail / singular and plural phrasing).
    expect(() => assertExtensionDeactivated(failingResult)).toThrow(
      "Expected 1 extension to deactivate cleanly, but 0 did.",
    );
    expect(() => assertExtensionDeactivated(cleanResult, { deactivated: 2 })).toThrow(
      "Expected 2 extensions to deactivate cleanly, but 1 did.",
    );
    expect(() => assertExtensionDeactivated(failingResult, { deactivated: 0 })).toThrow(
      /Expected 0 teardown failures, but observed 1: project:test-extension \(teardown blew up\)\./,
    );
    expect(() => assertExtensionDeactivated(cleanResult, { failed: 1 })).toThrow(
      "Expected 1 teardown failure, but observed 0.",
    );
    // Matching both expected counts (zero clean teardowns, one failure) passes.
    expect(assertExtensionDeactivated(failingResult, { deactivated: 0, failed: 1 })).toBe(failingResult);
  });

  it("invokes a registered command handler and returns its result for package tests", async () => {
    const seen: Array<{ args: string[]; options: Record<string, unknown>; global: unknown; pmRoot: string }> = [];
    const activation = await activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.registerCommand({
            name: "greet hello",
            action: "greet-hello",
            run: (context) => {
              seen.push({
                args: context.args,
                options: context.options,
                global: context.global,
                pmRoot: context.pm_root,
              });
              return { greeting: `hi ${context.args[0] ?? "world"}`, loud: context.options.loud === true };
            },
          });
          api.registerCommand({
            name: "greet boom",
            action: "greet-boom",
            run: () => {
              throw new Error("handler exploded");
            },
          });
          api.registerCommand({
            name: "greet exit",
            action: "greet-exit",
            run: () => {
              throw Object.assign(new Error("exit please"), { exitCode: 2 });
            },
          });
        },
      },
      { name: "greet-ext", capabilities: ["commands"] },
    );

    // A clean run forwards args/options/pmRoot and merges agent-safe global
    // defaults (json+quiet+noPager) with the caller's override.
    const result = await runRegisteredCommandForTest(activation.commands, {
      command: "greet hello",
      args: ["alice"],
      options: { loud: true },
      global: { quiet: false },
      pmRoot: "/tmp/example-root",
    });
    expect(result).toEqual({ handled: true, result: { greeting: "hi alice", loud: true }, warnings: [] });
    expect(seen).toEqual([
      {
        args: ["alice"],
        options: { loud: true },
        global: { json: true, quiet: false, noPager: true },
        pmRoot: "/tmp/example-root",
      },
    ]);

    // Defaults: no args/options/global/pmRoot supplied. The command name is
    // normalized (extra whitespace + casing) before matching the handler.
    const defaulted = await runRegisteredCommandForTest(activation.commands, { command: "  Greet   Hello  " });
    expect(defaulted.result).toEqual({ greeting: "hi world", loud: false });
    expect(seen[1]).toEqual({ args: [], options: {}, global: { json: true, quiet: true, noPager: true }, pmRoot: "" });

    // A handler that throws a non-exit error yields a soft failure the caller
    // can assert on, rather than propagating.
    const boom = await runRegisteredCommandForTest(activation.commands, { command: "greet boom" });
    expect(boom.handled).toBe(false);
    expect(boom.warnings).toEqual(["extension_command_handler_failed:project:greet-ext:greet boom"]);
    expect(boom.errorMessage).toBe("handler exploded");

    // A handler that throws an error carrying a numeric exitCode propagates the
    // throw, matching runtime dispatch semantics.
    await expect(runRegisteredCommandForTest(activation.commands, { command: "greet exit" })).rejects.toThrow(
      "exit please",
    );

    // An empty command name is rejected outright.
    await expect(runRegisteredCommandForTest(activation.commands, { command: "   " })).rejects.toThrow(
      "Expected command name must be a non-empty string",
    );

    // An unregistered command throws a descriptive error listing the available
    // handler command paths.
    await expect(runRegisteredCommandForTest(activation.commands, { command: "greet missing" })).rejects.toThrow(
      /Expected a registered command handler for "greet missing" to invoke\. Available command handlers: greet boom, greet exit, greet hello/,
    );

    // A registry with no handlers reports "(none)" for the available list.
    await expect(
      runRegisteredCommandForTest({ overrides: [], handlers: [] }, { command: "anything" }),
    ).rejects.toThrow(/Available command handlers: \(none\)/);
  });

  it("invokes a registered importer by name and returns its handler result for package tests", async () => {
    const activation = await activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.registerImporter("csv", (context) => ({
            registration: context.registration,
            action: context.action,
            rows: context.options.rows ?? 0,
            first: context.args[0] ?? null,
            quiet: context.global.quiet,
            pmRoot: context.pm_root,
          }));
          api.registerImporter("boom", () => {
            throw new Error("import exploded");
          });
        },
      },
      { name: "io-ext", capabilities: ["importers"] },
    );

    // The importer name is resolved case-insensitively, the `"<name> import"`
    // command path is derived internally, and args/options/pmRoot are forwarded
    // while agent-safe global defaults merge with the caller override.
    const result = await runRegisteredImporterForTest(activation, {
      importer: "CSV",
      args: ["source.csv"],
      options: { rows: 3 },
      global: { quiet: false },
      pmRoot: "/tmp/import-root",
    });
    expect(result).toEqual({
      handled: true,
      result: { registration: "csv", action: "import", rows: 3, first: "source.csv", quiet: false, pmRoot: "/tmp/import-root" },
      warnings: [],
    });

    // Defaults: no args/options/global/pmRoot supplied.
    const defaulted = await runRegisteredImporterForTest(activation, { importer: "csv" });
    expect(defaulted.result).toEqual({
      registration: "csv",
      action: "import",
      rows: 0,
      first: null,
      quiet: true,
      pmRoot: "",
    });

    // An importer whose handler throws a non-exit error yields a soft failure
    // the caller can assert on, exactly like the command runner.
    const boom = await runRegisteredImporterForTest(activation, { importer: "boom" });
    expect(boom.handled).toBe(false);
    expect(boom.errorMessage).toBe("import exploded");

    // An unregistered importer throws the descriptive "available importers"
    // error from assertRegisteredImporter.
    await expect(runRegisteredImporterForTest(activation, { importer: "missing" })).rejects.toThrow(
      /Expected importer "missing" to be registered\. Available importers: boom, csv/,
    );
  });

  it("invokes a registered exporter by name and returns its handler result for package tests", async () => {
    const activation = await activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.registerExporter("csv", (context) => ({
            registration: context.registration,
            action: context.action,
            limit: context.options.limit ?? 0,
          }));
          api.registerExporter("explode", () => {
            throw Object.assign(new Error("export aborted"), { exitCode: 2 });
          });
        },
      },
      { name: "io-ext", capabilities: ["importers"] },
    );

    // The exporter handler reports action "export" and forwards options.
    const result = await runRegisteredExporterForTest(activation, {
      exporter: "csv",
      extensionName: "io-ext",
      options: { limit: 5 },
    });
    expect(result).toEqual({
      handled: true,
      result: { registration: "csv", action: "export", limit: 5 },
      warnings: [],
    });

    // An exporter whose handler throws an error carrying a numeric exitCode
    // propagates the throw, matching runtime export semantics.
    await expect(runRegisteredExporterForTest(activation, { exporter: "explode" })).rejects.toThrow("export aborted");

    // An unregistered exporter throws the descriptive "available exporters"
    // error from assertRegisteredExporter.
    await expect(runRegisteredExporterForTest(activation, { exporter: "missing" })).rejects.toThrow(
      /Expected exporter "missing" to be registered\. Available exporters: csv, explode/,
    );
  });

  it("exposes runtime contracts without requiring a pm subprocess", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const result = await getContracts(pmPath, {
        command: "init",
        flagsOnly: true,
        noExtensions: true,
      });

      expect(result.selected.command).toBe("init");
      expect(result.selected.flags_only).toBe(true);
      expect(result.commands).toEqual(["init"]);
      expect(result.command_flags?.[0]?.flags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ flag: "--defaults" }),
          expect.objectContaining({ flag: "--with-packages" }),
        ]),
      );
      expect(result.schema).toBeUndefined();
    });
  });

  it("exposes lightweight workspace schema contracts without requiring a pm subprocess", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settings = await readCoreSettings(pmPath);
      settings.item_types.definitions = [
        ...(settings.item_types.definitions ?? []),
        {
          name: "Experiment",
          folder: "experiments",
          aliases: ["exp"],
        },
      ];
      await writeSettings(pmPath, settings, "settings:write");
      await mkdir(path.join(pmPath, "schema"), { recursive: true });
      await writeFile(
        path.join(pmPath, "schema", "statuses.json"),
        `${JSON.stringify(
          {
            statuses: [
              { id: "queued", roles: ["active", "default_open"] },
              { id: "reviewing", roles: ["active"] },
              { id: "shipped", roles: ["terminal", "terminal_done", "default_close"] },
              { id: "dropped", roles: ["terminal", "terminal_canceled", "default_cancel"] },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(pmPath, "schema", "workflows.json"),
        `${JSON.stringify(
          {
            workflow: {
              open_status: "queued",
              close_status: "shipped",
              canceled_status: "dropped",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const contracts = await getWorkspaceContracts(pmPath);

      expect(contracts.types).toEqual(expect.arrayContaining(["Task", "Experiment"]));
      expect(contracts.statuses).toEqual(expect.arrayContaining(["queued", "reviewing", "shipped", "dropped"]));
      expect(contracts.openStatus).toBe("queued");
      expect(contracts.closeStatus).toBe("shipped");
      expect(contracts.canceledStatus).toBe("dropped");

      const settingsOnlyContracts = await getWorkspaceContracts(pmPath, { noExtensions: true });
      expect(settingsOnlyContracts.types).toEqual(expect.arrayContaining(["Task", "Experiment"]));
    });
  });

  it("includes extension-registered item types in runtime workspace contracts", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: pmPath,
        placement: "projectRoot",
        directory: "workspace-contract-ext",
        manifest: {
          name: "workspace-contract-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerItemTypes([{ name: 'ExperimentRun', folder: 'experiment-runs' }]);",
          "}",
          "",
        ].join("\n"),
      });

      const workspaceContracts = await getWorkspaceContracts(pmPath);
      expect(workspaceContracts.types).toEqual(expect.arrayContaining(["Task", "ExperimentRun"]));

      await writeTestExtension({
        root: pmPath,
        placement: "projectRoot",
        directory: "workspace-contract-second-ext",
        manifest: {
          name: "workspace-contract-second-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerItemTypes([{ name: 'CachedUntilClear', folder: 'cached-until-clear' }]);",
          "}",
          "",
        ].join("\n"),
      });

      const cachedContracts = await getWorkspaceContracts(pmPath);
      expect(cachedContracts.types).not.toContain("CachedUntilClear");
      clearWorkspaceContractsCache();
      const refreshedContracts = await getWorkspaceContracts(pmPath);
      expect(refreshedContracts.types).toEqual(expect.arrayContaining(["ExperimentRun", "CachedUntilClear"]));

      const runtimeContracts = await getContracts(pmPath, {
        runtimeOnly: true,
      });
      expect(runtimeContracts.runtime_schema?.types).toEqual(expect.arrayContaining(["ExperimentRun"]));

      const optionObjectContracts = await getContracts({
        pmRoot: pmPath,
        command: "init",
        flagsOnly: true,
        noExtensions: true,
      });
      expect(optionObjectContracts.selected.command).toBe("init");

      const defaultContracts = await getContracts();
      expect(defaultContracts.schema_version).toBe(PM_TOOL_PARAMETERS_SCHEMA_VERSION);
    });
  });

  it("evicts the oldest workspace contracts cache entry when the process memo reaches its limit", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      clearWorkspaceContractsCache();
      await writeTestExtension({
        root: pmPath,
        placement: "projectRoot",
        directory: "workspace-contract-eviction-ext",
        manifest: {
          name: "workspace-contract-eviction-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerItemTypes([{ name: 'EvictionBase', folder: 'eviction-base' }]);",
          "}",
          "",
        ].join("\n"),
      });

      const cwdRoot = path.join(tempRoot, "workspace-contract-cwds");
      await mkdir(cwdRoot, { recursive: true });
      const firstCwd = path.join(cwdRoot, "cwd-0");
      await mkdir(firstCwd, { recursive: true });
      const firstContracts = await getWorkspaceContracts(pmPath, { cwd: firstCwd });
      expect(firstContracts.types).toContain("EvictionBase");

      await writeTestExtension({
        root: pmPath,
        placement: "projectRoot",
        directory: "workspace-contract-after-eviction-ext",
        manifest: {
          name: "workspace-contract-after-eviction-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerItemTypes([{ name: 'EvictedThenVisible', folder: 'evicted-then-visible' }]);",
          "}",
          "",
        ].join("\n"),
      });

      for (let index = 1; index <= 50; index += 1) {
        const cwd = path.join(cwdRoot, `cwd-${index}`);
        await mkdir(cwd, { recursive: true });
        await getWorkspaceContracts(pmPath, { cwd });
      }

      const refreshedFirstContracts = await getWorkspaceContracts(pmPath, { cwd: firstCwd });
      expect(refreshedFirstContracts.types).toEqual(expect.arrayContaining(["EvictionBase", "EvictedThenVisible"]));
      clearWorkspaceContractsCache();
    });
  });

  it("keys workspace contracts cache by extension enablement settings", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      clearWorkspaceContractsCache();
      await writeTestExtension({
        root: pmPath,
        placement: "projectRoot",
        directory: "workspace-contract-toggle-ext",
        manifest: {
          name: "workspace-contract-toggle-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerItemTypes([{ name: 'ToggleVisible', folder: 'toggle-visible' }]);",
          "}",
          "",
        ].join("\n"),
      });

      const enabledContracts = await getWorkspaceContracts(pmPath);
      expect(enabledContracts.types).toContain("ToggleVisible");

      const settings = await readCoreSettings(pmPath);
      await writeSettings(pmPath, {
        ...settings,
        extensions: {
          ...settings.extensions,
          disabled: ["workspace-contract-toggle-ext"],
        },
      });

      const disabledContracts = await getWorkspaceContracts(pmPath);
      expect(disabledContracts.types).not.toContain("ToggleVisible");
      clearWorkspaceContractsCache();
    });
  });
});

describe("sdk testing helpers", () => {
  it("asserts an extension command registration contract", () => {
    const result = assertRegisteredCommandContract(createRegistrationRegistry(), {
      command: " Hello   World ",
      action: "hello-world",
      extensionName: "hello-ext",
      arguments: ["target"],
      flags: ["--shout", "--name", "-n"],
    });

    expect(result.command.command).toBe("hello world");
    expect(result.flags).toHaveLength(2);
  });

  it("throws actionable assertion errors for missing command metadata", () => {
    const resultWithoutFlagExpectations = assertRegisteredCommandContract(createRegistrationRegistry(), {
      command: "hello world",
      arguments: ["target"],
    });
    expect(resultWithoutFlagExpectations.flags).toHaveLength(3);

    const registryWithBlankFlagLabels = createRegistrationRegistry();
    registryWithBlankFlagLabels.flags[0]!.flags.push({ long: " " }, { short: " " });
    expect(
      assertRegisteredCommandContract(registryWithBlankFlagLabels, {
        command: "hello world",
        flags: ["--shout"],
      }).flags,
    ).toHaveLength(5);

    const registryWithoutArguments = createRegistrationRegistry();
    delete registryWithoutArguments.commands[0]!.arguments;
    expect(() =>
      assertRegisteredCommandContract(registryWithoutArguments, {
        command: "hello world",
        arguments: ["target"],
      }),
    ).toThrow(/available \(none\)/);

    expect(() =>
      assertRegisteredCommandContract(createRegistrationRegistry(), {
        command: "   ",
      }),
    ).toThrow("non-empty string");

    expect(() =>
      assertRegisteredCommandContract(createRegistrationRegistry(), {
        command: "hello world",
        action: "different-action",
      }),
    ).toThrow('Expected extension command "hello world" action "different-action"');

    expect(() =>
      assertRegisteredCommandContract(createRegistrationRegistry(), {
        command: "hello world",
        arguments: ["missing-arg"],
      }),
    ).toThrow(/missing missing-arg/);

    expect(() =>
      assertRegisteredCommandContract(createRegistrationRegistry(), {
        command: "hello world",
        action: "hello-world",
        flags: ["--missing"],
      }),
    ).toThrow(/missing --missing/);

    expect(() =>
      assertRegisteredCommandContract(createRegistrationRegistry(), {
        command: "missing command",
      }),
    ).toThrow(/Available commands: hello world/);

    const multiCommandRegistry = createRegistrationRegistry();
    multiCommandRegistry.commands.push({
      ...multiCommandRegistry.commands[0]!,
      command: "alpha command",
      action: "alpha-command",
    });
    expect(() =>
      assertRegisteredCommandContract(multiCommandRegistry, {
        command: "missing command",
      }),
    ).toThrow(/Available commands: alpha command, hello world/);

    expect(() =>
      assertRegisteredCommandContract({ ...createRegistrationRegistry(), commands: [], flags: [] }, {
        command: "missing command",
        extensionName: "missing-ext",
      }),
    ).toThrow(/from extension "missing-ext".*Available commands: \(none\)/);

    expect(() =>
      assertRegisteredCommandContract({ ...createRegistrationRegistry(), flags: [] }, {
        command: "hello world",
        flags: ["--missing"],
      }),
    ).toThrow(/available \(none\)/);
  });

  it("asserts a registered hook by kind and extension name", () => {
    const hooks = createHookRegistry();

    const before = assertRegisteredHook(hooks, { kind: "before_command" });
    expect(before.name).toBe("audit-ext");

    const scopedWrite = assertRegisteredHook(hooks, {
      kind: "on_write",
      extensionName: "second-write-ext",
    });
    expect(scopedWrite.name).toBe("second-write-ext");
    expect(typeof scopedWrite.run).toBe("function");
  });

  it("throws actionable errors for missing hook registrations", () => {
    const hooks = createHookRegistry();

    expect(() => assertRegisteredHook(hooks, { kind: "on_read" })).toThrow(
      /Expected a "on_read" hook to be registered\. Available "on_read" hooks: \(none\)/,
    );

    expect(() =>
      assertRegisteredHook(hooks, { kind: "on_write", extensionName: "missing-ext" }),
    ).toThrow(/from extension "missing-ext".*Available "on_write" hooks: first-write-ext, second-write-ext/);
  });

  it("asserts a registered search provider by name and extension", () => {
    const provider = assertRegisteredSearchProvider(createRegistrationRegistry(), {
      provider: " Semantic-Local ",
      extensionName: "search-ext",
    });
    expect(provider.definition.name).toBe("semantic-local");
  });

  it("throws actionable errors for missing search provider registrations", () => {
    expect(() =>
      assertRegisteredSearchProvider(createRegistrationRegistry(), { provider: "   " }),
    ).toThrow("non-empty string");

    expect(() =>
      assertRegisteredSearchProvider(createRegistrationRegistry(), { provider: "missing-provider" }),
    ).toThrow(/Available search providers: semantic-local/);

    expect(() =>
      assertRegisteredSearchProvider(createRegistrationRegistry(), {
        provider: "semantic-local",
        extensionName: "other-ext",
      }),
    ).toThrow(/from extension "other-ext".*Available search providers: semantic-local/);

    expect(() =>
      assertRegisteredSearchProvider({ ...createRegistrationRegistry(), search_providers: [] }, {
        provider: "semantic-local",
      }),
    ).toThrow(/Available search providers: \(none\)/);
  });

  it("asserts a registered vector store adapter by name and extension", () => {
    const adapter = assertRegisteredVectorStoreAdapter(createRegistrationRegistry(), {
      adapter: " Pinecone ",
      extensionName: "search-ext",
    });
    expect(adapter.definition.name).toBe("pinecone");
  });

  it("throws actionable errors for missing vector store adapter registrations", () => {
    expect(() =>
      assertRegisteredVectorStoreAdapter(createRegistrationRegistry(), { adapter: "   " }),
    ).toThrow("Expected vector store adapter name must be a non-empty string");

    expect(() =>
      assertRegisteredVectorStoreAdapter(createRegistrationRegistry(), { adapter: "missing-store" }),
    ).toThrow(/Available vector store adapters: pinecone/);

    expect(() =>
      assertRegisteredVectorStoreAdapter(createRegistrationRegistry(), {
        adapter: "pinecone",
        extensionName: "other-ext",
      }),
    ).toThrow(/from extension "other-ext".*Available vector store adapters: pinecone/);

    expect(() =>
      assertRegisteredVectorStoreAdapter({ ...createRegistrationRegistry(), vector_store_adapters: [] }, {
        adapter: "pinecone",
      }),
    ).toThrow(/Available vector store adapters: \(none\)/);
  });

  it("asserts a registered importer by format and extension", () => {
    const importer = assertRegisteredImporter(createRegistrationRegistry(), {
      importer: " Beads ",
      extensionName: "beads-ext",
    });
    expect(importer.importer).toBe("beads");
    expect(importer.layer).toBe("global");
  });

  it("throws actionable errors for missing importer registrations", () => {
    expect(() =>
      assertRegisteredImporter(createRegistrationRegistry(), { importer: "   " }),
    ).toThrow("non-empty string");

    expect(() =>
      assertRegisteredImporter(createRegistrationRegistry(), { importer: "missing-format" }),
    ).toThrow(/Available importers: beads, todos/);

    expect(() =>
      assertRegisteredImporter(createRegistrationRegistry(), {
        importer: "todos",
        extensionName: "other-ext",
      }),
    ).toThrow(/from extension "other-ext".*Available importers: beads, todos/);
  });

  it("asserts a registered exporter by format and extension", () => {
    const exporter = assertRegisteredExporter(createRegistrationRegistry(), {
      exporter: "todos",
    });
    expect(exporter.exporter).toBe("todos");
    expect(exporter.name).toBe("todos-ext");

    const scoped = assertRegisteredExporter(createRegistrationRegistry(), {
      exporter: "todos",
      extensionName: "todos-ext",
    });
    expect(scoped.name).toBe("todos-ext");
  });

  it("throws actionable errors for missing exporter registrations", () => {
    expect(() =>
      assertRegisteredExporter(createRegistrationRegistry(), { exporter: " " }),
    ).toThrow("non-empty string");

    expect(() =>
      assertRegisteredExporter(createRegistrationRegistry(), { exporter: "missing-format" }),
    ).toThrow(/Available exporters: todos/);

    expect(() =>
      assertRegisteredExporter(createRegistrationRegistry(), {
        exporter: "todos",
        extensionName: "other-ext",
      }),
    ).toThrow(/from extension "other-ext".*Available exporters: todos/);

    expect(() =>
      assertRegisteredExporter({ ...createRegistrationRegistry(), exporters: [] }, {
        exporter: "todos",
      }),
    ).toThrow(/Available exporters: \(none\)/);
  });

  it("asserts schema item field registrations with actionable failures", () => {
    const field = assertRegisteredItemField(createRegistrationRegistry(), {
      field: "Severity",
      extensionName: "schema-ext",
      type: "string",
    });
    expect(field.registration.name).toBe("schema-ext");
    expect(field.field).toEqual({ name: "severity", type: "string" });

    expect(() =>
      assertRegisteredItemField(createRegistrationRegistry(), {
        field: "severity",
        type: "boolean",
      }),
    ).toThrow(/Expected item field "severity".*Available item fields: impact:number, severity:string/);

    expect(() =>
      assertRegisteredItemField(createRegistrationRegistry(), {
        field: "severity",
        extensionName: "other-ext",
      }),
    ).toThrow(/from extension "other-ext".*Available item fields: impact:number, severity:string/);

    expect(() =>
      assertRegisteredItemField({ ...createRegistrationRegistry(), item_fields: [] }, { field: "severity" }),
    ).toThrow(/Available item fields: \(none\)/);

    expect(() => assertRegisteredItemField(createRegistrationRegistry(), { field: "   " })).toThrow(
      "Expected item field name must be a non-empty string",
    );
  });

  it("asserts schema item type registrations with actionable failures", () => {
    const itemType = assertRegisteredItemType(createRegistrationRegistry(), {
      itemType: "incident",
      extensionName: "schema-ext",
      folder: "incidents",
    });
    expect(itemType.registration.name).toBe("schema-ext");
    expect(itemType.itemType.required_create_fields).toEqual(["severity"]);

    expect(() =>
      assertRegisteredItemType(createRegistrationRegistry(), {
        itemType: "Incident",
        folder: "wrong-folder",
      }),
    ).toThrow(/Expected item type "incident".*Available item types: Incident:incidents/);

    expect(() =>
      assertRegisteredItemType(createRegistrationRegistry(), {
        itemType: "Incident",
        extensionName: "other-ext",
      }),
    ).toThrow(/from extension "other-ext".*Available item types: Incident:incidents/);

    expect(() => assertRegisteredItemType({ ...createRegistrationRegistry(), item_types: [] }, { itemType: "Incident" })).toThrow(
      /Available item types: \(none\)/,
    );

    expect(() => assertRegisteredItemType(createRegistrationRegistry(), { itemType: "   " })).toThrow(
      "Expected item type name must be a non-empty string",
    );
  });

  it("asserts importer, exporter, search provider, vector store adapter, and hook registrations from a real extension activation", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: pmPath,
        placement: "projectRoot",
        directory: "capability-ext",
        manifest: {
          name: "capability-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["importers", "search", "hooks", "schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerImporter('jsonl', async () => ({ items: [] }));",
          "  api.registerExporter('jsonl', async () => ({ content: '' }));",
          "  api.registerSearchProvider({ name: 'capability-search', query: async () => ({ hits: [] }) });",
          "  api.registerVectorStoreAdapter({ name: 'capability-vector', query: async () => [] });",
          "  api.registerItemFields([{ name: 'risk', type: 'string' }]);",
          "  api.registerItemTypes([{ name: 'Risk', folder: 'risks', aliases: ['risk'], required_create_fields: ['risk'] }]);",
          "  api.hooks.onWrite(() => undefined);",
          "}",
          "",
        ].join("\n"),
      });

      const settings = await readCoreSettings(pmPath);
      const loadResult = await loadExtensions({ pmRoot: pmPath, settings, cwd: pmPath });
      const activation = await activateExtensions(loadResult);

      const importer = assertRegisteredImporter(activation.registrations, {
        importer: "jsonl",
        extensionName: "capability-ext",
      });
      expect(importer.importer).toBe("jsonl");

      const exporter = assertRegisteredExporter(activation.registrations, { exporter: "jsonl" });
      expect(exporter.name).toBe("capability-ext");

      const provider = assertRegisteredSearchProvider(activation.registrations, {
        provider: "capability-search",
      });
      expect(provider.definition.name).toBe("capability-search");

      const adapter = assertRegisteredVectorStoreAdapter(activation.registrations, {
        adapter: "capability-vector",
        extensionName: "capability-ext",
      });
      expect(adapter.definition.name).toBe("capability-vector");

      const hook = assertRegisteredHook(activation.hooks, {
        kind: "on_write",
        extensionName: "capability-ext",
      });
      expect(typeof hook.run).toBe("function");

      const field = assertRegisteredItemField(activation.registrations, {
        field: "risk",
        extensionName: "capability-ext",
      });
      expect(field.field.type).toBe("string");

      const itemType = assertRegisteredItemType(activation.registrations, {
        itemType: "Risk",
        extensionName: "capability-ext",
      });
      expect(itemType.itemType.folder).toBe("risks");
    });
  });

  it("activates an in-memory extension module for package-author tests", async () => {
    const activation = await activateExtensionForTest({
      manifest: {
        name: "memory-ext",
        version: "1.0.0",
        entry: "./index.js",
        priority: 0,
        manifest_version: 2,
        pm_min_version: "2026.5.0",
        pm_max_version: "2027.0.0",
        capabilities: ["commands", "schema", "hooks"],
      },
      activate(api: ExtensionApi) {
        api.registerCommand({
          name: "memory hello",
          action: "memory-hello",
          description: "Exercise in-memory SDK activation.",
          flags: [{ long: "--name", value_type: "string" }],
          run: async () => ({ ok: true }),
        });
        api.registerItemFields([{ name: "severity", type: "string" }]);
        api.registerItemTypes([{ name: "Incident", folder: "incidents", required_create_fields: ["severity"] }]);
        api.hooks.afterCommand(() => undefined);
      },
    });

    const command = assertRegisteredCommandContract(activation.registrations, {
      command: "memory hello",
      action: "memory-hello",
      extensionName: "memory-ext",
      flags: ["--name"],
    });
    expect(command.command.description).toBe("Exercise in-memory SDK activation.");

    const hook = assertRegisteredHook(activation.hooks, {
      kind: "after_command",
      extensionName: "memory-ext",
    });
    expect(typeof hook.run).toBe("function");

    const field = assertRegisteredItemField(activation.registrations, {
      field: "severity",
      extensionName: "memory-ext",
      type: "string",
    });
    expect(field.field.name).toBe("severity");

    const itemType = assertRegisteredItemType(activation.registrations, {
      itemType: "Incident",
      extensionName: "memory-ext",
      folder: "incidents",
    });
    expect(itemType.itemType.required_create_fields).toEqual(["severity"]);
  });

  it("uses a default manifest for simple in-memory extension tests", async () => {
    const activation = await activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.registerCommand({
            name: "default hello",
            action: "default-hello",
            description: "Exercise default in-memory SDK activation.",
            run: async () => ({ ok: true }),
          });
        },
      },
      { capabilities: ["commands"] },
    );

    assertRegisteredCommandContract(activation.registrations, {
      command: "default hello",
      action: "default-hello",
      extensionName: "test-extension",
    });
  });

  it("reads manifests from default-exported in-memory extension modules", async () => {
    const activation = await activateExtensionForTest({
      default: {
        manifest: {
          name: "default-export-ext",
          version: "1.0.0",
          entry: "./index.js",
          capabilities: ["commands"],
        },
        activate(api: ExtensionApi) {
          api.registerCommand({
            name: "default export hello",
            action: "default-export-hello",
            description: "Exercise default export manifest activation.",
            run: async () => ({ ok: true }),
          });
        },
      },
    });

    assertRegisteredCommandContract(activation.registrations, {
      command: "default export hello",
      action: "default-export-hello",
      extensionName: "default-export-ext",
    });
  });

  it("reads direct metadata from default-exported in-memory extension modules", async () => {
    const activation = await activateExtensionForTest({
      default: {
        name: "direct-default-ext",
        version: "1.0.0",
        entry: "./index.js",
        capabilities: ["commands"],
        activate(api: ExtensionApi) {
          api.registerCommand({
            name: "direct default hello",
            action: "direct-default-hello",
            description: "Exercise default export direct metadata activation.",
            run: async () => ({ ok: true }),
          });
        },
      },
    });

    assertRegisteredCommandContract(activation.registrations, {
      command: "direct default hello",
      action: "direct-default-hello",
      extensionName: "direct-default-ext",
    });
  });

  it("uses default-exported capabilities metadata without an explicit name", async () => {
    const activation = await activateExtensionForTest({
      default: {
        capabilities: ["commands"],
        activate(api: ExtensionApi) {
          api.registerCommand({
            name: "capability default hello",
            action: "capability-default-hello",
            description: "Exercise default export capability-only metadata activation.",
            run: async () => ({ ok: true }),
          });
        },
      },
    });

    assertRegisteredCommandContract(activation.registrations, {
      command: "capability default hello",
      action: "capability-default-hello",
      extensionName: "test-extension",
    });
  });

  it("reads direct metadata from in-memory extension modules", async () => {
    const activation = await activateExtensionForTest({
      name: "direct-ext",
      version: "1.0.0",
      entry: "./index.js",
      capabilities: ["commands"],
      activate(api: ExtensionApi) {
        api.registerCommand({
          name: "direct hello",
          action: "direct-hello",
          description: "Exercise direct metadata activation.",
          run: async () => ({ ok: true }),
        });
      },
    });

    assertRegisteredCommandContract(activation.registrations, {
      command: "direct hello",
      action: "direct-hello",
      extensionName: "direct-ext",
    });
  });

  it("uses fallback metadata for primitive in-memory modules", async () => {
    const activation = await activateExtensionForTest("not-an-extension-module");

    expect(activation.failed).toHaveLength(0);
    expect(activation.registrations.commands).toHaveLength(0);
    expect(activation.warnings).toHaveLength(0);
  });

  it("ignores malformed manifest capabilities instead of throwing", async () => {
    const activation = await activateExtensionForTest({
      manifest: {
        name: "malformed-capabilities-ext",
        version: "1.0.0",
        entry: "./index.js",
        capabilities: "commands",
      },
      activate(api: ExtensionApi) {
        api.registerCommand({
          name: "malformed hello",
          action: "malformed-hello",
          description: "Exercise malformed manifest capability handling.",
          run: async () => ({ ok: true }),
        });
      },
    });

    expect(activation.failed).toHaveLength(1);
    expect(activation.failed[0]?.trace?.missing_capability).toBe("commands");
  });

  it("keeps capability guardrails active for in-memory extension tests", async () => {
    const activation = await activateExtensionForTest({
      manifest: {
        name: "missing-capability-ext",
        version: "1.0.0",
        entry: "./index.js",
        priority: 0,
        capabilities: ["commands"],
      },
      activate(api: ExtensionApi) {
        api.registerItemFields([{ name: "severity", type: "string" }]);
      },
    });

    expect(activation.failed).toHaveLength(1);
    expect(activation.warnings).toContain("extension_activate_failed:project:missing-capability-ext");
    expect(activation.failed[0]?.trace?.missing_capability).toBe("schema");
  });

  const activateOverrideExtensionForTest = async (name: string): Promise<ExtensionActivationResult> =>
    activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.registerCommand("override run", () => ({ ok: true }));
          api.registerParser("override run", () => ({}));
          api.registerPreflight(() => ({}));
          api.registerRenderer("toon", () => null);
        },
      },
      { name, capabilities: ["commands", "parser", "preflight", "renderers"] },
    );

  it("asserts a registered command override by command and extension", async () => {
    const activation = await activateOverrideExtensionForTest("override-ext");

    const override = assertRegisteredCommandOverride(activation.commands, { command: " Override  Run " });
    expect(override.command).toBe("override run");
    expect(typeof override.run).toBe("function");

    const scoped = assertRegisteredCommandOverride(activation.commands, {
      command: "override run",
      extensionName: "override-ext",
    });
    expect(scoped.name).toBe("override-ext");
  });

  it("throws actionable errors for missing command override registrations", async () => {
    const activation = await activateOverrideExtensionForTest("override-ext");

    expect(() => assertRegisteredCommandOverride(activation.commands, { command: "   " })).toThrow(
      /must be a non-empty string/,
    );
    expect(() => assertRegisteredCommandOverride(activation.commands, { command: "missing command" })).toThrow(
      /Available command overrides: override run/,
    );
    expect(() =>
      assertRegisteredCommandOverride(activation.commands, {
        command: "override run",
        extensionName: "other-ext",
      }),
    ).toThrow(/from extension "other-ext".*Available command overrides: override run/);
  });

  it("asserts a registered parser override by command and extension", async () => {
    const activation = await activateOverrideExtensionForTest("override-ext");

    const override = assertRegisteredParserOverride(activation.parsers, { command: " Override  Run " });
    expect(override.command).toBe("override run");
    expect(typeof override.run).toBe("function");

    const scoped = assertRegisteredParserOverride(activation.parsers, {
      command: "override run",
      extensionName: "override-ext",
    });
    expect(scoped.name).toBe("override-ext");
  });

  it("throws actionable errors for missing parser override registrations", async () => {
    const activation = await activateOverrideExtensionForTest("override-ext");

    expect(() => assertRegisteredParserOverride(activation.parsers, { command: "   " })).toThrow(
      /must be a non-empty string/,
    );
    expect(() => assertRegisteredParserOverride(activation.parsers, { command: "missing command" })).toThrow(
      /Available parser overrides: override run/,
    );
    expect(() =>
      assertRegisteredParserOverride(activation.parsers, {
        command: "override run",
        extensionName: "other-ext",
      }),
    ).toThrow(/from extension "other-ext".*Available parser overrides: override run/);
  });

  it("asserts a registered preflight override globally and by extension", async () => {
    const activation = await activateOverrideExtensionForTest("override-ext");

    const override = assertRegisteredPreflightOverride(activation.preflight);
    expect(typeof override.run).toBe("function");
    expect(override.name).toBe("override-ext");

    const scoped = assertRegisteredPreflightOverride(activation.preflight, { extensionName: "override-ext" });
    expect(scoped.name).toBe("override-ext");
  });

  it("throws actionable errors for missing preflight override registrations", async () => {
    const activation = await activateOverrideExtensionForTest("override-ext");

    expect(() =>
      assertRegisteredPreflightOverride(activation.preflight, { extensionName: "other-ext" }),
    ).toThrow(/from extension "other-ext".*Available preflight overrides: override-ext/);
    expect(() => assertRegisteredPreflightOverride({ overrides: [] })).toThrow(
      /Available preflight overrides: \(none\)/,
    );
  });

  it("asserts a registered renderer override by format and extension", async () => {
    const activation = await activateOverrideExtensionForTest("override-ext");

    const override = assertRegisteredRendererOverride(activation.renderers, { format: "toon" });
    expect(override.format).toBe("toon");
    expect(typeof override.run).toBe("function");

    const scoped = assertRegisteredRendererOverride(activation.renderers, {
      format: "toon",
      extensionName: "override-ext",
    });
    expect(scoped.name).toBe("override-ext");
  });

  it("throws actionable errors for missing renderer override registrations", async () => {
    const activation = await activateOverrideExtensionForTest("override-ext");

    expect(() =>
      assertRegisteredRendererOverride(activation.renderers, { format: "  " as OutputRendererFormat }),
    ).toThrow(/must be a non-empty string/);
    expect(() => assertRegisteredRendererOverride(activation.renderers, { format: "json" })).toThrow(
      /Available renderer overrides: toon/,
    );
    expect(() =>
      assertRegisteredRendererOverride(activation.renderers, {
        format: "toon",
        extensionName: "other-ext",
      }),
    ).toThrow(/from extension "other-ext".*Available renderer overrides: toon/);
  });

  const activateServiceMigrationExtensionForTest = async (name: string): Promise<ExtensionActivationResult> =>
    activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.registerService("output_format", () => null);
          api.registerService("error_format", () => null);
          api.registerMigration({ id: "backfill-severity", description: "Backfill severity", mandatory: true });
          api.registerMigration({ id: "rename-impact", description: "Rename impact" });
        },
      },
      { name, capabilities: ["services", "schema"] },
    );

  it("asserts a registered service override by service name and extension", async () => {
    const activation = await activateServiceMigrationExtensionForTest("service-ext");

    const override = assertRegisteredServiceOverride(activation.services, { service: " Output_Format " });
    expect(override.service).toBe("output_format");
    expect(typeof override.run).toBe("function");

    const scoped = assertRegisteredServiceOverride(activation.services, {
      service: "error_format",
      extensionName: "service-ext",
    });
    expect(scoped.name).toBe("service-ext");
  });

  it("throws actionable errors for missing service override registrations", async () => {
    const activation = await activateServiceMigrationExtensionForTest("service-ext");

    expect(() =>
      assertRegisteredServiceOverride(activation.services, { service: "   " as ExtensionServiceName }),
    ).toThrow("Expected service name must be a non-empty string");
    expect(() => assertRegisteredServiceOverride(activation.services, { service: "help_format" })).toThrow(
      /Available service overrides: error_format, output_format/,
    );
    expect(() =>
      assertRegisteredServiceOverride(activation.services, {
        service: "output_format",
        extensionName: "other-ext",
      }),
    ).toThrow(/from extension "other-ext".*Available service overrides: error_format, output_format/);
  });

  it("asserts a registered migration by id, extension, and mandatory flag", async () => {
    const activation = await activateServiceMigrationExtensionForTest("migration-ext");

    const migration = assertRegisteredMigration(activation.registrations, { migration: " Backfill-Severity " });
    expect(migration.definition.id).toBe("backfill-severity");
    expect(migration.definition.mandatory).toBe(true);

    const scoped = assertRegisteredMigration(activation.registrations, {
      migration: "rename-impact",
      extensionName: "migration-ext",
      mandatory: false,
    });
    expect(scoped.layer).toBe("project");

    const mandatory = assertRegisteredMigration(activation.registrations, {
      migration: "backfill-severity",
      mandatory: true,
    });
    expect(mandatory.definition.id).toBe("backfill-severity");
  });

  it("throws actionable errors for missing migration registrations", async () => {
    const registryWithUnnamedMigration: ExtensionRegistrationRegistry = {
      ...createRegistrationRegistry(),
      migrations: [
        {
          layer: "project",
          name: "schema-ext",
          definition: { id: "Add-Severity", mandatory: true },
          runtime_definition: { id: "Add-Severity", mandatory: true },
        },
        {
          layer: "project",
          name: "schema-ext",
          definition: { id: "rename-impact" },
          runtime_definition: { id: "rename-impact" },
        },
        {
          layer: "global",
          name: "other-ext",
          definition: { description: "no id" },
          runtime_definition: { description: "no id" },
        },
      ],
    };

    expect(() => assertRegisteredMigration(registryWithUnnamedMigration, { migration: "   " })).toThrow(
      "Expected migration id must be a non-empty string",
    );
    expect(() => assertRegisteredMigration(registryWithUnnamedMigration, { migration: "ghost" })).toThrow(
      /Available migrations: \(unnamed\):false, Add-Severity:true/,
    );
    // Id matches but the mandatory flag does not: report the mismatch directly
    // rather than the misleading "to be registered" listing.
    expect(() =>
      assertRegisteredMigration(registryWithUnnamedMigration, { migration: "add-severity", mandatory: false }),
    ).toThrow('Expected migration "add-severity" to have mandatory=false, but it is mandatory=true.');
    // An unset mandatory flag is reported as mandatory=false in the mismatch message.
    expect(() =>
      assertRegisteredMigration(registryWithUnnamedMigration, { migration: "rename-impact", mandatory: true }),
    ).toThrow('Expected migration "rename-impact" to have mandatory=true, but it is mandatory=false.');
    expect(() =>
      assertRegisteredMigration(registryWithUnnamedMigration, {
        migration: "add-severity",
        extensionName: "schema-ext",
        mandatory: false,
      }),
    ).toThrow('from extension "schema-ext" to have mandatory=false, but it is mandatory=true.');
    expect(() =>
      assertRegisteredMigration(registryWithUnnamedMigration, {
        migration: "add-severity",
        extensionName: "ghost-ext",
      }),
    ).toThrow(/from extension "ghost-ext".*Available migrations:/);
  });

  it("fires registered lifecycle hooks and returns the runner warnings", async () => {
    const calls: string[] = [];
    const activation = await activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.hooks.beforeCommand((context) => {
            calls.push(`before:${context.command}`);
          });
          api.hooks.afterCommand((context) => {
            calls.push(`after:${context.ok}`);
          });
          api.hooks.onRead((context) => {
            calls.push(`read:${context.path}`);
          });
          api.hooks.onWrite((context) => {
            calls.push(`write:${context.op}`);
          });
          api.hooks.onWrite(() => {
            throw new Error("write hook exploded");
          });
          api.hooks.onIndex((context) => {
            calls.push(`index:${context.mode}`);
          });
        },
      },
      { name: "hook-ext", capabilities: ["hooks"] },
    );

    // Each clean lifecycle kind returns an empty warnings array and runs its hook.
    expect(
      await runRegisteredHookForTest(activation.hooks, {
        kind: "before_command",
        context: { command: "build", args: ["x"], pm_root: "" },
      }),
    ).toEqual([]);
    expect(
      await runRegisteredHookForTest(activation.hooks, {
        kind: "after_command",
        context: { command: "build", args: [], pm_root: "", ok: true },
      }),
    ).toEqual([]);
    expect(
      await runRegisteredHookForTest(activation.hooks, {
        kind: "on_read",
        context: { path: "/tmp/item.toon", scope: "project" },
      }),
    ).toEqual([]);
    expect(
      await runRegisteredHookForTest(activation.hooks, {
        kind: "on_index",
        context: { mode: "full", total_items: 3 },
      }),
    ).toEqual([]);

    // The on_write kind has a recording hook plus one that throws; the runner
    // isolates the failure into a single warning while the others still run.
    expect(
      await runRegisteredHookForTest(activation.hooks, {
        kind: "on_write",
        context: { path: "/tmp/item.toon", scope: "project", op: "update" },
      }),
    ).toEqual(["extension_hook_failed:project:hook-ext:onWrite"]);

    expect(calls).toEqual(["before:build", "after:true", "read:/tmp/item.toon", "index:full", "write:update"]);
  });

  it("throws actionable errors when no hook of the requested kind is registered", async () => {
    const activation = await activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.hooks.beforeCommand(() => undefined);
        },
      },
      { name: "before-only-ext", capabilities: ["hooks"] },
    );

    // A kind with no registrations lists the kinds that do have them.
    await expect(
      runRegisteredHookForTest(activation.hooks, {
        kind: "on_read",
        context: { path: "/tmp/x", scope: "project" },
      }),
    ).rejects.toThrow(/Expected a registered "on_read" hook to invoke\. Hook kinds with registrations: before_command/);

    // An entirely empty hook registry reports "(none)".
    await expect(
      runRegisteredHookForTest(
        { beforeCommand: [], afterCommand: [], onWrite: [], onRead: [], onIndex: [] },
        { kind: "before_command", context: { command: "x", args: [], pm_root: "" } },
      ),
    ).rejects.toThrow(/Hook kinds with registrations: \(none\)/);
  });

  const activateInvokeOverrideExtension = async (): Promise<ExtensionActivationResult> =>
    activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.registerCommand("transform run", (context) => ({ doubled: context.result }));
          api.registerParser("transform run", (context) => ({ args: [...context.args, "injected"] }));
          api.registerPreflight((context) => ({
            enforce_item_format_gate: !context.decision.enforce_item_format_gate,
          }));
          api.registerRenderer("toon", (context) => `rendered:${JSON.stringify(context.result)}`);
          api.registerService("output_format", (context) => ({ formatted: context.payload }));
        },
      },
      {
        name: "invoke-override-ext",
        capabilities: ["commands", "parser", "preflight", "renderers", "services"],
      },
    );

  it("invokes a registered parser override and returns the rewritten context", async () => {
    const activation = await activateInvokeOverrideExtension();

    // The command name is normalized (casing + whitespace) before matching.
    const result = await runRegisteredParserOverrideForTest(activation.parsers, {
      command: "  Transform  Run ",
      args: ["a"],
      options: {},
      global: { json: true },
      pm_root: "",
    });
    expect(result.overridden).toBe(true);
    expect(result.context.args).toEqual(["a", "injected"]);

    await expect(
      runRegisteredParserOverrideForTest(activation.parsers, {
        command: "missing run",
        args: [],
        options: {},
        global: {},
        pm_root: "",
      }),
    ).rejects.toThrow(
      /Expected a registered parser override for command "missing run" to invoke\. Available parser override commands: transform run/,
    );
  });

  it("invokes the active preflight override and returns its decision", async () => {
    const activation = await activateInvokeOverrideExtension();
    const baseDecision = {
      enforce_item_format_gate: false,
      run_preflight_item_format_sync: false,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    };

    const result = await runRegisteredPreflightOverrideForTest(activation.preflight, {
      command: "anything",
      args: [],
      options: {},
      global: {},
      pm_root: "",
      decision: baseDecision,
    });
    expect(result.overridden).toBe(true);
    expect(result.decision.enforce_item_format_gate).toBe(true);

    await expect(
      runRegisteredPreflightOverrideForTest(
        { overrides: [] },
        { command: "anything", args: [], options: {}, global: {}, pm_root: "", decision: baseDecision },
      ),
    ).rejects.toThrow("Expected a registered preflight override to invoke, but none are registered.");
  });

  it("invokes a registered command override and returns the transformed result", async () => {
    const activation = await activateInvokeOverrideExtension();

    const result = await runRegisteredCommandOverrideForTest(activation.commands, {
      command: "transform run",
      args: [],
      options: {},
      global: {},
      pm_root: "",
      result: 21,
    });
    expect(result.overridden).toBe(true);
    expect(result.result).toEqual({ doubled: 21 });

    await expect(
      runRegisteredCommandOverrideForTest(activation.commands, {
        command: "missing run",
        args: [],
        options: {},
        global: {},
        pm_root: "",
        result: null,
      }),
    ).rejects.toThrow(
      /Expected a registered command override for command "missing run" to invoke\. Available command override commands: transform run/,
    );
  });

  it("invokes a registered renderer override and returns the rendered string", async () => {
    const activation = await activateInvokeOverrideExtension();

    const result = await runRegisteredRendererOverrideForTest(activation.renderers, {
      format: "toon",
      result: { a: 1 },
    });
    expect(result.overridden).toBe(true);
    expect(result.rendered).toBe('rendered:{"a":1}');

    await expect(
      runRegisteredRendererOverrideForTest(activation.renderers, { format: "json", result: null }),
    ).rejects.toThrow(
      /Expected a registered renderer override for format "json" to invoke\. Available renderer override formats: toon/,
    );
  });

  it("invokes a registered service override and returns its handled result", async () => {
    const activation = await activateInvokeOverrideExtension();

    const result = await runRegisteredServiceOverrideForTest(activation.services, {
      service: "output_format",
      payload: { hi: true },
    });
    expect(result.handled).toBe(true);
    expect(result.result).toEqual({ formatted: { hi: true } });

    await expect(
      runRegisteredServiceOverrideForTest(activation.services, { service: "error_format", payload: null }),
    ).rejects.toThrow(
      /Expected a registered service override for service "error_format" to invoke\. Available service override services: output_format/,
    );
  });

  // In-memory extension that registers the three executable registration
  // surfaces (search providers, vector store adapters, migrations) so the
  // invoke-verb helpers can exercise their live runtime functions. The
  // `query-only-*` registrations omit operations on purpose to drive the
  // "operation not implemented" guard, and the `norun`/`nostatus` migrations
  // cover the run-absent and default-status paths.
  const activateInvokeRegistrationExtension = async (): Promise<ExtensionActivationResult> =>
    activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.registerSearchProvider({
            name: "memory-search",
            query: async (context) => ({ hits: [{ id: context.query, score: context.tokens.length }] }),
            embed: async (context) => [context.input.length],
            // camelCase spelling exercises the first alias key for embedBatch.
            embedBatch: async (context) => context.inputs.map((input) => [input.length]),
            // snake_case spelling exercises the second alias key for queryExpansion.
            query_expansion: async (context) => [`${context.query}+more`],
            rerank: async (context) => context.candidates.map((candidate, index) => ({ id: candidate.id, score: index })),
          });
          api.registerSearchProvider({ name: "query-only-search", query: async () => ({ hits: [] }) });
          api.registerVectorStoreAdapter({
            name: "memory-vector",
            query: async (context) => [{ id: "v1", score: context.limit }],
            upsert: async (context) => ({ upserted: context.points.length }),
            delete: async (context) => ({ deleted: context.ids.length }),
          });
          api.registerVectorStoreAdapter({ name: "query-only-vector", query: async () => [] });
          api.registerMigration({
            id: "memory-migration",
            description: "In-memory migration",
            status: "Pending",
            run: async (context) => ({ ranAt: context.pm_root, status: context.status, id: context.id }),
          });
          api.registerMigration({
            id: "nostatus-migration",
            description: "Migration without a declared status",
            run: async (context) => ({ ranAt: context.pm_root, status: context.status, id: context.id }),
          });
          api.registerMigration({ id: "norun-migration", description: "Marker migration without a run function" });
        },
      },
      {
        name: "invoke-registration-ext",
        capabilities: ["search", "schema"],
      },
    );

  it("invokes every operation of a registered search provider", async () => {
    const activation = await activateInvokeRegistrationExtension();

    expect(
      await runRegisteredSearchProviderForTest(activation.registrations, {
        provider: "memory-search",
        operation: "query",
        context: { query: "calendar", mode: "semantic", tokens: ["calendar"], options: {}, settings: {}, documents: [] },
      }),
    ).toEqual({ hits: [{ id: "calendar", score: 1 }] });

    // The provider name is resolved case-insensitively, mirroring the host.
    expect(
      await runRegisteredSearchProviderForTest(activation.registrations, {
        provider: "MEMORY-SEARCH",
        operation: "embed",
        context: { input: "abc", settings: {}, model: "test-model" },
      }),
    ).toEqual([3]);

    expect(
      await runRegisteredSearchProviderForTest(activation.registrations, {
        provider: "memory-search",
        operation: "embedBatch",
        context: { inputs: ["a", "bb"], settings: {}, model: "test-model" },
      }),
    ).toEqual([[1], [2]]);

    expect(
      await runRegisteredSearchProviderForTest(activation.registrations, {
        provider: "memory-search",
        operation: "queryExpansion",
        context: { query: "todo", mode: "semantic", settings: {} },
      }),
    ).toEqual(["todo+more"]);

    expect(
      await runRegisteredSearchProviderForTest(activation.registrations, {
        provider: "memory-search",
        operation: "rerank",
        context: {
          query: "todo",
          mode: "hybrid",
          model: "rerank-model",
          top_k: 2,
          settings: {},
          candidates: [
            { id: "a", text: "alpha", score: 0.1 },
            { id: "b", text: "beta", score: 0.2 },
          ],
        },
      }),
    ).toEqual([
      { id: "a", score: 0 },
      { id: "b", score: 1 },
    ]);
  });

  it("resolves a search provider operation declared with only its snake_case alias", async () => {
    // A provider that spells embedBatch only as `embed_batch` must still resolve,
    // mirroring the host's camelCase/snake_case acceptance.
    const activation = await activateExtensionForTest(
      {
        activate(api: ExtensionApi) {
          api.registerSearchProvider({
            name: "snake-embed-search",
            embed_batch: async (context) => context.inputs.map((input) => [input.length, 0]),
          });
        },
      },
      { name: "snake-embed-ext", capabilities: ["search"] },
    );

    expect(
      await runRegisteredSearchProviderForTest(activation.registrations, {
        provider: "snake-embed-search",
        operation: "embedBatch",
        context: { inputs: ["ab", "c"], settings: {}, model: "snake-model" },
      }),
    ).toEqual([
      [2, 0],
      [1, 0],
    ]);
  });

  it("throws a descriptive error invoking an unregistered or under-implemented search provider", async () => {
    const activation = await activateInvokeRegistrationExtension();

    await expect(
      runRegisteredSearchProviderForTest(activation.registrations, {
        provider: "ghost-search",
        operation: "query",
        context: { query: "x", mode: "semantic", tokens: [], options: {}, settings: {}, documents: [] },
      }),
    ).rejects.toThrow(
      /Expected a registered search provider "ghost-search" to invoke\. Available search providers: memory-search, query-only-search/,
    );

    await expect(
      runRegisteredSearchProviderForTest(activation.registrations, {
        provider: "query-only-search",
        operation: "rerank",
        context: { query: "x", mode: "hybrid", model: "m", top_k: 1, settings: {}, candidates: [] },
      }),
    ).rejects.toThrow(/Registered search provider "query-only-search" does not implement the "rerank" operation/);
  });

  it("invokes every operation of a registered vector store adapter", async () => {
    const activation = await activateInvokeRegistrationExtension();

    expect(
      await runRegisteredVectorStoreAdapterForTest(activation.registrations, {
        adapter: "memory-vector",
        operation: "query",
        context: { vector: [0.1, 0.2], limit: 5, settings: {} },
      }),
    ).toEqual([{ id: "v1", score: 5 }]);

    expect(
      await runRegisteredVectorStoreAdapterForTest(activation.registrations, {
        adapter: "MEMORY-VECTOR",
        operation: "upsert",
        context: { points: [{ id: "p1", vector: [0.1] }], settings: {} },
      }),
    ).toEqual({ upserted: 1 });

    expect(
      await runRegisteredVectorStoreAdapterForTest(activation.registrations, {
        adapter: "memory-vector",
        operation: "delete",
        context: { ids: ["p1", "p2"], settings: {} },
      }),
    ).toEqual({ deleted: 2 });
  });

  it("throws a descriptive error invoking an unregistered or under-implemented vector store adapter", async () => {
    const activation = await activateInvokeRegistrationExtension();

    await expect(
      runRegisteredVectorStoreAdapterForTest(activation.registrations, {
        adapter: "ghost-vector",
        operation: "query",
        context: { vector: [0.1], limit: 1, settings: {} },
      }),
    ).rejects.toThrow(
      /Expected a registered vector store adapter "ghost-vector" to invoke\. Available vector store adapters: memory-vector, query-only-vector/,
    );

    await expect(
      runRegisteredVectorStoreAdapterForTest(activation.registrations, {
        adapter: "query-only-vector",
        operation: "upsert",
        context: { points: [], settings: {} },
      }),
    ).rejects.toThrow(/Registered vector store adapter "query-only-vector" does not implement the "upsert" operation/);
  });

  it("invokes a registered migration run function with a host-shaped context", async () => {
    const activation = await activateInvokeRegistrationExtension();

    // Declared status is normalized (trimmed + lower-cased) and pmRoot flows through.
    expect(
      await runRegisteredMigrationForTest(activation.registrations, {
        migration: "memory-migration",
        pmRoot: "/tmp/pm-workspace",
      }),
    ).toEqual({ ranAt: "/tmp/pm-workspace", status: "pending", id: "memory-migration" });

    // No declared status defaults to "pending"; omitted pmRoot defaults to "".
    expect(
      await runRegisteredMigrationForTest(activation.registrations, { migration: "nostatus-migration" }),
    ).toEqual({ ranAt: "", status: "pending", id: "nostatus-migration" });
  });

  it("throws a descriptive error invoking an unregistered or runless migration", async () => {
    const activation = await activateInvokeRegistrationExtension();

    await expect(
      runRegisteredMigrationForTest(activation.registrations, { migration: "ghost-migration" }),
    ).rejects.toThrow(/Expected migration "ghost-migration" to be registered\. Available migrations:/);

    await expect(
      runRegisteredMigrationForTest(activation.registrations, { migration: "norun-migration" }),
    ).rejects.toThrow(/Registered migration "norun-migration" does not implement a run function to invoke/);
  });

  it("disambiguates a migration by extensionName when invoking", async () => {
    const activation = await activateInvokeRegistrationExtension();

    // A matching extensionName resolves and runs the migration.
    expect(
      await runRegisteredMigrationForTest(activation.registrations, {
        migration: "memory-migration",
        extensionName: "invoke-registration-ext",
        pmRoot: "/tmp/scoped",
      }),
    ).toEqual({ ranAt: "/tmp/scoped", status: "pending", id: "memory-migration" });

    // A non-matching extensionName filters the migration out, surfacing the
    // descriptive "not registered" error scoped to that extension.
    await expect(
      runRegisteredMigrationForTest(activation.registrations, {
        migration: "memory-migration",
        extensionName: "other-ext",
      }),
    ).rejects.toThrow(/Expected migration "memory-migration" from extension "other-ext" to be registered/);
  });
});

describe("createExtensionTestHarness", () => {
  const harnessCapabilities: ExtensionCapability[] = [
    "commands",
    "parser",
    "preflight",
    "renderers",
    "services",
    "hooks",
    "schema",
    "search",
    "importers",
  ];

  // One in-memory extension that registers a representative of every surface the
  // harness binds, so a single activation exercises all convenience methods. The
  // `events` array records lifecycle-hook and teardown side effects so tests can
  // prove a bound method ran the real registered function, not a stub.
  const createHarnessFixtureModule = (events: string[]) => ({
    manifest: {
      name: "harness-ext",
      version: "1.0.0",
      entry: "./index.js",
      capabilities: harnessCapabilities,
    },
    activate(api: ExtensionApi) {
      api.registerCommand({
        name: "harness hello",
        action: "harness-hello",
        description: "Harness handler command.",
        flags: [{ long: "--name", value_type: "string" }],
        run: async (context) => ({ ok: true, name: context.options.name ?? null }),
      });
      api.registerItemFields([{ name: "risk", type: "string" }]);
      api.registerItemTypes([{ name: "Risk", folder: "risks", required_create_fields: ["risk"] }]);
      api.hooks.afterCommand((context) => {
        events.push(`after:${context.ok}`);
      });
      api.registerCommand("transform run", (context) => ({ doubled: context.result }));
      api.registerParser("transform run", (context) => ({ args: [...context.args, "injected"] }));
      api.registerPreflight((context) => ({
        enforce_item_format_gate: !context.decision.enforce_item_format_gate,
      }));
      api.registerRenderer("toon", (context) => `rendered:${JSON.stringify(context.result)}`);
      api.registerService("output_format", (context) => ({ formatted: context.payload }));
      api.registerSearchProvider({
        name: "memory-search",
        query: async (context) => ({ hits: [{ id: context.query, score: context.tokens.length }] }),
        embed: async (context) => [context.input.length],
      });
      api.registerVectorStoreAdapter({
        name: "memory-vector",
        query: async (context) => [{ id: "v1", score: context.limit }],
      });
      api.registerMigration({
        id: "memory-migration",
        description: "In-memory migration",
        status: "Pending",
        run: async (context) => ({ ranAt: context.pm_root, status: context.status, id: context.id }),
      });
      api.registerImporter("csv", (context) => ({ registration: context.registration, action: context.action }));
      api.registerExporter("csv", (context) => ({ registration: context.registration, action: context.action }));
    },
    deactivate() {
      events.push("deactivated");
    },
  });

  it("binds every assertion helper to the correct activation sub-registry", async () => {
    const harness = await createExtensionTestHarness(createHarnessFixtureModule([]));

    // The fixture supplies a manifest name and no layer override, so the harness
    // resolves the same name/layer activateExtensionForTest would and exposes the
    // raw activation as an escape hatch.
    expect(harness.name).toBe("harness-ext");
    expect(harness.layer).toBe("project");
    expect(harness.activation.registrations.commands).toHaveLength(1);
    expect(harness.activationSummary().commands).toEqual(["harness hello"]);
    expect(harness.activationSummary({ extensionName: "missing-ext" }).commands).toEqual([]);
    expect(
      harness.renderMarkdown({ title: "Harness Extension", headingLevel: 3, extensionName: "harness-ext" }),
    ).toBe(
      renderExtensionSurfaceMarkdown(harness.activationSummary({ extensionName: "harness-ext" }), {
        title: "Harness Extension",
        headingLevel: 3,
      }),
    );
    expect(harness.renderMarkdown({ title: "Harness Extension", headingLevel: 3 })).toContain(
      "### Harness Extension",
    );
    expect(harness.renderMarkdown()).toContain("- `harness hello`");
    expect(harness.renderMarkdown(null as unknown as RenderExtensionHarnessMarkdownOptions)).toContain(
      "- `harness hello`",
    );

    expect(harness.assertCommandContract({ command: "harness hello", action: "harness-hello", flags: ["--name"] }).command.action).toBe(
      "harness-hello",
    );
    expect(harness.assertFlags({ targetCommand: "harness hello", flags: ["--name"] }).target_command).toBe("harness hello");
    expect(harness.assertItemField({ field: "risk", type: "string" }).field.name).toBe("risk");
    expect(harness.assertItemType({ itemType: "Risk", folder: "risks" }).itemType.folder).toBe("risks");
    expect(typeof harness.assertHook({ kind: "after_command" }).run).toBe("function");
    expect(harness.assertCommandOverride({ command: "transform run" }).command).toBe("transform run");
    expect(harness.assertParserOverride({ command: "transform run" }).command).toBe("transform run");
    expect(harness.assertPreflightOverride().name).toBe("harness-ext");
    expect(harness.assertRendererOverride({ format: "toon" }).format).toBe("toon");
    expect(harness.assertServiceOverride({ service: "output_format" }).service).toBe("output_format");
    expect(harness.assertSearchProvider({ provider: "memory-search" }).definition.name).toBe("memory-search");
    expect(harness.assertVectorStoreAdapter({ adapter: "memory-vector" }).definition.name).toBe("memory-vector");
    expect(harness.assertImporter({ importer: "csv" }).importer).toBe("csv");
    expect(harness.assertExporter({ exporter: "csv" }).exporter).toBe("csv");
    expect(harness.assertMigration({ migration: "memory-migration" }).definition.id).toBe("memory-migration");

    const usage = harness.assertCapabilityUsage({ declared: ["commands"] });
    expect(usage.declared).toEqual(["commands"]);
    expect(usage.unused).toEqual([]);
  });

  it("binds every invoke helper through pm's real dispatch engine", async () => {
    const events: string[] = [];
    const harness = await createExtensionTestHarness(createHarnessFixtureModule(events));

    expect(await harness.runCommand({ command: "harness hello", options: { name: "abc" } })).toEqual({
      handled: true,
      result: { ok: true, name: "abc" },
      warnings: [],
    });

    expect(
      await harness.runHook({ kind: "after_command", context: { command: "x", args: [], pm_root: "", ok: true } }),
    ).toEqual([]);
    expect(events).toContain("after:true");

    const commandOverride = await harness.runCommandOverride({
      command: "transform run",
      args: [],
      options: {},
      global: {},
      pm_root: "",
      result: 21,
    });
    expect(commandOverride.overridden).toBe(true);
    expect(commandOverride.result).toEqual({ doubled: 21 });

    const parserOverride = await harness.runParserOverride({
      command: "transform run",
      args: ["a"],
      options: {},
      global: {},
      pm_root: "",
    });
    expect(parserOverride.overridden).toBe(true);
    expect(parserOverride.context.args).toEqual(["a", "injected"]);

    const preflightOverride = await harness.runPreflightOverride({
      command: "anything",
      args: [],
      options: {},
      global: {},
      pm_root: "",
      decision: {
        enforce_item_format_gate: false,
        run_preflight_item_format_sync: false,
        run_extension_migrations: false,
        enforce_mandatory_migration_gate: false,
      },
    });
    expect(preflightOverride.overridden).toBe(true);
    expect(preflightOverride.decision.enforce_item_format_gate).toBe(true);

    const rendererOverride = await harness.runRendererOverride({ format: "toon", result: { a: 1 } });
    expect(rendererOverride.rendered).toBe('rendered:{"a":1}');

    const serviceOverride = await harness.runServiceOverride({ service: "output_format", payload: { hi: true } });
    expect(serviceOverride.handled).toBe(true);
    expect(serviceOverride.result).toEqual({ formatted: { hi: true } });

    expect(
      await harness.runSearchProvider({
        provider: "memory-search",
        operation: "query",
        context: { query: "calendar", mode: "semantic", tokens: ["calendar"], options: {}, settings: {}, documents: [] },
      }),
    ).toEqual({ hits: [{ id: "calendar", score: 1 }] });
    expect(
      await harness.runSearchProvider({
        provider: "memory-search",
        operation: "embed",
        context: { input: "abc", settings: {}, model: "test-model" },
      }),
    ).toEqual([3]);

    expect(
      await harness.runVectorStoreAdapter({
        adapter: "memory-vector",
        operation: "query",
        context: { vector: [0.1, 0.2], limit: 5, settings: {} },
      }),
    ).toEqual([{ id: "v1", score: 5 }]);

    expect(await harness.runMigration({ migration: "memory-migration", pmRoot: "/tmp/pm" })).toEqual({
      ranAt: "/tmp/pm",
      status: "pending",
      id: "memory-migration",
    });

    const importResult = await harness.runImporter({ importer: "csv", args: ["source.csv"] });
    expect(importResult.handled).toBe(true);
    expect((importResult.result as { action: string }).action).toBe("import");

    const exportResult = await harness.runExporter({ exporter: "csv", options: { limit: 5 } });
    expect(exportResult.handled).toBe(true);
    expect((exportResult.result as { action: string }).action).toBe("export");
  });

  it("deactivates through the harness, forwarding the resolved skip-key and optional timeout", async () => {
    const events: string[] = [];
    const harness = await createExtensionTestHarness(createHarnessFixtureModule(events));

    // Default deactivate forwards an undefined timeout and the resolved name/layer
    // so the real teardown engine runs the module's deactivate exactly once.
    const cleanResult = await harness.deactivate();
    expect(assertExtensionDeactivated(cleanResult)).toBe(cleanResult);
    expect(events).toEqual(["deactivated"]);

    // An explicit timeout exercises the forwarded-option branch.
    const timedResult = await harness.deactivate({ deactivateTimeoutMs: 1000 });
    expect(timedResult.deactivated).toBe(1);
  });

  it("resolves an explicit name and layer and keeps methods safe to destructure", async () => {
    const events: string[] = [];
    const harness: ExtensionTestHarness = await createExtensionTestHarness(createHarnessFixtureModule(events), {
      name: "explicit-harness-ext",
      layer: "global",
      capabilities: harnessCapabilities,
    });
    expect(harness.name).toBe("explicit-harness-ext");
    expect(harness.layer).toBe("global");
    expect(harness.module).toBeTypeOf("object");

    // Methods close over the activation rather than `this`, so destructuring keeps
    // them callable — the ergonomic the harness promises for agent-authored tests.
    const { activationSummary, assertCommandContract, renderMarkdown, runCommand, deactivate } = harness;
    expect(assertCommandContract({ command: "harness hello" }).command.command).toBe("harness hello");
    expect(activationSummary().commands).toEqual(["harness hello"]);
    expect(renderMarkdown()).toContain("## Extension surfaces");
    expect((await runCommand({ command: "harness hello" })).handled).toBe(true);

    // A matching resolved name/layer means the teardown skip-key lines up and the
    // module deactivates cleanly even after the methods were detached.
    expect(assertExtensionDeactivated(await deactivate()).deactivated).toBe(1);
  });

  it("fails fast with a descriptive error when a registration is dropped for a missing capability", async () => {
    // registerItemFields needs the "schema" capability; declaring only "commands"
    // drops the registration, so the harness throws (with the missing-capability
    // hint) instead of returning a fixture whose registries are silently empty.
    await expect(
      createExtensionTestHarness(
        {
          activate(api: ExtensionApi) {
            api.registerItemFields([{ name: "risk", type: "string" }]);
          },
        },
        { name: "missing-cap-ext", capabilities: ["commands"] },
      ),
    ).rejects.toThrow(
      /createExtensionTestHarness could not activate the extension cleanly: project:missing-cap-ext \(.*missing capability "schema"\)/,
    );
  });

  it("fails fast without a capability hint when activation throws a generic error", async () => {
    // A generic activate throw has no registration-validation trace, so the error
    // reports just the failure reason — covering the no-missing-capability branch.
    await expect(
      createExtensionTestHarness(
        {
          activate() {
            throw new Error("activate boom");
          },
        },
        { name: "throwing-ext", capabilities: ["commands"] },
      ),
    ).rejects.toThrow(/createExtensionTestHarness could not activate the extension cleanly: project:throwing-ext \(.*activate boom.*\)/);
  });
});

describe("sdk assertExtensionBlueprint", () => {
  it("is re-exported by identity from the barrel", () => {
    expect(assertExtensionBlueprintFromBarrel).toBe(assertExtensionBlueprint);
  });

  it("returns the lint result for a clean blueprint, exposing advisory warnings without throwing", () => {
    const result = assertExtensionBlueprint(
      { commands: [{ name: "a b", action: "a-b", run: () => ({}) }] },
      { declaredCapabilities: ["commands", "search"] },
    );
    // `search` is declared-but-unused — a warning, not an error — so the assertion
    // passes and the caller can still inspect the advisory finding.
    expect(result.ok).toBe(true);
    expect(result.findings.some((finding) => finding.code === "capability_unused")).toBe(true);
  });

  it("throws listing the error when the blueprint exercises an undeclared capability", () => {
    expect(() =>
      assertExtensionBlueprint(
        { commands: [{ name: "a b", action: "a-b", run: () => ({}) }], flags: { "a b": [{ long: "--x" }] } },
        { declaredCapabilities: ["commands"] },
      ),
    ).toThrow(/failed preflight with 1 error:\n\s+- \[capability_undeclared\].*schema/);
  });

  it("pluralizes the error summary when several capabilities are undeclared", () => {
    expect(() =>
      assertExtensionBlueprint(
        {
          commands: [{ name: "a b", action: "a-b", run: () => ({}) }],
          searchProviders: [{ name: "s", query: async () => ({ hits: [] }) }],
        },
        { declaredCapabilities: [] },
      ),
    ).toThrow(/failed preflight with 2 errors:/);
  });
});

describe("sdk assertExtensionManifestMatchesBlueprint", () => {
  const commandBlueprint = { commands: [{ name: "a b", action: "a-b", run: () => ({}) }] };

  it("is re-exported by identity from the barrel", () => {
    expect(assertExtensionManifestMatchesBlueprintFromBarrel).toBe(assertExtensionManifestMatchesBlueprint);
  });

  it("returns the reconciliation for an exactly-matching manifest, surfacing advisory warnings", () => {
    const match = assertExtensionManifestMatchesBlueprint(
      { capabilities: ["commands"] },
      {
        commands: [
          { name: "dup", action: "dup-1", run: () => ({}) },
          { name: "dup", action: "dup-2", run: () => ({}) },
        ],
      },
    );
    expect(match.missing).toEqual([]);
    expect(match.unused).toEqual([]);
    expect(match.used).toEqual(["commands"]);
    expect(match.declared).toEqual(["commands"]);
    // A duplicate_command is an advisory warning, surfaced but never fatal here.
    expect(match.findings.some((finding) => finding.code === "duplicate_command")).toBe(true);
  });

  it("normalizes a legacy-alias declared capability before reconciling", () => {
    // `validation` is a legacy alias of `schema`; it must reconcile cleanly against
    // a blueprint whose item fields require `schema`, not report spurious drift.
    const match = assertExtensionManifestMatchesBlueprint(
      { capabilities: ["commands", "validation"] },
      { ...commandBlueprint, itemFields: [{ name: "sev", type: "string" }] },
    );
    expect(match.declared).toEqual(["commands", "schema"]);
    expect(match.missing).toEqual([]);
    expect(match.unused).toEqual([]);
  });

  it("throws naming the missing capability when the manifest under-grants", () => {
    expect(() =>
      assertExtensionManifestMatchesBlueprint(
        { capabilities: ["commands"] },
        { ...commandBlueprint, flags: { "a b": [{ long: "--x" }] } },
      ),
    ).toThrow(/missing \[schema\].*extension_capability_missing/s);
  });

  it("throws naming the unused capability when the manifest over-grants (least privilege)", () => {
    expect(() =>
      assertExtensionManifestMatchesBlueprint({ capabilities: ["commands", "search"] }, commandBlueprint),
    ).toThrow(/unused \[search\].*least privilege/s);
  });

  it("reports both missing and unused capabilities in one error", () => {
    expect(() =>
      assertExtensionManifestMatchesBlueprint(
        { capabilities: ["search"] },
        { ...commandBlueprint, flags: { "a b": [{ long: "--x" }] } },
      ),
    ).toThrow(/missing \[commands, schema\].*unused \[search\]/s);
  });

  it("pluralizes the unused list when several capabilities are over-granted", () => {
    expect(() =>
      assertExtensionManifestMatchesBlueprint({ capabilities: ["commands", "renderers", "search"] }, commandBlueprint),
    ).toThrow(/unused \[renderers, search\] \(declared but no surface exercises them;/);
  });

  it("treats a manifest with no capabilities array as declaring nothing", () => {
    // An untyped `.js` caller can omit `capabilities`; the helper must report every
    // exercised capability as missing rather than crashing or falling back.
    expect(() =>
      assertExtensionManifestMatchesBlueprint({ capabilities: undefined as unknown as string[] }, commandBlueprint),
    ).toThrow(/missing \[commands\]/);
  });

  it("passes for an empty blueprint against an empty manifest", () => {
    const match = assertExtensionManifestMatchesBlueprint({ capabilities: [] }, {});
    expect(match).toEqual({ used: [], declared: [], missing: [], unused: [], findings: [] });
  });

  it("always accepts a manifest synthesized from the same blueprint (synthesize↔assert round-trip)", () => {
    const blueprint = {
      commands: [{ name: "demo", action: "demo", run: () => ({}) }],
      itemFields: [{ name: "sev", type: "string" }],
      searchProviders: [{ name: "s", query: async () => ({ hits: [] }) }],
      hooks: { afterCommand: [() => undefined] },
    };
    const manifest = synthesizeExtensionManifestFromBarrel(blueprint, {
      name: "round-trip",
      version: "1.0.0",
      entry: "./index.js",
      priority: 0,
    });
    const match = assertExtensionManifestMatchesBlueprint(manifest, blueprint);
    expect(match.missing).toEqual([]);
    expect(match.unused).toEqual([]);
    expect(manifest.capabilities).toEqual(["commands", "hooks", "schema", "search"]);
  });
});

describe("sdk assertExtensionManifestCompatible", () => {
  it("is re-exported by identity from the barrel", () => {
    expect(assertExtensionManifestCompatibleFromBarrel).toBe(assertExtensionManifestCompatible);
  });

  it("returns the compatibility result without throwing for a manifest within the supported window", () => {
    const result = assertExtensionManifestCompatible(
      { pm_min_version: "2026.1.0", pm_max_version: "2026.9.0" },
      { pmVersion: "2026.6.23" },
    );
    expect(result).toEqual({ compatible: true, findings: [], pmVersion: "2026.6.23" });
  });

  it("returns (does not throw) on an advisory unchecked warning, surfacing it for inspection", () => {
    const result = assertExtensionManifestCompatible({ pm_min_version: "2026.1.0" }, { pmVersion: "nightly" });
    expect(result.compatible).toBe(true);
    expect(result.findings[0]?.severity).toBe("warning");
  });

  it("throws naming the unmet minimum when the target is below pm_min_version", () => {
    expect(() =>
      assertExtensionManifestCompatible({ pm_min_version: "2026.9.0" }, { pmVersion: "2026.6.23" }),
    ).toThrow(/not compatible with pm 2026\.6\.23.*Requires pm >= 2026\.9\.0/s);
  });

  it("throws when a block-mode pm_max_version is exceeded", () => {
    expect(() =>
      assertExtensionManifestCompatible({ pm_max_version: "2026.1.0" }, { pmVersion: "2026.6.23" }),
    ).toThrow(/pm_max_version|Allows pm <= 2026\.1\.0/);
  });

  it("does not throw when an exceeded pm_max_version is relaxed to warn mode", () => {
    expect(() =>
      assertExtensionManifestCompatible(
        { pm_max_version: "2026.1.0" },
        { pmVersion: "2026.6.23", pmMaxVersionExceededMode: "warn" },
      ),
    ).not.toThrow();
  });

  it("joins multiple blocking findings into one error message", () => {
    expect(() =>
      assertExtensionManifestCompatible(
        { pm_min_version: "2026.9.0", pm_max_version: ">=bad" },
        { pmVersion: "2026.6.23" },
      ),
    ).toThrow(/Requires pm >= 2026\.9\.0.*; .*not a valid inclusive upper bound/s);
  });
});

describe("sdk assertExtensionPreflight", () => {
  const identity = { name: "preflight", version: "1.0.0", entry: "./index.js", priority: 0 } as const;
  const commandBlueprint = {
    commands: [{ name: "demo", action: "demo", run: () => ({ ok: true }) }],
  };

  it("is re-exported by identity from the barrel", () => {
    expect(assertExtensionPreflightFromBarrel).toBe(assertExtensionPreflight);
  });

  it("returns the consolidated report without throwing when every stage passes", () => {
    const report = assertExtensionPreflight(commandBlueprint, {
      declaredCapabilities: ["commands"],
      identity,
      target: { pmVersion: "2026.6.23" },
    });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.manifest).toEqual({ ...identity, capabilities: ["commands"] });
    expect(report.compatibility?.compatible).toBe(true);
  });

  it("does not throw on advisory warnings, surfacing them on the returned report", () => {
    // No declared capabilities → an advisory manifest_capabilities_absent warning only.
    const report = assertExtensionPreflight(commandBlueprint);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([
      expect.objectContaining({ source: "blueprint", severity: "warning", code: "manifest_capabilities_absent" }),
    ]);
  });

  it("throws naming the blocking finding tagged by source and code", () => {
    expect(() => assertExtensionPreflight(commandBlueprint, { declaredCapabilities: [] })).toThrow(
      /failed preflight with 1 error:\n {2}- \[blueprint:capability_undeclared\]/,
    );
  });

  it("pluralizes and lists every blocking finding across stages in one error", () => {
    expect(() =>
      assertExtensionPreflight(commandBlueprint, {
        declaredCapabilities: [],
        identity: { ...identity, pm_min_version: "2026.9.0" },
        target: { pmVersion: "2026.6.23" },
      }),
    ).toThrow(/failed preflight with 2 errors:[\s\S]*\[blueprint:capability_undeclared\][\s\S]*\[compatibility:pm_min_version_unmet\]/);
  });
});
