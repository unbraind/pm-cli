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
  STATUS_VALUES,
  assertRegisteredCommandContract as assertRegisteredCommandContractFromBarrel,
  assertRegisteredExporter as assertRegisteredExporterFromBarrel,
  assertRegisteredHook as assertRegisteredHookFromBarrel,
  assertRegisteredImporter as assertRegisteredImporterFromBarrel,
  assertRegisteredSearchProvider as assertRegisteredSearchProviderFromBarrel,
  appendHistoryEntry,
  createHistoryEntry,
  createPmCliExpectedError,
  defineExtension,
  type ExtensionHookRegistry,
  type ExtensionRegistrationRegistry,
  generateItemId,
  getContracts,
  getWorkspaceContracts,
  getItemPath,
  normalizeItemId,
  pathExists,
  readFileIfExists,
  readSettings,
  resolvePmRoot,
  isPmCliExpectedError,
  writeFileAtomic,
} from "../../src/sdk/index.js";
import {
  assertRegisteredCommandContract,
  assertRegisteredExporter,
  assertRegisteredHook,
  assertRegisteredImporter,
  assertRegisteredSearchProvider,
} from "../../src/sdk/testing.js";
import { readSettings as readCoreSettings, writeSettings } from "../../src/core/store/settings.js";
import { activateExtensions, loadExtensions } from "../../src/core/extensions/loader.js";
import { writeTestExtension } from "../helpers/extensions.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

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
    ],
    item_fields: [],
    item_types: [],
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
    vector_store_adapters: [],
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
    ]);
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
      expect.arrayContaining(["defaults", "author", "agentGuidance", "typePreset", "withPackages"]),
    );
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.schema.required).toEqual(["subcommand"]);
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.schema.optional).toEqual(expect.arrayContaining(["name"]));
    expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.upgrade.optional).toEqual(expect.arrayContaining(["dryRun"]));
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
    expect(typeof readSettings).toBe("function");
    expect(typeof resolvePmRoot).toBe("function");
  });

  it("re-exports the sdk testing assertion helpers through the barrel", () => {
    expect(typeof assertRegisteredCommandContractFromBarrel).toBe("function");
    expect(typeof assertRegisteredHookFromBarrel).toBe("function");
    expect(typeof assertRegisteredSearchProviderFromBarrel).toBe("function");
    expect(typeof assertRegisteredImporterFromBarrel).toBe("function");
    expect(typeof assertRegisteredExporterFromBarrel).toBe("function");
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
      expect(defaultContracts.schema_version).toBe("4.0.1");
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
    expect(resultWithoutFlagExpectations.flags).toHaveLength(2);

    const registryWithBlankFlagLabels = createRegistrationRegistry();
    registryWithBlankFlagLabels.flags[0]!.flags.push({ long: " " }, { short: " " });
    expect(
      assertRegisteredCommandContract(registryWithBlankFlagLabels, {
        command: "hello world",
        flags: ["--shout"],
      }).flags,
    ).toHaveLength(4);

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

  it("asserts importer, exporter, search provider, and hook registrations from a real extension activation", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: pmPath,
        placement: "projectRoot",
        directory: "capability-ext",
        manifest: {
          name: "capability-ext",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["importers", "search", "hooks"],
        },
        entryFilename: "index.mjs",
        entrySource: [
          "export function activate(api) {",
          "  api.registerImporter('jsonl', async () => ({ items: [] }));",
          "  api.registerExporter('jsonl', async () => ({ content: '' }));",
          "  api.registerSearchProvider({ name: 'capability-search', query: async () => ({ hits: [] }) });",
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

      const hook = assertRegisteredHook(activation.hooks, {
        kind: "on_write",
        extensionName: "capability-ext",
      });
      expect(typeof hook.run).toBe("function");
    });
  });
});
