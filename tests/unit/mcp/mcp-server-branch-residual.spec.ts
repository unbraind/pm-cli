import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const COMMANDS_MODULE = "../../../src/cli/commands/index.js";
const PACKAGE_ROOT_MODULE = "../../../src/core/packages/root.js";
const EXTENSIONS_MODULE = "../../../src/core/extensions/index.js";
const TOOLS_MODULE = "../../../src/mcp/tool-definitions.js";

type CommandModule = typeof import("../../../src/cli/commands/index.js");
const INITIAL_PM_PACKAGE_ROOT = process.env.PM_CLI_PACKAGE_ROOT;

function buildCommandMocks() {
  return {
    runGet: vi.fn(async () => ({ action: "get" })),
    runCopy: vi.fn(async () => ({ action: "copy" })),
    runFocus: vi.fn(async () => ({ action: "focus" })),
    runUpdate: vi.fn(async () => ({ action: "update" })),
    runClaim: vi.fn(async () => ({ action: "claim" })),
    runRelease: vi.fn(async () => ({ action: "release" })),
    runClose: vi.fn(async () => ({ action: "close" })),
    runComments: vi.fn(async () => ({ action: "comments" })),
    runNotes: vi.fn(async () => ({ action: "notes" })),
    runLearnings: vi.fn(async () => ({ action: "learnings" })),
    runFiles: vi.fn(async () => ({ action: "files" })),
    runFilesDiscover: vi.fn(async () => ({ action: "files-discover" })),
    runHistory: vi.fn(async () => ({ action: "history" })),
    runHistoryRedact: vi.fn(async () => ({ action: "history-redact" })),
    runHistoryCompact: vi.fn(async () => ({ action: "history-compact" })),
    runTelemetry: vi.fn(async () => ({ action: "telemetry" })),
    runConfig: vi.fn(async () => ({ action: "config" })),
    runPlan: vi.fn(async () => ({ action: "plan" })),
    runSchemaAddStatus: vi.fn(async () => ({ action: "schema-add-status" })),
    runSchemaAddType: vi.fn(async () => ({ action: "schema-add-type" })),
    runStats: vi.fn(async () => ({ action: "stats" })),
    runAppend: vi.fn(async () => ({ action: "append" })),
    runUpdateMany: vi.fn(async () => ({ action: "update-many" })),
    runCloseMany: vi.fn(async () => ({ action: "close-many" })),
    runDeps: vi.fn(async () => ({ action: "deps" })),
    runDocs: vi.fn(async () => ({ action: "docs" })),
    runTest: vi.fn(async () => ({ action: "test" })),
    runDelete: vi.fn(async () => ({ action: "delete" })),
    runHistoryRepair: vi.fn(async () => ({ action: "history-repair" })),
    runHistoryRepairAll: vi.fn(async () => ({ action: "history-repair-all" })),
    assertHistoryRepairTarget: vi.fn(),
  };
}

async function importServerWithCommandMocks(commandMocks: Record<string, unknown>, applyAdditionalMocks?: () => void) {
  await vi.resetModules();
  applyAdditionalMocks?.();
  vi.doMock(COMMANDS_MODULE, async () => {
    const actual = await vi.importActual<CommandModule>(COMMANDS_MODULE);
    return {
      ...actual,
      ...commandMocks,
    };
  });
  return import("../../../src/mcp/server.js");
}

