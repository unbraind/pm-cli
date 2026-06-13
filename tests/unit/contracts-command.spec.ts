import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { _testOnlyContractsCommand, runContracts } from "../../src/cli/commands/contracts.js";
import { buildMcpToolContracts, TOOLS } from "../../src/mcp/tool-definitions.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import {
  KNOWN_EXTENSION_CAPABILITIES,
  KNOWN_EXTENSION_POLICY_MODES,
  KNOWN_EXTENSION_POLICY_SURFACES,
  KNOWN_EXTENSION_SANDBOX_PROFILES,
  KNOWN_EXTENSION_SERVICE_NAMES,
  KNOWN_EXTENSION_TRUST_MODES,
} from "../../src/core/extensions/extension-types.js";
import type { GlobalOptions } from "../../src/core/shared/command-types.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import {
  PM_EXTENSION_CAPABILITY_CONTRACTS,
  PM_EXTENSION_POLICY_MODE_CONTRACTS,
  PM_EXTENSION_POLICY_SURFACE_CONTRACTS,
  PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS,
  PM_EXTENSION_SERVICE_NAME_CONTRACTS,
  PM_EXTENSION_TRUST_MODE_CONTRACTS,
  PM_TOOL_PARAMETERS_SCHEMA_MAJOR,
  PM_TOOL_PARAMETERS_SCHEMA_VERSION,
} from "../../src/sdk/cli-contracts.js";
import { writeTestExtension } from "../helpers/extensions.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const GLOBAL_OPTIONS: GlobalOptions = {
  json: true,
  quiet: false,
  noExtensions: false,
  profile: false,
};

describe("contracts command helper coverage", () => {
  it("maps package-owned and prefixed actions back to command paths", () => {
    expect(_testOnlyContractsCommand.packageOwnedActionForCommand("templates show")).toBe("templates-show");
    expect(_testOnlyContractsCommand.packageOwnedActionForCommand("templates list")).toBe("templates-list");
    expect(_testOnlyContractsCommand.packageOwnedActionForCommand("test-runs status")).toBe("test-runs-status");
    expect(_testOnlyContractsCommand.packageOwnedActionForCommand("test-runs tail")).toBe("test-runs-tail");
    expect(_testOnlyContractsCommand.packageOwnedActionForCommand("create")).toBe("create");
    expect(_testOnlyContractsCommand.resolveActionCommandPath("extension-reload")).toBe("extension reload");
    expect(_testOnlyContractsCommand.resolveActionCommandPath("package-install")).toBe("package install");
    expect(_testOnlyContractsCommand.resolveActionCommandPath("test-runs-status")).toBe("test-runs status");
    expect(_testOnlyContractsCommand.resolveActionCommandPath("templates-show")).toBe("templates show");
    expect(_testOnlyContractsCommand.resolveActionCommandPath("not-real-action")).toBeNull();
  });

  it("normalizes command aliases and resolves scoped commands", () => {
    expect(_testOnlyContractsCommand.normalizeCommandPath("  Extension   Reload ")).toBe("extension reload");
    expect(_testOnlyContractsCommand.normalizeActionNameFromCommand("extension reload")).toBe("extension-reload");
    expect(_testOnlyContractsCommand.splitCommandPathAliases(" create | extension  reload | ")).toEqual([
      "create",
      "extension reload",
    ]);
    expect(_testOnlyContractsCommand.splitCommandPathAliases(" | ")).toEqual([]);
    expect(
      _testOnlyContractsCommand.actionDescriptorMatchesSelectedCommand(
        { action: "extension-reload", provider: "core", requires_extension: false, command_path: "extension reload" },
        "extension",
      ),
    ).toBe(true);
    expect(
      _testOnlyContractsCommand.actionDescriptorMatchesSelectedCommand(
        { action: "hidden", provider: "core", requires_extension: false, command_path: null },
        "extension",
      ),
    ).toBe(false);
    expect(
      _testOnlyContractsCommand.resolveScopedCommandsFromActionDescriptors(
        [
          { action: "a", provider: "core", requires_extension: false, command_path: "extension reload" },
          { action: "b", provider: "core", requires_extension: false, command_path: "package install" },
          { action: "c", provider: "core", requires_extension: false, command_path: "" },
          { action: "d", provider: "core", requires_extension: false, command_path: "   | " },
        ],
        ["extension", "extension reload", "package"],
      ),
    ).toEqual(["extension reload", "package"]);
  });

  it("filters schema branches by action names", () => {
    const schema = {
      type: "object",
      oneOf: [
        { properties: { action: { const: "create" } } },
        { properties: { action: { const: "update" } } },
        { properties: { action: {} } },
        { properties: null },
        null,
      ],
    } as Record<string, unknown>;

    expect(_testOnlyContractsCommand.extractActionBranches({ type: "object" })).toEqual([]);
    expect(_testOnlyContractsCommand.extractActionBranches(schema)).toHaveLength(4);
    expect((_testOnlyContractsCommand.filterSchemaByAction(schema, undefined).oneOf as unknown[])).toHaveLength(5);
    expect((_testOnlyContractsCommand.filterSchemaByAction(schema, "create").oneOf as unknown[])).toHaveLength(1);
    expect(
      (_testOnlyContractsCommand.filterSchemaByActions(schema, new Set(["create", "missing"])).oneOf as unknown[]),
    ).toHaveLength(1);
  });

  it("builds runtime field flag contracts with alias normalization and deduplication", () => {
    const contracts = _testOnlyContractsCommand.buildRuntimeFieldFlagContracts({
      definitions: [
        {
          key: "reviewUrl",
          metadata_key: "review_url",
          cli_flag: "review-url",
          cli_aliases: ["-r", "--review", "--review-url", " "],
          commands: ["create", "update"],
        },
        {
          key: "hidden",
          metadata_key: "hidden",
          cli_flag: " ",
          cli_aliases: [],
          commands: ["create"],
        },
      ],
    });

    expect(_testOnlyContractsCommand.toRuntimeLongFlagToken("review-url")).toBe("--review-url");
    expect(_testOnlyContractsCommand.toRuntimeLongFlagToken(" ")).toBeNull();
    expect(_testOnlyContractsCommand.toRuntimeShortFlagToken("-r")).toBe("-r");
    expect(_testOnlyContractsCommand.toRuntimeShortFlagToken("r")).toBeNull();
    expect(_testOnlyContractsCommand.toRuntimeShortFlagToken("--review")).toBeNull();
    expect(contracts.get("create")).toEqual([
      { flag: "--review-url", short: "-r" },
      { flag: "--review" },
    ]);
    expect(contracts.get("update")).toEqual([
      { flag: "--review-url", short: "-r" },
      { flag: "--review" },
    ]);
  });

  it("attaches create required-option metadata only to create schema branches", () => {
    const noBranches = { type: "object" } as Record<string, unknown>;
    expect(_testOnlyContractsCommand.attachCreateRequiredOptionContracts(noBranches, { Task: ["title"] })).toBe(noBranches);

    const malformedPropertiesBranch = { type: "object", oneOf: [{ properties: null }] } as Record<string, unknown>;
    expect(
      _testOnlyContractsCommand.attachCreateRequiredOptionContracts(malformedPropertiesBranch, { Task: ["title"] }),
    ).toBe(malformedPropertiesBranch);

    const untouched = { type: "object", oneOf: [{ properties: { action: {} } }] } as Record<string, unknown>;
    expect(_testOnlyContractsCommand.attachCreateRequiredOptionContracts(untouched, { Task: ["title"] })).toBe(untouched);
    const malformedActionBranch = { type: "object", oneOf: [{ properties: { action: null } }] } as Record<string, unknown>;
    expect(
      _testOnlyContractsCommand.attachCreateRequiredOptionContracts(malformedActionBranch, { Task: ["title"] }),
    ).toBe(malformedActionBranch);

    const enriched = _testOnlyContractsCommand.attachCreateRequiredOptionContracts(
      {
        type: "object",
        oneOf: [
          { properties: { action: { const: "create" } } },
          { properties: { action: { const: "update" } } },
        ],
      } as Record<string, unknown>,
      { Task: ["title"] },
    );

    expect(enriched).not.toBe(untouched);
    expect((enriched.oneOf as Array<Record<string, unknown>>)[0]["x-create-required-options"]).toEqual({
      Task: ["title"],
    });
    expect((enriched.oneOf as Array<Record<string, unknown>>)[1]["x-create-required-options"]).toBeUndefined();
  });

  it("builds extension command contracts, schema branches, availability, and runtime field flags", () => {
    expect(_testOnlyContractsCommand.toRuntimeLongFlagToken(" field-name ")).toBe("--field-name");
    expect(_testOnlyContractsCommand.toRuntimeLongFlagToken("--already")).toBe("--already");
    expect(_testOnlyContractsCommand.toRuntimeLongFlagToken("-x")).toBeNull();
    expect(_testOnlyContractsCommand.toRuntimeLongFlagToken(" ")).toBeNull();
    expect(_testOnlyContractsCommand.toRuntimeShortFlagToken("-x")).toBe("-x");
    expect(_testOnlyContractsCommand.toRuntimeShortFlagToken("--long")).toBeNull();
    expect(_testOnlyContractsCommand.toRuntimeShortFlagToken("field")).toBeNull();
    expect(_testOnlyContractsCommand.normalizeCommandForRuntimeFieldFlags("list-open")).toBe("list");
    expect(_testOnlyContractsCommand.normalizeCommandForRuntimeFieldFlags("cal")).toBe("calendar");
    expect(_testOnlyContractsCommand.normalizeCommandForRuntimeFieldFlags("ctx")).toBe("context");
    expect(_testOnlyContractsCommand.normalizeCommandForRuntimeFieldFlags("update-many")).toBe("update_many");

    const runtimeFieldFlags = _testOnlyContractsCommand.buildRuntimeFieldFlagContracts({
      definitions: [
        {
          key: "reviewer",
          metadata_key: "reviewer",
          cli_flag: "reviewer",
          cli_aliases: ["-r", "review-by", "--reviewer"],
          description: "Reviewer",
          type: "string",
          commands: ["create", "update_many"],
          repeatable: false,
          required: true,
          required_on_create: false,
          required_types: [],
          allow_unset: true,
        },
        {
          key: "bad",
          metadata_key: "bad",
          cli_flag: "-x",
          cli_aliases: [],
          type: "boolean",
          commands: ["create"],
          repeatable: false,
          required: false,
          required_on_create: false,
          required_types: [],
          allow_unset: true,
        },
      ],
      by_key: new Map(),
      by_cli_token: new Map(),
      command_to_fields: new Map(),
    });
    expect(runtimeFieldFlags.get("create")).toEqual([
      { flag: "--reviewer", short: "-r" },
      { flag: "--review-by" },
    ]);
    expect(runtimeFieldFlags.get("update_many")).toEqual([
      { flag: "--reviewer", short: "-r" },
      { flag: "--review-by" },
    ]);

    const flagsByCommand = _testOnlyContractsCommand.collectExtensionFlagContractsByCommand([
      {
        layer: "project",
        name: "pkg-b",
        target_command: "  pkg run ",
        flags: [
          { long: "--count", short: "-c", description: "Count", required: true, value_type: "number" },
          { long: "--count", short: "-c", repeatable: true },
          { long: "", short: "--bad" },
        ],
      },
      {
        layer: "global",
        name: "pkg-a",
        target_command: "pkg run",
        flags: [{ short: "-v", description: "Verbose", type: "boolean" }],
      },
      {
        layer: "project",
        name: "empty",
        target_command: " ",
        flags: [{ long: "--ignored" }],
      },
    ] as never);
    expect(flagsByCommand.get("pkg run")).toEqual({
      flags: [
        { flag: "--count", short: "-c", description: "Count", required: true, value_type: "number" },
        { flag: "-v", description: "Verbose", value_type: "boolean" },
      ],
      sources: [
        { layer: "global", name: "pkg-a" },
        { layer: "project", name: "pkg-b" },
      ],
    });

    const extensionContracts = _testOnlyContractsCommand.collectExtensionCommandContracts({
      handlers: new Set(["pkg run"]),
      disabledReason: null,
      policyState: { mode: "warn", trust_mode: "warn", default_sandbox_profile: "restricted" },
      commandDefinitions: [
        {
          command: "pkg run",
          action: "pkg-run",
          description: "Run package",
          intent: null,
          arguments: [
            { name: "target", required: true, variadic: false, description: null },
            { name: "", required: true, variadic: false },
          ],
          flags: [],
          examples: ["pm pkg run"],
          failure_hints: ["Install pkg"],
          source: { layer: "project", name: "pkg-b" },
        },
        {
          command: " ",
          action: "ignored",
          arguments: [],
          flags: [],
          examples: [],
          failure_hints: [],
          source: null,
        },
      ],
      flagRegistrations: [
        {
          layer: "project",
          name: "pkg-b",
          target_command: "pkg run",
          flags: [{ long: "--level", repeatable: true, value_name: "level" }],
        },
        {
          layer: "global",
          name: "standalone",
          target_command: "standalone command",
          flags: [{ long: "--flag" }],
        },
      ],
    } as never);
    expect(extensionContracts).toEqual([
      expect.objectContaining({
        command: "pkg run",
        action: "pkg-run",
        arguments: [{ name: "target", required: true, variadic: false, description: null }],
        flags: [expect.objectContaining({ flag: "--level", repeatable: true, value_name: "level" })],
      }),
      expect.objectContaining({
        command: "standalone command",
        action: "standalone-command",
        flags: [expect.objectContaining({ flag: "--flag" })],
      }),
    ]);

    expect(_testOnlyContractsCommand.extensionSchemaPropertyNameFromFlag({ flag: "----" })).toBeNull();
    const branch = _testOnlyContractsCommand.buildExtensionActionSchemaBranch({
      command: "pkg run|pkg execute",
      action: "pkg-run",
      source: { layer: "project", name: "pkg-b" },
      description: null,
      intent: null,
      arguments: [
        { name: "target", required: true, variadic: false, description: null },
        { name: "rest", required: false, variadic: true, description: "Rest args" },
      ],
      flags: [
        { flag: "--level", value_type: "number", required: true },
        { flag: "--items", repeatable: true, value_type: "string" },
        { flag: "----" },
      ],
      examples: [],
      failure_hints: [],
    });
    expect(branch).toMatchObject({
      required: ["action", "target", "level"],
      "x-extension-command": "pkg run",
      "x-extension-commands": ["pkg run", "pkg execute"],
    });
    expect((branch.properties as Record<string, unknown>).rest).toMatchObject({ type: "array" });
    expect((branch.properties as Record<string, unknown>).level).toMatchObject({ type: ["number", "string"] });
    expect((branch.properties as Record<string, unknown>).items).toMatchObject({ type: "array" });

    const merged = _testOnlyContractsCommand.mergeExtensionContractsByAction([
      {
        command: "b command",
        action: "same",
        source: null,
        description: null,
        intent: null,
        arguments: [],
        flags: [{ flag: "--count" }],
        examples: ["b"],
        failure_hints: ["hint"],
      },
      {
        command: "a command",
        action: "same",
        source: null,
        description: null,
        intent: null,
        arguments: [{ name: "id", required: true, variadic: false, description: null }],
        flags: [{ flag: "--count", required: true }, { flag: "--new", repeatable: true }],
        examples: ["a", "b"],
        failure_hints: ["hint", "next"],
      },
    ]);
    expect(merged).toEqual([
      expect.objectContaining({
        action: "same",
        command: "a command|b command",
        arguments: [{ name: "id", required: true, variadic: false, description: null }],
        flags: [
          { flag: "--count", required: true },
          { flag: "--new", repeatable: true },
        ],
        examples: ["b", "a"],
        failure_hints: ["hint", "next"],
      }),
    ]);

    expect(_testOnlyContractsCommand.isCoreCommandPath("create")).toBe(true);
    expect(_testOnlyContractsCommand.isCoreCommandPath("calendar")).toBe(false);
    expect(_testOnlyContractsCommand.resolveCoreCommandFlags("missing")).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--json" })]),
    );
    expect(
      _testOnlyContractsCommand.resolveActionAvailability(
        { action: "create", provider: "core", requires_extension: false, command_path: "create" },
        {
          handlers: new Set(),
          disabledReason: null,
          policyState: { mode: "warn", trust_mode: "warn", default_sandbox_profile: "restricted" },
          commandDefinitions: [],
          flagRegistrations: [],
        } as never,
      ),
    ).toMatchObject({ action: "create", invocable: true, provider: "core" });
    expect(
      _testOnlyContractsCommand.resolveActionAvailability(
        { action: "calendar", provider: "extension", requires_extension: true, command_path: "calendar" },
        {
          handlers: new Set(),
          disabledReason: null,
          policyState: { mode: "warn", trust_mode: "warn", default_sandbox_profile: "restricted" },
          commandDefinitions: [],
          flagRegistrations: [],
        } as never,
      ),
    ).toMatchObject({
      action: "calendar",
      invocable: false,
      disabled_reason: "optional_package_not_installed:calendar",
      cli_exposed: false,
    });
    expect(
      _testOnlyContractsCommand.collectActionContractDescriptors(
        [
          {
            command: "custom command",
            action: "custom-action",
            source: null,
            description: null,
            intent: null,
            arguments: [],
            flags: [],
            examples: [],
            failure_hints: [],
          },
        ],
        { includePackageOwnedActions: true },
      ).some((descriptor) => descriptor.action === "custom-action" && descriptor.provider === "extension"),
    ).toBe(true);
  });
});