describe("mcp server branch residual coverage", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock(COMMANDS_MODULE);
    vi.doUnmock(PACKAGE_ROOT_MODULE);
    vi.doUnmock(EXTENSIONS_MODULE);
    vi.doUnmock(TOOLS_MODULE);
    if (INITIAL_PM_PACKAGE_ROOT === undefined) {
      delete process.env.PM_CLI_PACKAGE_ROOT;
    } else {
      process.env.PM_CLI_PACKAGE_ROOT = INITIAL_PM_PACKAGE_ROOT;
    }
    await vi.resetModules();
  });

  it("covers module initialization env/version fallback branches", async () => {
    const previousRoot = process.env.PM_CLI_PACKAGE_ROOT;
    process.env.PM_CLI_PACKAGE_ROOT = "/tmp/preconfigured-pm-root";
    vi.doMock(PACKAGE_ROOT_MODULE, async () => {
      const actual = await vi.importActual<typeof import("../../../src/core/packages/root.js")>(PACKAGE_ROOT_MODULE);
      return {
        ...actual,
        resolvePmCliVersion: vi.fn(() => undefined),
      };
    });
    const server = await import("../../../src/mcp/server.js");
    const initializeResult = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect((initializeResult as { serverInfo?: { version?: string } }).serverInfo?.version).toBe("0.0.0");
    expect(process.env.PM_CLI_PACKAGE_ROOT).toBe("/tmp/preconfigured-pm-root");
    if (previousRoot === undefined) {
      delete process.env.PM_CLI_PACKAGE_ROOT;
    } else {
      process.env.PM_CLI_PACKAGE_ROOT = previousRoot;
    }
  });

  it("covers runAction option-fallback branches with mocked command handlers", async () => {
    const commandMocks = buildCommandMocks();
    const server = await importServerWithCommandMocks(commandMocks);
    const runAction = server._testOnly.runAction;

    await runAction({ action: "get", options: { id: "pm-1" } });
    await runAction({
      action: "copy",
      title: "top-level-title",
      message: "top-level-message",
      author: "top-level-author",
      options: {
        id: "pm-2",
        title: "options-title",
        message: "options-message",
        author: "options-author",
      },
    });
    await runAction({
      action: "copy",
      author: "inject-author",
      options: { id: "pm-2b" },
    });
    await runAction({ action: "focus", id: "pm-2c" });
    await runAction({ action: "focus", options: { clear: true } });
    await runAction({ action: "focus", clear: true });
    await runAction({ action: "update", options: { id: "pm-3", description: "updated" } });
    await runAction({ action: "claim", options: { id: "pm-4" } });
    await runAction({ action: "release", options: { id: "pm-5" } });
    await runAction({ action: "close", options: { id: "pm-6", reason: "done" } });
    await runAction({ action: "close", options: { id: "pm-6b" } });

    await runAction({ action: "comments", options: { id: "pm-7", full: true } });
    await runAction({ action: "comments", options: { id: "pm-7", add: "new comment" } });
    await runAction({ action: "notes", options: { id: "pm-8", add: "new note" } });
    await runAction({ action: "learnings", options: { id: "pm-9", add: "new learning" } });
    await runAction({ action: "files", options: { id: "pm-10", add: "src/file.ts" } });
    await runAction({ action: "files", options: { id: "pm-10", discover: true, discoveryNote: "auto" } });
    await runAction({ action: "docs", options: { id: "pm-11", add: "docs/guide.md" } });
    await runAction({ action: "test", options: { id: "pm-12", add: "node test.js" } });
    await runAction({ action: "deps", options: { id: "pm-13" } });
    await runAction({ action: "delete", options: { id: "pm-14" } });

    await runAction({ action: "telemetry", limit: 12, options: {} });
    await runAction({ action: "telemetry", options: { limit: 8 } });
    await runAction({ action: "telemetry", options: { limit: "9" } });
    await runAction({ action: "telemetry", limit: "5", options: { limit: NaN } });
    await runAction({ action: "config", options: { configAction: "get", key: "telemetry-tracking" } });

    await runAction({ action: "files-discover", options: { id: "pm-15a" } });
    await runAction({ action: "history", options: { id: "pm-15b" } });
    await runAction({ action: "history-redact", options: { id: "pm-15c" } });
    await runAction({ action: "history-compact", options: { id: "pm-15d" } });
    await runAction({ action: "history-repair", options: { id: "pm-15" } });
    await runAction({ action: "history-repair", options: { all: true } });

    await runAction({ action: "plan", options: { subcommand: "show", id: "pm-16", reorderTo: "7" } });
    await runAction({ action: "plan", options: { subcommand: "show", id: "pm-16a", reorderTo: 4 } });
    await runAction({ action: "plan", options: { subcommand: "show", id: "pm-16b", stepRef: "step-1" } });
    await runAction({
      action: "schema",
      subcommand: "add-status",
      name: "review",
      order: "3",
      options: {},
    });
    await runAction({
      action: "schema",
      subcommand: "add-status",
      name: "queued",
      options: {},
    });
    await runAction({
      action: "schema",
      subcommand: "add-type",
      name: "Initiative",
      options: {},
    });
    await runAction({ action: "stats", options: { tagPrefix: "topic:" } });
    await runAction({ action: "stats", options: { tagPrefix: 42 } });
    await runAction({ action: "append", options: { id: "pm-17", body: "body" } });
    await runAction({ action: "update-many", options: { list: { status: "open" }, update: { priority: 2 }, checkpoint: true } });
    await runAction({ action: "close-many", reason: "bulk-close", options: { list: { status: "open" } } });

    await expect(
      runAction({
        action: "schema",
        subcommand: "add-status",
        name: "blocked",
        order: "1.5",
        options: {},
      }),
    ).rejects.toThrow(/finite integer/);

    expect(server._testOnly.updateManyOptionsFromFlat({ update: { title: "bulk" } } as never)).toMatchObject({
      list: expect.any(Object),
      update: expect.objectContaining({ title: "bulk" }),
    });
    expect(server._testOnly.updateManyOptionsFromFlat({ checkpoint: true } as never)).toMatchObject({
      checkpoint: undefined,
    });
    expect(server._testOnly.nearestDeclaredKey("abce", ["abcd", "abcf"])).toBe("abcd");

    await expect(
      server.handleRequest({
        jsonrpc: "2.0",
        id: 99,
        method: undefined,
      } as never),
    ).rejects.toThrow(/Unsupported MCP method: \(missing\)/);

    await server.handleRequest({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "pm_focus", arguments: { id: "pm-foc" } },
    } as never);
    expect(commandMocks.runFocus).toHaveBeenCalled();

    expect(server._testOnly.errorContent(new Error("plain-error"))).toMatchObject({ isError: true });
    expect(server._testOnly.errorContent("primitive-error")).toMatchObject({ isError: true });

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    server._testOnly.writeError(1, "primitive-write-error");
    expect(writeSpy).toHaveBeenCalled();

    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw "bad-json";
    });
    await server.processRpcLine("{ definitely not json");
    parseSpy.mockRestore();

    expect(commandMocks.runCopy).toHaveBeenCalledTimes(2);
    expect(commandMocks.runComments).toHaveBeenCalledTimes(2);
    expect(commandMocks.runHistoryRepair).toHaveBeenCalledTimes(1);
    expect(commandMocks.runHistoryRepairAll).toHaveBeenCalledTimes(1);
    expect(commandMocks.assertHistoryRepairTarget).toHaveBeenCalledTimes(2);
  });

  it("covers extension-dispatch fallback branches", async () => {
    const commandMocks = buildCommandMocks();
    const runActiveCommandHandler = vi.fn(async () => ({
      handled: false,
      warnings: [],
      result: undefined,
    }));
    const server = await importServerWithCommandMocks(commandMocks, () => {
      vi.doMock(EXTENSIONS_MODULE, async () => {
        const actual = await vi.importActual<typeof import("../../../src/core/extensions/index.js")>(EXTENSIONS_MODULE);
        return {
          ...actual,
          loadExtensions: vi.fn(async () => ({ loaded: [] })),
          activateExtensions: vi.fn(async () => ({
            commands: { handlers: [] },
            hooks: { before: [], after: [] },
            parsers: { itemTypes: [] },
            preflight: { checks: [] },
            services: { records: new Map() },
            renderers: { itemSections: [] },
            registrations: { commands: [{ action: "custom", command: "pm custom" }] },
          })),
          runActiveCommandHandler,
          deactivateExtensions: vi.fn(async () => undefined),
          setActiveExtensionCommands: vi.fn(),
          setActiveExtensionHooks: vi.fn(),
          setActiveExtensionParsers: vi.fn(),
          setActiveExtensionPreflight: vi.fn(),
          setActiveExtensionServices: vi.fn(),
          setActiveExtensionRenderers: vi.fn(),
          setActiveExtensionRegistrations: vi.fn(),
        };
      });
    });

    await withTempPmPath(async (context) => {
      await expect(server._testOnly.runAction({ action: "custom", path: context.pmPath, options: {} })).rejects.toThrow(
        /Unsupported native pm action: custom/,
      );
      expect(runActiveCommandHandler).toHaveBeenCalledTimes(1);
    });
  });

  it("covers activation-failure cleanup branch and schema-key fallback", async () => {
    const commandMocks = buildCommandMocks();
    const server = await importServerWithCommandMocks(commandMocks, () => {
      vi.doMock(EXTENSIONS_MODULE, async () => {
        const actual = await vi.importActual<typeof import("../../../src/core/extensions/index.js")>(EXTENSIONS_MODULE);
        return {
          ...actual,
          loadExtensions: vi.fn(async () => ({ loaded: [] })),
          activateExtensions: vi.fn(async () => {
            throw new Error("activation failed");
          }),
          deactivateExtensions: vi.fn(async () => undefined),
        };
      });
      vi.doMock(TOOLS_MODULE, async () => {
        const actual = await vi.importActual<typeof import("../../../src/mcp/tool-definitions.js")>(TOOLS_MODULE);
        return {
          ...actual,
          TOOLS: [
            ...actual.TOOLS,
            {
              name: "pm_test_no_properties",
              description: "Test tool missing properties for coverage",
              inputSchema: { type: "object" },
            },
          ],
        };
      });
    });

    await withTempPmPath(async (context) => {
      await expect(server._testOnly.runAction({ action: "custom", path: context.pmPath, options: {} })).rejects.toThrow(/activation failed/);
    });
    const warnings = server._testOnly.detectUnexpectedTopLevelKeys("pm_test_no_properties", { typo: "value" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("declared arguments are:");
  });
});