describe("contracts command runtime", () => {
  it("returns schema, actions, command flags, and alias surfaces", async () => {
    const result = await runContracts({}, GLOBAL_OPTIONS);
    expect(result.schema_version).toBe(PM_TOOL_PARAMETERS_SCHEMA_VERSION);
    expect(result.schema_id).toBe(
      `https://schema.unbrained.dev/pm-cli/tool-parameters-v${PM_TOOL_PARAMETERS_SCHEMA_MAJOR}.schema.json`,
    );
    expect(result.selected.runtime_only).toBe(false);
    expect(result.actions ?? []).toContain("contracts");
    expect(result.actions ?? []).toContain("aggregate");
    expect(result.actions ?? []).toContain("extension-reload");
    expect(result.actions ?? []).toContain("package-install");
    expect(result.actions ?? []).toContain("package-catalog");
    expect(result.actions ?? []).toContain("install");
    expect(result.actions ?? []).toContain("upgrade");
    expect(result.commands).toContain("contracts");
    expect(result.commands).toContain("aggregate");
    expect(result.commands).toContain("package");
    expect(result.commands).toContain("packages");
    expect(result.commands).toContain("install");
    expect(result.commands).toContain("upgrade");
    expect(result.command_aliases).toEqual(
      expect.arrayContaining([
        { canonical: "context", aliases: ["ctx"] },
        { canonical: "package", aliases: ["extension", "packages", "install"] },
      ]),
    );
    expect(result.schema).toBeUndefined();
    expect(result.schema_omitted_reason).toBe("unfiltered_default_brief");
    expect(result.command_flags).toBeUndefined();
    expect(result.command_flags_omitted_reason).toBe("unfiltered_default_brief");
    expect(result.commander_aliases).toBeUndefined();
    expect(result.commander_aliases_omitted_reason).toBe("unfiltered_default_brief");
    expect(
      (result.action_availability ?? []).some(
        (entry) => entry.action === "create" && entry.invocable,
      ),
    ).toBe(true);
    expect(
      (result.action_availability ?? []).some(
        (entry) =>
          entry.action === "package-install" &&
          entry.command_path === "package install" &&
          entry.cli_exposed,
      ),
    ).toBe(true);
    const packageInstallFlags = await runContracts({ command: "package install", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(packageInstallFlags.command_flags).toEqual([
      expect.objectContaining({
        command: "package install",
        provider: "core",
        flags: expect.arrayContaining([
          expect.objectContaining({ flag: "--project" }),
          expect.objectContaining({ flag: "--github" }),
          expect.objectContaining({ flag: "--ref" }),
        ]),
      }),
    ]);
    const packageCatalogFlags = await runContracts({ command: "package catalog", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(packageCatalogFlags.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--fields" })]),
    );
    const optionalCalendarAvailability = await runContracts(
      { command: "calendar", availabilityOnly: true, runtimeOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(optionalCalendarAvailability.action_availability).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "calendar",
        available: false,
        disabled_reason: "optional_package_not_installed:calendar",
      }),
    ]));
    const fullResult = await runContracts({ full: true }, GLOBAL_OPTIONS);
    expect(fullResult.schema).toBeDefined();
    expect(fullResult.schema_omitted_reason).toBeUndefined();
    expect(
      fullResult.command_flags?.some((entry) => entry.command === "contracts"),
    ).toBe(true);
    expect(
      fullResult.command_flags?.find((entry) => entry.command === "aggregate")
        ?.flags,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: "--group-by" }),
        expect.objectContaining({ flag: "--count" }),
      ]),
    );
    expect(fullResult.command_flags?.find((entry) => entry.command === "get")?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: "--depth" }),
        expect.objectContaining({ flag: "--full" }),
        expect.objectContaining({ flag: "--fields" }),
      ]),
    );
    expect(fullResult.commander_aliases).toBeDefined();
    expect(
      fullResult.commander_aliases?.create_string_options.length,
    ).toBeGreaterThan(0);
    expect(fullResult.commander_aliases?.list_string_options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "fields" }),
        expect.objectContaining({ target: "sort" }),
      ]),
    );
    expect(result.extension_contracts).toMatchObject({
      capabilities: expect.arrayContaining(["commands", "schema", "services"]),
      services: expect.arrayContaining(["output_format", "history_append"]),
      policy_modes: expect.arrayContaining(["off", "warn", "enforce"]),
      policy_surfaces: expect.arrayContaining([
        "commands.handler",
        "hooks.beforecommand",
        "search.provider",
      ]),
      trust_modes: expect.arrayContaining(["off", "warn", "enforce"]),
      sandbox_profiles: expect.arrayContaining([
        "none",
        "restricted",
        "strict",
      ]),
      manifest_versions: [1, 2],
      compatibility: {
        current: "v2",
        previous: ["v1"],
        breaking_strategy: "versioned_breaking",
      },
    });
    expect(result.extension_contracts?.capabilities).toEqual([...KNOWN_EXTENSION_CAPABILITIES]);
    expect(result.extension_contracts?.services).toEqual([...KNOWN_EXTENSION_SERVICE_NAMES]);
    expect(result.extension_contracts?.policy_modes).toEqual([...KNOWN_EXTENSION_POLICY_MODES]);
    expect(result.extension_contracts?.policy_surfaces).toEqual([...KNOWN_EXTENSION_POLICY_SURFACES]);
    expect(result.extension_contracts?.trust_modes).toEqual([...KNOWN_EXTENSION_TRUST_MODES]);
    expect(result.extension_contracts?.sandbox_profiles).toEqual([...KNOWN_EXTENSION_SANDBOX_PROFILES]);
    expect(PM_EXTENSION_CAPABILITY_CONTRACTS).toEqual(KNOWN_EXTENSION_CAPABILITIES);
    expect(PM_EXTENSION_SERVICE_NAME_CONTRACTS).toEqual(KNOWN_EXTENSION_SERVICE_NAMES);
    expect(PM_EXTENSION_POLICY_MODE_CONTRACTS).toEqual(KNOWN_EXTENSION_POLICY_MODES);
    expect(PM_EXTENSION_POLICY_SURFACE_CONTRACTS).toEqual(KNOWN_EXTENSION_POLICY_SURFACES);
    expect(PM_EXTENSION_TRUST_MODE_CONTRACTS).toEqual(KNOWN_EXTENSION_TRUST_MODES);
    expect(PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS).toEqual(KNOWN_EXTENSION_SANDBOX_PROFILES);
  });

  it("supports schema-only mode with action filtering", async () => {
    const result = await runContracts(
      {
        action: "create",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    expect(result.selected.action).toBe("create");
    expect(result.selected.schema_only).toBe(true);
    expect(result.selected.runtime_only).toBe(false);
    expect(result.command_flags).toBeUndefined();
    const oneOf = (result.schema?.oneOf ?? []) as Array<{
      properties?: { action?: { const?: string } };
    }>;
    expect(oneOf).toHaveLength(1);
    expect(oneOf[0]?.properties?.action?.const).toBe("create");
    const createRequiredContracts = (oneOf[0] as Record<string, unknown>)[
      "x-create-required-options"
    ] as
      | {
          default_create_mode?: string;
          by_create_mode?: {
            strict?: {
              by_type?: Record<string, { required_flags?: string[] }>;
            };
            progressive?: {
              by_type?: Record<string, { required_flags?: string[] }>;
            };
          };
        }
      | undefined;
    expect(createRequiredContracts?.default_create_mode).toBe("strict");
    expect(
      createRequiredContracts?.by_create_mode?.strict?.by_type?.Task
        ?.required_flags,
    ).toEqual(
      expect.arrayContaining([
        "--title",
        "--description",
        "--type",
        "--status",
        "--priority",
        "--message",
        "--dep",
        "--comment",
        "--doc",
      ]),
    );
    expect(
      createRequiredContracts?.by_create_mode?.progressive?.by_type?.Task
        ?.required_flags,
    ).toEqual(expect.arrayContaining(["--title", "--type"]));
    expect(
      createRequiredContracts?.by_create_mode?.progressive?.by_type?.Task
        ?.required_flags,
    ).not.toEqual(expect.arrayContaining(["--dep", "--comment", "--doc", "--description"]));
  });

  it("publishes strict MCP action contracts for docs list, add notes, and history repair", async () => {
    const schemaResult = await runContracts({ schemaOnly: true, full: true }, GLOBAL_OPTIONS);
    expect(schemaResult.schema?.["x-schema-version"]).toBe(PM_TOOL_PARAMETERS_SCHEMA_VERSION);
    const actionSchemas = (schemaResult.schema?.oneOf ?? []) as Array<{
      allOf?: unknown[];
      oneOf?: unknown[];
      properties?: Record<string, unknown>;
    }>;
    const findActionSchema = (action: string) =>
      actionSchemas.find((entry) => {
        const actionProperty = entry.properties?.action as { const?: string } | undefined;
        return actionProperty?.const === action;
    });

    const docsFlags = await runContracts({ command: "docs", flagsOnly: true }, GLOBAL_OPTIONS);
    expect(docsFlags.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--list" })]),
    );

    const addNotePrecondition = {
      if: { required: ["addNote"] },
      then: { anyOf: [{ required: ["add"] }, { required: ["addGlob"] }] },
    };
    const docsSchema = findActionSchema("docs");
    expect(docsSchema?.properties).toHaveProperty("list");
    expect(docsSchema?.allOf).toEqual(expect.arrayContaining([addNotePrecondition]));
    const filesSchema = findActionSchema("files");
    expect(filesSchema?.allOf).toEqual(expect.arrayContaining([addNotePrecondition]));

    const historyRepairSchema = findActionSchema("history-repair");
    expect(historyRepairSchema?.oneOf).toEqual([
      { required: ["id"], not: { anyOf: [{ required: ["all"] }] } },
      {
        required: ["all"],
        not: { anyOf: [{ required: ["id"] }] },
        properties: { all: { const: true } },
      },
    ]);
  });

  it("exposes activity projection flags in the action schema", async () => {
    const result = await runContracts(
      {
        action: "activity",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const oneOf = (result.schema?.oneOf ?? []) as Array<{
      properties?: Record<string, unknown>;
    }>;

    expect(oneOf).toHaveLength(1);
    expect(oneOf[0]?.properties).toHaveProperty("compact");
    expect(oneOf[0]?.properties).toHaveProperty("full");
  });

  it("assigns allowAuditUpdate only to update-family action schemas", async () => {
    const createResult = await runContracts(
      {
        action: "create",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const updateResult = await runContracts(
      {
        action: "update",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const createSchema = (createResult.schema?.oneOf ?? [])[0] as { properties?: Record<string, unknown> } | undefined;
    const updateSchema = (updateResult.schema?.oneOf ?? [])[0] as { properties?: Record<string, unknown> } | undefined;

    expect(createSchema?.properties).not.toHaveProperty("allowAuditUpdate");
    expect(updateSchema?.properties).toHaveProperty("allowAuditUpdate");
  });

  it("accepts health and validate diagnostic flags in action schemas", async () => {
    const healthResult = await runContracts(
      {
        action: "health",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const validateResult = await runContracts(
      {
        action: "validate",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const healthSchema = (healthResult.schema?.oneOf ?? [])[0] as { properties?: Record<string, unknown> } | undefined;
    const validateSchema = (validateResult.schema?.oneOf ?? [])[0] as { properties?: Record<string, unknown> } | undefined;

    expect(healthSchema?.properties).toEqual(
      expect.objectContaining({
        skipVectors: expect.objectContaining({ type: "boolean" }),
        skipIntegrity: expect.objectContaining({ type: "boolean" }),
        skipDrift: expect.objectContaining({ type: "boolean" }),
      }),
    );
    expect(validateSchema?.properties).toEqual(
      expect.objectContaining({
        verboseDiagnostics: expect.objectContaining({ type: "boolean" }),
      }),
    );
  });

  it("accepts init force in the action schema", async () => {
    const result = await runContracts(
      {
        action: "init",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const initSchema = (result.schema?.oneOf ?? [])[0] as { properties?: Record<string, unknown> } | undefined;

    expect(initSchema?.properties).toHaveProperty("force");
  });

  it("emits a usable plan action schema for strict clients", async () => {
    const result = await runContracts(
      {
        action: "plan",
        schemaOnly: true,
      },
      GLOBAL_OPTIONS,
    );
    const oneOf = (result.schema?.oneOf ?? []) as Array<{
      required?: string[];
      properties?: Record<string, { type?: string; enum?: string[]; anyOf?: Array<{ type?: string }> }>;
    }>;
    const planSchema = oneOf[0];

    expect(planSchema?.required).toEqual(["action", "subcommand"]);
    expect(planSchema?.properties?.subcommand?.enum).toEqual(
      expect.arrayContaining(["create", "show", "add-step", "materialize"]),
    );
    expect(planSchema?.properties?.stepRef?.type).toBe("string");
    expect(planSchema?.properties?.reorderTo?.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "number" })]),
    );
    expect(planSchema?.properties?.scope).toMatchObject({ type: "string" });
    expect(planSchema?.properties?.scope).not.toHaveProperty("enum");
    expect(planSchema?.properties?.mode?.enum).toEqual(
      expect.arrayContaining(["draft", "research", "approved", "completed"]),
    );
    expect(planSchema?.properties?.file?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "string" }),
        expect.objectContaining({ type: "array" }),
      ]),
    );
    expect(planSchema?.properties?.test?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "string" }),
        expect.objectContaining({ type: "array" }),
      ]),
    );
    expect(planSchema?.properties?.doc?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "string" }),
        expect.objectContaining({ type: "array" }),
      ]),
    );
  });

  it("includes runtime field flags for list aliases and runtime schema command metadata", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        ...(settings.schema.fields ?? []),
        {
          key: "customer_segment",
          type: "string",
          commands: ["list", "create", "update", "search"],
          cli_aliases: ["segment"],
        },
        {
          key: "single_review_stage",
          type: "string",
          commands: ["update"],
          cli_flag: "single-review-stage",
        },
        {
          key: "bulk_review_stage",
          type: "string",
          commands: ["update_many"],
          cli_flag: "bulk-review-stage",
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");

      const listAliasContracts = await runContracts(
        { command: "list-open", flagsOnly: true },
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );
      expect(listAliasContracts.command_flags?.[0]?.flags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ flag: "--customer-segment" }),
          expect.objectContaining({ flag: "--segment" }),
        ]),
      );

      const updateManyContracts = await runContracts(
        { command: "update-many", flagsOnly: true },
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );
      const updateManyFlags = updateManyContracts.command_flags?.[0]?.flags.map((entry) => entry.flag) ?? [];
      expect(updateManyFlags).toContain("--bulk-review-stage");
      expect(updateManyFlags).not.toContain("--single-review-stage");

      const runtimeContracts = await runContracts(
        {},
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );
      expect(runtimeContracts.runtime_schema.fields_by_command.list).toEqual(
        expect.arrayContaining(["--customer-segment"]),
      );
    });
  });

  it("supports runtime-only filtering without advertising optional package actions as static core actions", async () => {
    const result = await runContracts(
      {
        runtimeOnly: true,
      },
      {
        ...GLOBAL_OPTIONS,
        noExtensions: true,
      },
    );
    expect(result.selected.runtime_only).toBe(true);
    expect(result.actions ?? []).not.toContain("beads-import");
    expect(result.actions ?? []).toContain("validate");
    expect(
      (result.action_availability ?? []).every((entry) => entry.invocable),
    ).toBe(true);

    const fullResult = await runContracts(
      {},
      {
        ...GLOBAL_OPTIONS,
        noExtensions: true,
      },
    );
    expect(fullResult.actions ?? []).not.toContain("beads-import");
    expect(
      (fullResult.action_availability ?? []).some(
        (entry) => entry.action === "beads-import",
      ),
    ).toBe(false);
  });

  it("narrows action and schema scope by command filter by default", async () => {
    const result = await runContracts(
      { command: "list", runtimeOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(result.selected.command).toBe("list");
    expect(result.selected.command_scoped).toBe(true);
    expect(result.actions).toEqual(["list"]);
    expect(result.action_availability).toEqual([
      expect.objectContaining({
        action: "list",
        command_path: "list",
        cli_exposed: true,
      }),
    ]);
    expect(result.commands).toEqual(["list"]);
    const oneOf = (result.schema?.oneOf ?? []) as Array<{
      properties?: { action?: { const?: string } };
    }>;
    expect(oneOf).toHaveLength(1);
    expect(oneOf[0]?.properties?.action?.const).toBe("list");
  });

  it("supports lightweight flags-only and availability-only projections", async () => {
    const flagsOnly = await runContracts(
      { command: "update", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(flagsOnly.selected.flags_only).toBe(true);
    expect(flagsOnly.selected.availability_only).toBe(false);
    expect(flagsOnly.command_flags?.map((entry) => entry.command)).toEqual([
      "update",
    ]);
    expect(flagsOnly.schema).toBeUndefined();
    expect(flagsOnly.actions).toBeUndefined();
    expect(flagsOnly.action_availability).toBeUndefined();
    expect(flagsOnly.commander_aliases).toBeUndefined();

    const appendFlags = await runContracts(
      { command: "append", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(appendFlags.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--body" })]),
    );

    const createFlags = await runContracts(
      { command: "create", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    const createAcceptanceFlag = createFlags.command_flags?.[0]?.flags.find(
      (entry) => entry.flag === "--acceptance-criteria",
    );
    expect(createAcceptanceFlag?.aliases).toEqual(
      expect.arrayContaining(["--acceptance_criteria"]),
    );
    expect(
      createFlags.command_flags?.[0]?.flags.some(
        (entry) => entry.flag === "--acceptance_criteria",
      ),
    ).toBe(false);

    const updateFlags = await runContracts(
      { command: "update", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    const updateWhyNowFlag = updateFlags.command_flags?.[0]?.flags.find(
      (entry) => entry.flag === "--why-now",
    );
    expect(updateWhyNowFlag?.aliases).toEqual(
      expect.arrayContaining(["--why_now"]),
    );
    expect(
      updateFlags.command_flags?.[0]?.flags.some(
        (entry) => entry.flag === "--why_now",
      ),
    ).toBe(false);

    const initFlags = await runContracts(
      { command: "init", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    const initDefaultsFlag = initFlags.command_flags?.[0]?.flags.find(
      (entry) => entry.flag === "--defaults",
    );
    expect(initDefaultsFlag).toMatchObject({
      flag: "--defaults",
      short: "-y",
    });
    expect(initDefaultsFlag?.aliases).toEqual(expect.arrayContaining(["--yes"]));
    expect(
      initFlags.command_flags?.[0]?.flags.some(
        (entry) => entry.flag === "--yes",
      ),
    ).toBe(false);
    expect(initFlags.command_flags?.[0]?.flags.some((entry) => entry.flag === "--verbose")).toBe(true);
    expect(initFlags.command_flags?.[0]?.flags.some((entry) => entry.flag === "--type-preset")).toBe(true);

    const schemaAction = await runContracts(
      { action: "schema", schemaOnly: true },
      GLOBAL_OPTIONS,
    );
    const schemaBranch = (schemaAction.schema?.oneOf ?? [])[0] as { required?: string[]; properties?: Record<string, unknown> } | undefined;
    expect(schemaBranch?.required).toEqual(["action", "subcommand"]);
    expect(schemaBranch?.properties?.name).toBeDefined();
    expect(schemaBranch).toMatchObject({
      allOf: expect.arrayContaining([
        expect.objectContaining({
          if: { properties: { subcommand: { const: "show" } }, required: ["subcommand"] },
          then: { required: ["name"] },
        }),
      ]),
    });

    const activityFlags = await runContracts(
      { command: "activity", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(activityFlags.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: "--id" }),
        expect.objectContaining({ flag: "--op" }),
        expect.objectContaining({ flag: "--author" }),
        expect.objectContaining({ flag: "--from" }),
        expect.objectContaining({ flag: "--to" }),
        expect.objectContaining({ flag: "--stream" }),
      ]),
    );

    const compactFlags = await runContracts(
      { flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(compactFlags.commands).toContain("context");
    expect(compactFlags.commands).toContain("package");
    expect(compactFlags.commands).not.toContain("ctx");
    expect(compactFlags.commands).not.toContain("extension");
    expect(compactFlags.commands).not.toContain("packages");
    expect(compactFlags.commands).not.toContain("install");
    expect(
      compactFlags.command_flags?.some((entry) => entry.command === "ctx"),
    ).toBe(false);
    expect(
      compactFlags.command_flags?.some(
        (entry) => entry.command === "extension",
      ),
    ).toBe(false);
    expect(
      compactFlags.command_flags?.some((entry) => entry.command === "packages"),
    ).toBe(false);
    expect(
      compactFlags.command_flags?.some((entry) => entry.command === "install"),
    ).toBe(false);
    expect(compactFlags.command_aliases).toEqual(
      expect.arrayContaining([
        { canonical: "context", aliases: ["ctx"] },
        { canonical: "package", aliases: ["extension", "packages", "install"] },
      ]),
    );

    const selectedAliasFlags = await runContracts(
      { command: "ctx", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(selectedAliasFlags.commands).toEqual(["ctx"]);
    expect(
      selectedAliasFlags.command_flags?.map((entry) => entry.command),
    ).toEqual(["ctx"]);

    const installFlags = await runContracts(
      { command: "install", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(installFlags.command_flags?.[0]?.flags).toEqual([
      { flag: "--project" },
      { flag: "--local" },
      { flag: "--global" },
      { flag: "--gh" },
      { flag: "--github" },
      { flag: "--ref" },
    ]);
    expect(
      installFlags.command_flags?.[0]?.flags.some(
        (entry) => entry.flag === "--doctor" || entry.flag === "--init",
      ),
    ).toBe(false);

    const commandFlagParityChecks: Array<{ command: string; flags: string[] }> =
      [
        {
          command: "create",
          flags: [
            "--acceptance-criteria",
            "--definition-of-ready",
            "--blocked-by",
            "--why-now",
            "--customer-impact",
          ],
        },
        {
          command: "update",
          flags: [
            "--acceptance-criteria",
            "--definition-of-ready",
            "--blocked-by",
            "--why-now",
            "--customer-impact",
          ],
        },
        {
          command: "update-many",
          flags: [
            "--acceptance-criteria",
            "--definition-of-ready",
            "--why-now",
            "--customer-impact",
          ],
        },
        {
          command: "comments",
          flags: ["--add", "--stdin", "--file", "--allow-audit-comment"],
        },
        {
          command: "notes",
          flags: [
            "--add",
            "--limit",
            "--author",
            "--message",
            "--allow-audit-note",
            "--allow-audit-comment",
            "--force",
          ],
        },
        {
          command: "learnings",
          flags: [
            "--add",
            "--limit",
            "--author",
            "--message",
            "--allow-audit-learning",
            "--allow-audit-comment",
            "--force",
          ],
        },
        {
          command: "files",
          flags: [
            "--add",
            "--add-glob",
            "--note",
            "--list",
            "--append-stable",
            "--validate-paths",
            "--audit",
          ],
        },
        {
          command: "docs",
          flags: ["--add", "--add-glob", "--note", "--list", "--validate-paths", "--audit"],
        },
        { command: "history", flags: ["--limit", "--compact", "--full", "--diff", "--verify"] },
        {
          command: "history-compact",
          flags: ["--before", "--dry-run", "--author", "--message", "--force"],
        },
        {
          command: "history-redact",
          flags: ["--literal", "--regex", "--replacement", "--dry-run", "--author", "--message", "--force"],
        },
        {
          command: "plan",
          flags: [
            "--title",
            "--scope",
            "--harness",
            "--mode",
            "--resume-context",
            "--step-title",
            "--step",
            "--step-status",
            "--step-evidence",
            "--depends-on",
            "--link",
            "--link-kind",
            "--depth",
            "--steps",
            "--materialize-type",
            "--decision-text",
            "--discovery-text",
            "--validation-text",
            "--allow-multiple-active",
            "--promote-to-item-dep",
            "--author",
            "--message",
            "--force",
          ],
        },
        {
          command: "config",
          flags: ["--criterion", "--clear-criteria", "--format", "--policy"],
        },
        {
          command: "init",
          flags: ["--preset", "--defaults", "--author", "--agent-guidance", "--with-packages"],
        },
        { command: "restore", flags: ["--author", "--message", "--force"] },
        { command: "delete", flags: ["--dry-run", "--author", "--message", "--force"] },
        {
          command: "test",
          flags: [
            "--run",
            "--background",
            "--pm-context",
            "--override-linked-pm-context",
            "--fail-on-empty-test-run",
            "--check-context",
            "--auto-pm-context",
          ],
        },
        {
          command: "test-all",
          flags: [
            "--status",
            "--limit",
            "--offset",
            "--background",
            "--pm-context",
            "--override-linked-pm-context",
            "--fail-on-empty-test-run",
            "--check-context",
            "--auto-pm-context",
          ],
        },
        { command: "gc", flags: ["--dry-run", "--scope"] },
        {
          command: "list-open",
          flags: ["--compact", "--brief", "--full", "--fields", "--include-body"],
        },
        {
          command: "search",
          flags: ["--mode", "--semantic", "--hybrid", "--semantic-weight", "--include-linked"],
        },
        {
          command: "extension",
          flags: [
            "--init",
            "--install",
            "--doctor",
            "--catalog",
            "--runtime-probe",
            "--strict-exit",
          ],
        },
        {
          command: "package",
          flags: [
            "--init",
            "--install",
            "--doctor",
            "--catalog",
            "--runtime-probe",
            "--strict-exit",
          ],
        },
        {
          command: "packages install",
          flags: ["--gh", "--github", "--ref", "--project", "--global"],
        },
        {
          command: "package catalog",
          flags: ["--fields", "--project", "--global"],
        },
        {
          command: "install",
          flags: ["--gh", "--github", "--ref", "--project", "--global"],
        },
        {
          command: "upgrade",
          flags: [
            "--dry-run",
            "--cli-only",
            "--packages-only",
            "--repair",
            "--tag",
          ],
        },
        {
          command: "update-many",
          flags: [
            "--filter-status",
            "--dry-run",
            "--rollback",
            "--no-checkpoint",
            "--dep",
            "--replace-tests",
            "--clear-docs",
            "--clear-events",
            "--allow-audit-update",
          ],
        },
        {
          command: "validate",
          flags: [
            "--check-metadata",
            "--metadata-profile",
            "--check-lifecycle",
            "--check-stale-blockers",
            "--dependency-cycle-severity",
            "--verbose-file-lists",
            "--verbose-diagnostics",
          ],
        },
        {
          command: "health",
          flags: [
            "--check-only",
            "--no-refresh",
            "--refresh-vectors",
            "--verbose-stale-items",
            "--brief",
            "--summary",
            "--skip-vectors",
            "--skip-integrity",
            "--skip-drift",
            "--full",
          ],
        },
      ];
    for (const check of commandFlagParityChecks) {
      const parityResult = await runContracts(
        { command: check.command, flagsOnly: true },
        GLOBAL_OPTIONS,
      );
      expect(parityResult.command_flags?.[0]?.flags).toEqual(
        expect.arrayContaining(
          check.flags.map((flag) => expect.objectContaining({ flag })),
        ),
      );
      if (check.command === "plan") {
        expect(parityResult.command_flags?.[0]?.flags).toEqual(
          expect.arrayContaining([
            // pm-6mit: --step is a standalone Commander collect repeatable (no
            // longer an alias of --step-title).
            expect.objectContaining({ flag: "--step-title", aliases: expect.arrayContaining(["--step_title"]) }),
            expect.objectContaining({ flag: "--step" }),
          ]),
        );
      }
    }

    const availabilityOnly = await runContracts(
      { command: "update", availabilityOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(availabilityOnly.selected.flags_only).toBe(false);
    expect(availabilityOnly.selected.availability_only).toBe(true);
    expect(availabilityOnly.actions).toEqual(["update"]);
    expect(availabilityOnly.action_availability).toEqual([
      expect.objectContaining({
        action: "update",
        command_path: "update",
        cli_exposed: true,
      }),
    ]);
    expect(availabilityOnly.schema).toBeUndefined();
    expect(availabilityOnly.command_flags).toBeUndefined();
    expect(availabilityOnly.commander_aliases).toBeUndefined();

    const optionalActionAvailability = await runContracts(
      { action: "calendar", availabilityOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(optionalActionAvailability.actions).toEqual(["calendar"]);
    expect(optionalActionAvailability.action_availability).toEqual([
      expect.objectContaining({
        action: "calendar",
        command_path: "calendar|cal",
        disabled_reason: "optional_package_not_installed:calendar",
      }),
    ]);

    const optionalRootCommandAvailability = await runContracts(
      { command: "templates", availabilityOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(optionalRootCommandAvailability.actions).toEqual(["templates-list"]);
    expect(optionalRootCommandAvailability.action_availability).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "templates-list",
        disabled_reason: "optional_package_not_installed:templates",
      }),
    ]));
  });

  it("scopes command_flags by action when no command filter is provided", async () => {
    const commentsAction = await runContracts(
      { action: "comments", flagsOnly: true },
      GLOBAL_OPTIONS,
    );
    expect(commentsAction.commands).toEqual(["comments"]);
    expect(commentsAction.command_flags?.map((entry) => entry.command)).toEqual(
      ["comments"],
    );
    expect(commentsAction.command_flags?.[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: "--stdin" }),
        expect.objectContaining({ flag: "--file" }),
        expect.objectContaining({ flag: "--allow-audit-comment" }),
      ]),
    );
  });

  it("rejects conflicting contracts projection flags", async () => {
    await expect(
      runContracts({ schemaOnly: true, flagsOnly: true }, GLOBAL_OPTIONS),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(
      runContracts({ flagsOnly: true, availabilityOnly: true }, GLOBAL_OPTIONS),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("reports lifecycle action command-path discoverability metadata", async () => {
    const result = await runContracts({ action: "start-task" }, GLOBAL_OPTIONS);
    expect(result.actions).toEqual(["start-task"]);
    expect(result.action_availability).toEqual([
      expect.objectContaining({
        action: "start-task",
        command_path: "start-task",
        cli_exposed: true,
      }),
    ]);
  });

  it("rejects optional package actions from the static SDK schema when the package command is not installed", async () => {
    await expect(
      runContracts(
        {
          action: "beads-import",
          runtimeOnly: true,
          schemaOnly: true,
        },
        {
          ...GLOBAL_OPTIONS,
          noExtensions: true,
        },
      ),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });

    await expect(
      runContracts(
        {
          action: "calendar",
          runtimeOnly: true,
          schemaOnly: true,
        },
        {
          ...GLOBAL_OPTIONS,
          noExtensions: true,
        },
      ),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });

    await expect(
      runContracts(
        {
          action: "templates-save",
          runtimeOnly: true,
          schemaOnly: true,
        },
        {
          ...GLOBAL_OPTIONS,
          noExtensions: true,
        },
      ),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("keeps installed extension actions visible in runtime-only mode", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath,
        placement: "projectRoot",
        directory: "beads-contract-action",
        manifest: {
          name: "beads-contract-action",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands", "schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'beads import',",
          "      action: 'beads-import',",
          "      flags: [{ long: '--file', value_name: 'path', value_type: 'string' }],",
          "      run: () => ({ ok: true }),",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      });

      const result = await runContracts(
        {
          action: "beads-import",
          runtimeOnly: true,
          schemaOnly: true,
        },
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );
      expect(result.actions).toEqual(["beads-import"]);
      expect(result.action_availability).toEqual([
        {
          action: "beads-import",
          invocable: true,
          available: true,
          requires_extension: true,
          provider: "extension",
          disabled_reason: null,
          command_path: "beads import",
          cli_exposed: true,
          policy_state: {
            mode: "off",
            trust_mode: "off",
            default_sandbox_profile: "none",
          },
        },
      ]);
      const oneOf = (result.schema?.oneOf ?? []) as Array<{
        properties?: { action?: { const?: string } };
      }>;
      expect(oneOf).toHaveLength(1);
      expect(oneOf[0]?.properties?.action?.const).toBe("beads-import");
    });
  });

  it("does not synthesize optional package action availability when extension runtime probing fails before activation", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      await rm(settingsPath, { force: true });
      await mkdir(settingsPath, { recursive: true });

      const result = await runContracts(
        {},
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );

      expect(result.actions ?? []).not.toContain("beads-import");
      expect(
        (result.action_availability ?? []).some(
          (entry) => entry.action === "beads-import",
        ),
      ).toBe(false);
    });
  });

  it("merges active extension command/action schemas into contracts output", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath,
        placement: "projectRoot",
        directory: "migrate-asset-contracts",
        manifest: {
          name: "migrate-asset-contracts",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands", "schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'migrate-asset',",
          "      action: 'migrate-asset',",
          "      description: 'Migrate asset payloads to the current schema version.',",
          "      intent: 'Validate and migrate asset payloads before writing output.',",
          "      examples: [",
          "        'pm migrate-asset --source assets/source.json --target assets/output.json'",
          "      ],",
          "      failure_hints: [",
          "        'Ensure --source points to an existing readable file.'",
          "      ],",
          "      arguments: [",
          "        { name: 'assetId', required: false, description: 'Optional asset identifier override.' }",
          "      ],",
          "      flags: [",
          "        { long: '--source', value_name: 'path', required: true, description: 'Source asset payload path.' },",
          "        { long: '--target', value_name: 'path', description: 'Destination payload path.' },",
          "        { long: '--dry-run', description: 'Preview migration only.' }",
          "      ],",
          "      run: (context) => ({",
          "        command: context.command,",
          "        options: context.options,",
          "      }),",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      });

      const result = await runContracts(
        {
          action: "migrate-asset",
          command: "migrate-asset",
        },
        {
          ...GLOBAL_OPTIONS,
          path: context.pmPath,
        },
      );

      expect(result.actions).toEqual(["migrate-asset"]);
      expect(result.commands).toEqual(["migrate-asset"]);
      expect(result.action_availability).toEqual([
        expect.objectContaining({
          action: "migrate-asset",
          provider: "extension",
          requires_extension: true,
          invocable: true,
          available: true,
          disabled_reason: null,
        }),
      ]);
      expect(result.extension_commands).toEqual([
        expect.objectContaining({
          command: "migrate-asset",
          action: "migrate-asset",
          source: {
            layer: "project",
            name: "migrate-asset-contracts",
          },
          description: "Migrate asset payloads to the current schema version.",
          intent: "Validate and migrate asset payloads before writing output.",
          arguments: [
            {
              name: "assetId",
              required: false,
              variadic: false,
              description: "Optional asset identifier override.",
            },
          ],
          flags: [
            { flag: "--source", description: "Source asset payload path.", required: true, value_name: "path", value_type: "string" },
            { flag: "--target", description: "Destination payload path.", value_name: "path", value_type: "string" },
            { flag: "--dry-run", description: "Preview migration only." },
          ],
          examples: [
            "pm migrate-asset --source assets/source.json --target assets/output.json",
          ],
          failure_hints: [
            "Ensure --source points to an existing readable file.",
          ],
        }),
      ]);
      expect(result.command_flags).toEqual([
        expect.objectContaining({
          command: "migrate-asset",
          provider: "extension",
          flags: [
            { flag: "--source", description: "Source asset payload path.", required: true, value_name: "path", value_type: "string" },
            { flag: "--target", description: "Destination payload path.", value_name: "path", value_type: "string" },
            { flag: "--dry-run", description: "Preview migration only." },
          ],
          extension_sources: [
            {
              layer: "project",
              name: "migrate-asset-contracts",
            },
          ],
        }),
      ]);

      const oneOf = (result.schema?.oneOf ?? []) as Array<{
        properties?: {
          action?: { const?: string };
          assetId?: unknown;
          source?: unknown;
          target?: unknown;
          dryRun?: unknown;
        };
        ["x-extension-source"]?: { layer?: string; name?: string } | null;
        ["x-extension-commands"]?: string[];
      }>;
      const migrateBranch = oneOf.find(
        (entry) => entry.properties?.action?.const === "migrate-asset",
      );
      expect(migrateBranch).toBeDefined();
      expect(migrateBranch?.properties?.assetId).toBeDefined();
      expect(migrateBranch?.properties?.source).toBeDefined();
      expect(migrateBranch?.properties?.target).toBeDefined();
      expect(migrateBranch?.properties?.dryRun).toBeDefined();
      expect(migrateBranch?.properties?.source).toMatchObject({ type: "string" });
      expect(migrateBranch?.properties?.dryRun).toMatchObject({ type: "boolean" });
      expect((migrateBranch as { required?: string[] } | undefined)?.required).toContain("source");
      expect(migrateBranch?.["x-extension-source"]).toEqual({
        layer: "project",
        name: "migrate-asset-contracts",
      });
      expect(migrateBranch?.["x-extension-commands"]).toEqual(["migrate-asset"]);
    });
  });

  it("deduplicates extension schema branches by action while preserving command aliases", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath,
        placement: "projectRoot",
        directory: "alias-action-contracts",
        manifest: {
          name: "alias-action-contracts",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands", "schema"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "const flags = [{ long: '--view', value_name: 'value', value_type: 'string', description: 'View.' }];",
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({ name: 'alias-main', action: 'alias-action', flags, run: () => ({ ok: true }) });",
          "    api.registerCommand({ name: 'alias-short', action: 'alias-action', flags, run: () => ({ ok: true }) });",
          "  },",
          "};",
          "",
        ].join("\n"),
      });

      const result = await runContracts(
        { action: "alias-action", schemaOnly: true },
        { ...GLOBAL_OPTIONS, path: context.pmPath },
      );
      const branches = (result.schema?.oneOf ?? []) as Array<{
        properties?: { action?: { const?: string }; view?: unknown };
        ["x-extension-commands"]?: string[];
      }>;
      expect(branches.filter((branch) => branch.properties?.action?.const === "alias-action")).toHaveLength(1);
      expect(branches[0]?.["x-extension-commands"]).toEqual(["alias-main", "alias-short"]);
      expect(branches[0]?.properties?.view).toMatchObject({ type: "string" });
    });
  });

  it("rejects unknown action and command filters", async () => {
    await expect(
      runContracts({ action: "unknown-action" }, GLOBAL_OPTIONS),
    ).rejects.toMatchObject<PmCliError>({
      message: 'Unknown action: "unknown-action".',
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(
      runContracts({ command: "unknown-command" }, GLOBAL_OPTIONS),
    ).rejects.toMatchObject<PmCliError>({
      message: 'Unknown command: "unknown-command".',
      exitCode: EXIT_CODE.USAGE,
      context: expect.objectContaining({
        code: "unknown_command",
        required: expect.any(String),
        why: expect.any(String),
        examples: expect.arrayContaining(["pm contracts --flags-only --json"]),
        nextSteps: expect.arrayContaining([expect.any(String)]),
        recovery: expect.objectContaining({
          suggested_retry: "pm contracts --flags-only --json",
        }),
      }),
    });
    await expect(
      runContracts({ command: "calendar" }, { ...GLOBAL_OPTIONS, path: "/tmp/pm-contracts-no-calendar" }),
    ).rejects.toMatchObject<PmCliError>({
      message: expect.stringContaining("pm install calendar --project"),
      exitCode: EXIT_CODE.USAGE,
      context: expect.objectContaining({
        code: "unknown_command",
        required: expect.any(String),
        why: expect.any(String),
        examples: expect.arrayContaining(["pm install calendar --project"]),
        nextSteps: expect.arrayContaining([expect.any(String)]),
        recovery: expect.objectContaining({
          suggested_retry: "pm install calendar --project",
        }),
      }),
    });
  });

  it("rejects action and command filters that do not map to each other", async () => {
    await expect(
      runContracts({ command: "create", action: "update" }, GLOBAL_OPTIONS),
    ).rejects.toMatchObject<PmCliError>({
      message: 'Action "update" is not mapped to command "create" in contracts output.',
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("snapshots the MCP tool surface in full output only (pm-4os2)", async () => {
    const fullResult = await runContracts({ full: true }, GLOBAL_OPTIONS);
    expect(fullResult.mcp_tools).toEqual(buildMcpToolContracts());

    const names = (fullResult.mcp_tools ?? []).map((tool) => tool.name);
    // Sorted, unique, and inclusive of the workspace-configuration narrow tools.
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["pm_run", "pm_append", "pm_schema", "pm_config", "pm_copy", "pm_plan"]));
    expect(names).toHaveLength(TOOLS.length);

    // Default brief / projection modes omit the MCP tool surface.
    const briefResult = await runContracts({}, GLOBAL_OPTIONS);
    expect(briefResult.mcp_tools).toBeUndefined();
    const flagsOnlyResult = await runContracts({ full: true, flagsOnly: true }, GLOBAL_OPTIONS);
    expect(flagsOnlyResult.mcp_tools).toBeUndefined();
  });

  it("builds stable MCP tool contracts with required fields and schema shapes (pm-4os2)", () => {
    const contracts = buildMcpToolContracts();
    const byName = new Map(contracts.map((tool) => [tool.name, tool]));

    // Required top-level fields surface per tool (pm-v68d/pm-7u9j).
    expect(byName.get("pm_schema")?.required).toEqual(["subcommand"]);
    expect(byName.get("pm_config")?.required).toEqual(["configAction"]);
    expect(byName.get("pm_append")?.required).toEqual(["id"]);
    expect(byName.get("pm_update")?.required).toEqual(["id", "options"]);
    expect(byName.get("pm_run")?.required).toEqual(["action"]);
    expect(byName.get("pm_list")?.required).toEqual([]);

    for (const tool of contracts) {
      expect(tool.description.length).toBeGreaterThan(0);
      const schema = tool.input_schema as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(schema.type).toBe("object");
      // Every tool inherits the shared base properties (TOOL_SCHEMA_BASE).
      expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["cwd", "path", "author"]));
      // The contract's required projection is the sorted schema required list.
      expect(tool.required).toEqual([...(schema.required ?? [])].sort((left, right) => left.localeCompare(right)));
      // Passthrough stays enabled so options forwarding keeps working.
      expect(schema.additionalProperties).toBe(true);
    }
  });
});
