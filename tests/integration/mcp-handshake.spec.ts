import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { _testOnly as mcpServerTestOnly, handleRequest, processRpcLine, startMcpServer } from "../../src/mcp/server.js";
import { TOOLS, buildMcpToolContracts } from "../../src/mcp/tool-definitions.js";
import * as extensionLoader from "../../src/core/extensions/loader.js";
import * as extensionRuntime from "../../src/core/extensions/index.js";
import {
  createEmptyExtensionCommandRegistry,
  createEmptyExtensionHookRegistry,
  createEmptyExtensionParserRegistry,
  createEmptyExtensionPreflightRegistry,
  createEmptyExtensionRegistrationRegistry,
  createEmptyExtensionRendererRegistry,
  createEmptyExtensionServiceRegistry,
} from "../../src/core/extensions/extension-registries.js";
import { createSerialQueue } from "../../src/core/shared/serial-queue.js";
import { PM_TOOL_ACTIONS } from "../../src/sdk/cli-contracts/enum-contracts.js";
import { assertPmContextDepthProjection } from "../helpers/mcp-context-depth.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

// pm-kl11: MCP protocol handshake coverage. These tests drive handleRequest
// directly (the same entry point the stdio transport calls per JSON-RPC line)
// to lock the initialize/tools-list/tools-call contract, the 25-tool surface
// (incl. the pm-hywv narrow tools and the pm-v68d/pm-7u9j workspace tools),
// the unknown-tool error path, and the pm-qxwu typo-warning behavior.

const EXPECTED_TOOL_NAMES = [
  "pm_run",
  "pm_context",
  "pm_search",
  "pm_list",
  "pm_get",
  "pm_create",
  "pm_copy",
  "pm_update",
  "pm_append",
  "pm_claim",
  "pm_release",
  "pm_close",
  "pm_comments",
  "pm_files",
  "pm_docs",
  "pm_notes",
  "pm_learnings",
  "pm_deps",
  "pm_test",
  "pm_validate",
  "pm_health",
  "pm_contracts",
  "pm_schema",
  "pm_config",
  "pm_plan",
];

describe("MCP protocol handshake", () => {
  it("handles ping with an empty result payload", async () => {
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 0,
        method: "ping",
      }),
    ).resolves.toEqual({});
  });

  it("initialize returns protocolVersion, serverInfo, and instructions", async () => {
    const result = (await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "handshake-test", version: "1.0.0" },
      },
    })) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      instructions?: string;
      capabilities?: Record<string, unknown>;
    };

    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo).toMatchObject({ name: "pm-mcp" });
    expect(typeof result.serverInfo?.version).toBe("string");
    // pm-2nvw: serverInfo.version must reflect the real package.json version,
    // not the former hard-coded "1.0.0".
    expect(result.serverInfo?.version).not.toBe("1.0.0");
    expect(result.serverInfo?.version).toMatch(/^\d+\.\d+\./);
    expect(typeof result.instructions).toBe("string");
    expect(result.instructions).toContain("pm_context");
    // pm-hywv: the narrow tools are advertised in the prefer-narrow guidance.
    expect(result.instructions).toContain("pm_notes");
    expect(result.instructions).toContain("pm_learnings");
    expect(result.instructions).toContain("pm_deps");
    expect(result.instructions).toContain("pm_copy");
    // pm-v68d/pm-7u9j: workspace-configuration and append narrow tools.
    expect(result.instructions).toContain("pm_schema");
    expect(result.instructions).toContain("pm_config");
    expect(result.instructions).toContain("pm_append");
    expect(result.capabilities).toMatchObject({ tools: {} });
  });

  it("tools/list returns exactly the 25 expected tools including the new narrow tools", async () => {
    const result = (await handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as { tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }> };

    const tools = result.tools ?? [];
    expect(tools).toHaveLength(25);

    const names = tools.map((tool) => tool.name);
    expect(new Set(names)).toEqual(new Set(EXPECTED_TOOL_NAMES));
    // No duplicates.
    expect(names.length).toBe(new Set(names).size);

    // Every tool carries a non-empty description and an object input schema.
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect((tool.description ?? "").length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("builds stable sorted MCP tool contracts with required fields", () => {
    const contracts = buildMcpToolContracts();
    expect(contracts.map((contract) => contract.name)).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(contracts.every((contract) => contract.input_schema.type === "object")).toBe(true);
    expect(contracts.find((contract) => contract.name === "pm_run")).toMatchObject({
      required: ["action"],
      input_schema: {
        properties: expect.objectContaining({
          action: expect.objectContaining({
            type: "string",
            description: expect.stringContaining(PM_TOOL_ACTIONS[0]),
          }),
        }),
      },
    });
    expect(contracts.find((contract) => contract.name === "pm_create")?.required).toEqual(["options"]);
    expect(contracts.find((contract) => contract.name === "pm_health")?.required).toEqual([]);
  });

  it("treats malformed required schema fields as optional in MCP contracts", () => {
    const target = TOOLS.find((tool) => tool.name === "pm_health");
    expect(target).toBeDefined();
    const schema = target!.inputSchema as Record<string, unknown>;
    const originalRequired = schema.required;
    try {
      schema.required = "not-an-array";
      const contracts = buildMcpToolContracts();
      expect(contracts.find((contract) => contract.name === "pm_health")?.required).toEqual([]);
    } finally {
      schema.required = originalRequired;
    }
  });

  it("covers MCP option normalization and typo warning helpers", () => {
    expect(mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_create", [] as never)).toEqual([]);
    expect(mcpServerTestOnly.normalizeMcpOptionsArrays({ tags: ["a", "b"], fields: ["id", "title"] })).toEqual({
      tags: "a,b",
      fields: "id,title",
    });
    expect(mcpServerTestOnly.normalizeMcpOptionsArrays({ tag: ["a", "b"], role: "active", add: "file" }, "files")).toEqual({
      tag: ["a", "b"],
      role: "active",
      add: ["file"],
    });
    expect(mcpServerTestOnly.normalizeMcpOptionsArrays({ remove: "src/old.ts" }, "docs")).toEqual({ remove: ["src/old.ts"] });
    expect(mcpServerTestOnly.normalizeMcpOptionsArrays({ add: "plain" })).toEqual({ add: "plain" });
    expect(mcpServerTestOnly.normalizeMcpOptionsArrays({ add: "comment" }, "comments")).toEqual({ add: "comment" });
    expect(mcpServerTestOnly.withAddNoteOption({ note: "already-set" })).toEqual({ note: "already-set" });
    expect(mcpServerTestOnly.withAddNoteOption({ addNote: 123, other: true })).toEqual({ other: true });
    expect(mcpServerTestOnly.withAddNoteOption({ addNote: "linked note" })).toEqual({ note: "linked note" });
    expect(mcpServerTestOnly.withAddNoteOption({ addNote: "ignored", note: "explicit" })).toEqual({ note: "explicit" });
    expect(
      mcpServerTestOnly.withFilesDiscoveryOptions({ discover: true, discoveryNote: "found", other: "kept" }),
    ).toEqual({ note: "found", other: "kept" });
    expect(mcpServerTestOnly.withFilesDiscoveryOptions({ discoveryNote: "ignored", note: "explicit" })).toEqual({ note: "explicit" });
    expect(mcpServerTestOnly.nearestDeclaredKey("optons", ["options", "author"])).toBe("options");
    expect(mcpServerTestOnly.nearestDeclaredKey("zzzzzz", ["options", "author"])).toBeUndefined();
    expect(mcpServerTestOnly.readScalarString({ value: 42 }, "value")).toBe("42");
    expect(mcpServerTestOnly.readScalarString({ value: Number.POSITIVE_INFINITY }, "value")).toBeUndefined();
    expect(mcpServerTestOnly.readScalarString({ value: false }, "value")).toBeUndefined();
    expect(mcpServerTestOnly.readScalarString({ value: "" }, "value")).toBeUndefined();
    expect(mcpServerTestOnly.readScalarStringAllowBlank({ value: 7 }, "value")).toBe("7");
    expect(mcpServerTestOnly.readScalarStringAllowBlank({ value: Number.NaN }, "value")).toBeUndefined();
    expect(mcpServerTestOnly.readScalarStringAllowBlank({ value: "" }, "value")).toBe("");
    expect(() => mcpServerTestOnly.readRequiredString({}, "action")).toThrow(/Missing required argument: action/);
    expect(mcpServerTestOnly.readRequiredString({ action: "run" }, "action")).toBe("run");
    expect(mcpServerTestOnly.readStringArray("not-array")).toEqual([]);
    expect(mcpServerTestOnly.readStringArray(["one", 2, ""])).toEqual(["one", "2"]);
    expect(mcpServerTestOnly.normalizeActionName("  History Repair! ")).toBe("history-repair");
    expect(mcpServerTestOnly.normalizeCommandPath("  Foo   Bar ")).toBe("foo bar");
    expect(mcpServerTestOnly.normalizeCommandPath(" /Foo.Bar_baz/ ")).toBe("/foo.bar_baz/");
    expect(mcpServerTestOnly.globalOptions({ path: "/tmp/pm-mcp", noExtensions: true })).toMatchObject({
      json: true,
      quiet: true,
      noPager: true,
      path: "/tmp/pm-mcp",
    });
    expect(mcpServerTestOnly.extensionOptionsFromArgs({ action: "x", custom: "arg", args: ["kept"] }, { custom: "option" })).toEqual({
      custom: "option",
    });
    expect(mcpServerTestOnly.optionsWithAuthor({ action: "files", options: { add: "src/a.ts" }, author: "agent" }, "files")).toEqual({
      add: ["src/a.ts"],
      author: "agent",
    });
    expect(mcpServerTestOnly.optionsWithAuthor({ status: "open", limit: 5, options: { status: "closed" } }, "list")).toEqual({
      status: "closed",
      limit: 5,
    });
    expect(mcpServerTestOnly.optionsWithAuthor({ query: "sdk", mode: "hybrid", options: {} }, "search")).toEqual({
      mode: "hybrid",
    });
    expect(mcpServerTestOnly.optionsWithAuthor({ allowMissingParent: true, options: {} }, "create")).toEqual({
      allowMissingParent: true,
    });
    expect(mcpServerTestOnly.optionsWithAuthor({ duplicateOf: "pm-old", options: {} }, "close")).toEqual({
      duplicateOf: "pm-old",
    });
    expect(mcpServerTestOnly.optionsWithAuthor({ body: "append body", options: {} }, "append")).toEqual({ body: "append body" });
    expect(mcpServerTestOnly.optionsWithAuthor({ author: "agent", options: { author: "explicit" } }, "create")).toEqual({
      author: "explicit",
    });
    expect(mcpServerTestOnly.optionsWithAuthor({ options: { add: "src/a.ts" } }, "docs")).toEqual({ add: ["src/a.ts"] });
    expect(mcpServerTestOnly.optionsWithAuthor({ options: { add: "keep-scalar" } }, "notes")).toEqual({ add: "keep-scalar" });
    expect(mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_run", { typo: true })).toEqual([]);
    expect(mcpServerTestOnly.detectUnexpectedTopLevelKeys("unknown_tool", { typo: true })).toEqual([]);
    expect(mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_create", { options: {} })).toEqual([]);
    expect(mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_create", { optons: {} })[0]).toContain('did you mean "options"');
    expect(mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_create", { totallyDifferent: true })[0]).toContain(
      "Unexpected top-level argument",
    );
    expect(mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_update", { authar: "agent", author: "kept" })[0]).toContain(
      'did you mean "author"',
    );
  });

  it("covers MCP mutation option builders for flat package actions", () => {
    expect(
      mcpServerTestOnly.mutationListOptions({
        filterType: "Task",
        filterTag: "sdk",
        filterPriority: 2,
        filterDeadlineBefore: "2026-12-31",
        filterDeadlineAfter: "2026-01-01",
        filterUpdatedAfter: "2026-02-01",
        filterUpdatedBefore: "2026-03-01",
        filterCreatedAfter: "2026-04-01",
        filterCreatedBefore: "2026-05-01",
        ids: "",
        filterAssignee: "agent",
        filterAssignee_filter: "unassigned",
        filterParent: "pm-parent",
        filterSprint: "S1",
        filterRelease: "R1",
        limit: 5,
        offset: 1,
      }),
    ).toMatchObject({
      type: "Task",
      tag: "sdk",
      priority: "2",
      deadlineBefore: "2026-12-31",
      ids: "",
      assignee: "agent",
      assigneeFilter: "unassigned",
      parent: "pm-parent",
      sprint: "S1",
      release: "R1",
      limit: "5",
      offset: "1",
    });
    expect(
      mcpServerTestOnly.closeManyOptionsFromFlat({
        filterStatus: "open",
        reason: "done",
        expected_result: "expected",
        actual_result: "actual",
        validate_close: "warn",
        author: "agent",
        message: "close many",
        force: true,
        dry_run: true,
        rollback: "checkpoint",
        no_checkpoint: true,
      }),
    ).toMatchObject({
      status: "open",
      reason: "done",
      expectedResult: "expected",
      actualResult: "actual",
      validateClose: "warn",
      author: "agent",
      message: "close many",
      force: true,
      dryRun: true,
      rollback: "checkpoint",
      checkpoint: false,
    });
    expect(
      mcpServerTestOnly.closeManyOptionsFromFlat({
        list: { status: "open", type: "Issue" },
        expected: "fallback expected",
        actualResult: "actual camel",
        validateClose: "strict",
      }),
    ).toMatchObject({
      expectedResult: "fallback expected",
      actualResult: "actual camel",
      validateClose: "strict",
      list: expect.objectContaining({ status: "open", type: "Issue" }),
    });
    expect(
      mcpServerTestOnly.normalizeMcpUpdateOptions({
        priority: 1,
        deadline: 20260613,
        tags: ["coverage", "mcp"],
        unset: "assignee",
      }),
    ).toMatchObject({
      priority: "1",
      deadline: "20260613",
      tags: "coverage,mcp",
      unset: ["assignee"],
    });
    expect(
      mcpServerTestOnly.updateManyOptionsFromFlat({
        filterStatus: "open",
        filterAssigneeFilter: "assigned",
        priority: 3,
        title: "bulk",
        dryRun: true,
        noCheckpoint: true,
      }),
    ).toMatchObject({
      status: "open",
      list: expect.objectContaining({ assigneeFilter: "assigned" }),
      update: expect.objectContaining({ priority: "3", title: "bulk" }),
      dryRun: true,
      checkpoint: false,
    });
    expect(
      mcpServerTestOnly.updateManyOptionsFromFlat({
        list: { status: "open", type: "Task" },
        update: { priority: 4 },
        dry_run: true,
        checkpoint: false,
      }),
    ).toMatchObject({
      list: expect.objectContaining({ status: "open", type: "Task" }),
      update: expect.objectContaining({ priority: "4" }),
      dryRun: true,
      checkpoint: false,
    });
    expect(mcpServerTestOnly.withMutationCompaction({ fullChangedFields: true, idOnly: true }, { title: "x" })).toEqual({
      changedFields: "full",
      idOnly: true,
      runnerOptions: { title: "x" },
    });
    expect(mcpServerTestOnly.withMutationCompaction({}, null)).toEqual({
      changedFields: "compact",
      idOnly: false,
      runnerOptions: {},
    });
  });

  it("pm_run action description is derived from PM_TOOL_ACTIONS (pm-fd8n)", async () => {
    const result = (await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    })) as { tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, { description?: string }> } }> };

    const pmRun = (result.tools ?? []).find((tool) => tool.name === "pm_run");
    const actionDescription = pmRun?.inputSchema?.properties?.action?.description ?? "";
    // Every canonical action must appear in the generated enumeration; the
    // string can never drift from PM_TOOL_ACTIONS since it is joined from it.
    for (const action of PM_TOOL_ACTIONS) {
      expect(actionDescription).toContain(action);
    }
    // The trailing package-owned prose is preserved.
    expect(actionDescription).toContain("Package-owned actions");
  });

  it("tools/call with an unknown tool name yields a clear error", async () => {
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "pm_not_a_real_tool", arguments: {} },
      }),
    ).rejects.toThrow(/Unknown pm MCP tool: pm_not_a_real_tool/);
  });

  it("pm_context defaults to a brief compact snapshot and honors depth overrides", async () => {
    await withTempPmPath((context) => assertPmContextDepthProjection(context, "MCP context projection target"));
  });

  it("pm_health defaults to the compact summary projection and full=true opts into detail (F2)", async () => {
    await withTempPmPath(async (context) => {
      const callHealth = (options: Record<string, unknown>) =>
        handleRequest({
          jsonrpc: "2.0",
          id: 70,
          method: "tools/call",
          params: { name: "pm_health", arguments: { path: context.pmPath, options } },
        }) as Promise<{
          structuredContent?: {
            result?: { projection?: { mode?: string }; checks?: Array<{ details?: Record<string, unknown> }> };
          };
        }>;

      // No projection flag -> summary by default (ok + per-check status only).
      const summary = await callHealth({});
      expect(summary.structuredContent?.result?.projection?.mode).toBe("summary");
      for (const check of summary.structuredContent?.result?.checks ?? []) {
        expect(Object.keys(check.details ?? {})).toHaveLength(0);
      }

      // full=true opts back into the deep payload with populated check details.
      const full = await callHealth({ full: true });
      expect(full.structuredContent?.result?.projection?.mode).not.toBe("summary");
      const fullChecks = full.structuredContent?.result?.checks ?? [];
      expect(fullChecks.some((check) => Object.keys(check.details ?? {}).length > 0)).toBe(true);
    });
  });

  it("routes pm_files discover/apply options through file discovery (pm-wcaa)", async () => {
    await withTempPmPath(async (context) => {
      const projectRoot = path.join(context.tempRoot, "workspace");
      await mkdir(path.join(projectRoot, "src"), { recursive: true });
      await writeFile(path.join(projectRoot, "src", "mcp-discovered.ts"), "export const mcpDiscovered = true;\n", "utf8");

      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "MCP files discover target",
          "--description",
          "MCP files discover target description",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "mcp-test",
        ],
        { expectJson: true, cwd: projectRoot },
      );
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const update = context.runCli(
        [
          "update",
          id,
          "--json",
          "--body",
          "Implementation references src/mcp-discovered.ts.",
          "--author",
          "mcp-test",
          "--message",
          "Seed MCP discovery body",
        ],
        { expectJson: true, cwd: projectRoot },
      );
      expect(update.code).toBe(0);

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
      try {
        const result = (await handleRequest({
          jsonrpc: "2.0",
          id: 72,
          method: "tools/call",
          params: {
            name: "pm_files",
            arguments: {
              path: context.pmPath,
              id,
              options: {
                discover: true,
                apply: true,
                discoveryNote: "linked through MCP discovery",
                message: "Apply MCP discovered files",
              },
            },
          },
        })) as {
          isError?: boolean;
          structuredContent?: {
            result?: {
              changed?: boolean;
              added_count?: number;
              files?: Array<{ path?: string; scope?: string; note?: string }>;
            };
          };
        };

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent?.result?.changed).toBe(true);
        expect(result.structuredContent?.result?.added_count).toBe(1);
        expect(result.structuredContent?.result?.files).toContainEqual(
          expect.objectContaining({
            path: "src/mcp-discovered.ts",
            scope: "project",
            note: "linked through MCP discovery",
          }),
        );
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });

  it("error envelope keeps structuredContent.result present (null) for uniform parsing (pm-l40h)", async () => {
    await withTempPmPath(async (context) => {
      const writes: string[] = [];
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
      try {
        await processRpcLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 71,
            method: "tools/call",
            params: { name: "pm_get", arguments: { path: context.pmPath, id: "pm-does-not-exist" } },
          }),
        );
      } finally {
        write.mockRestore();
      }
      const response = JSON.parse(writes.join("")) as {
        result?: { isError?: boolean; structuredContent?: { result?: unknown; error?: unknown; code?: unknown } };
      };
      expect(response.result?.isError).toBe(true);
      // `result` must always be present so a consumer can read structuredContent.result uniformly.
      expect(response.result?.structuredContent).toHaveProperty("result", null);
      expect(typeof response.result?.structuredContent?.error).toBe("string");
      expect(typeof response.result?.structuredContent?.code).toBe("number");
    });
  });

  it("warns on a typo'd top-level key but not on a clean call (pm-qxwu)", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Typo warning target",
          "--description",
          "Typo warning target description",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "mcp-test",
        ],
        { expectJson: true },
      );
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      // Clean call: all top-level keys are declared -> no warnings, no stderr.
      const cleanErr = vi.spyOn(console, "error").mockImplementation(() => {});
      let cleanResult: { structuredContent?: { warnings?: unknown; result?: unknown } } | undefined;
      try {
        cleanResult = (await handleRequest({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "pm_update",
            arguments: {
              path: context.pmPath,
              id,
              author: "mcp-test",
              fullChangedFields: true,
              options: { priority: "1", message: "clean update" },
            },
          },
        })) as { structuredContent?: { warnings?: unknown; result?: unknown } };
        // No pm-mcp unexpected-key warning should be emitted for a clean call.
        const cleanStderr = cleanErr.mock.calls.map((call) => String(call[0])).join("\n");
        expect(cleanStderr).not.toContain("[pm-mcp]");
      } finally {
        cleanErr.mockRestore();
      }
      expect(cleanResult?.structuredContent?.warnings).toBeUndefined();
      expect(cleanResult?.structuredContent?.result).toBeDefined();

      // Typo'd call: `fullChangedField` is a near-miss of `fullChangedFields`.
      const typoErr = vi.spyOn(console, "error").mockImplementation(() => {});
      let typoResult: { structuredContent?: { warnings?: string[]; result?: unknown } } | undefined;
      try {
        typoResult = (await handleRequest({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "pm_update",
            arguments: {
              path: context.pmPath,
              id,
              author: "mcp-test",
              fullChangedField: true,
              options: { priority: "2", message: "typo update" },
            },
          },
        })) as { structuredContent?: { warnings?: string[]; result?: unknown } };
        // Warning surfaced to stderr.
        expect(typoErr).toHaveBeenCalled();
        const stderrText = typoErr.mock.calls.map((call) => String(call[0])).join("\n");
        expect(stderrText).toContain("fullChangedField");
        expect(stderrText).toContain("fullChangedFields");
      } finally {
        typoErr.mockRestore();
      }

      // Warning surfaced additively in structuredContent, result still present.
      const warnings = typoResult?.structuredContent?.warnings;
      expect(Array.isArray(warnings)).toBe(true);
      expect(warnings?.some((w) => w.includes("fullChangedField") && w.includes("fullChangedFields"))).toBe(true);
      expect(typoResult?.structuredContent?.result).toBeDefined();
    });
  });

  it("hoists declared top-level pm_list/pm_search filters and preserves options precedence (pm-jozc)", async () => {
    await withTempPmPath(async (context) => {
      const targetCreate = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Top-level filter marker target task",
          "--description",
          "Top-level filter marker target task description",
          "--type",
          "Task",
          "--status",
          "open",
          "--tags",
          "mcp-top-level-filter-target",
          "--author",
          "mcp-test",
        ],
        { expectJson: true },
      );
      expect(targetCreate.code).toBe(0);
      const targetId = (targetCreate.json as { item: { id: string } }).item.id;

      const distractorCreate = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Top-level filter marker distractor issue",
          "--description",
          "Top-level filter marker distractor issue description",
          "--type",
          "Issue",
          "--status",
          "open",
          "--tags",
          "mcp-top-level-filter-target",
          "--author",
          "mcp-test",
        ],
        { expectJson: true },
      );
      expect(distractorCreate.code).toBe(0);

      const topLevelList = await handleRequest({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "pm_list",
          arguments: {
            path: context.pmPath,
            status: "open",
            type: "Task",
            tag: "mcp-top-level-filter-target",
            limit: 1,
          },
        },
      });
      expect(topLevelList?.isError).not.toBe(true);
      const topLevelListContent = topLevelList?.structuredContent as {
        warnings?: string[];
        result?: {
          count?: number;
          items?: Array<{ id?: string; type?: string }>;
        };
      } | undefined;
      expect(topLevelListContent?.warnings).toBeUndefined();
      expect(topLevelListContent?.result?.count).toBe(1);
      expect(topLevelListContent?.result?.items).toEqual([
        expect.objectContaining({ id: targetId, type: "Task" }),
      ]);

      const optionsOverrideList = await handleRequest({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "pm_list",
          arguments: {
            path: context.pmPath,
            // Top-level type is intentionally contradictory; nested options must win.
            type: "Issue",
            options: {
              status: "open",
              type: "Task",
              tag: "mcp-top-level-filter-target",
            },
          },
        },
      });
      expect(optionsOverrideList?.isError).not.toBe(true);
      const optionsOverrideContent = optionsOverrideList?.structuredContent as {
        warnings?: string[];
        result?: {
          count?: number;
          items?: Array<{ id?: string; type?: string }>;
        };
      } | undefined;
      expect(optionsOverrideContent?.warnings).toBeUndefined();
      expect(optionsOverrideContent?.result?.count).toBe(1);
      expect(optionsOverrideContent?.result?.items).toEqual([
        expect.objectContaining({ id: targetId, type: "Task" }),
      ]);

      const topLevelSearch = await handleRequest({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "pm_search",
          arguments: {
            path: context.pmPath,
            query: "top-level filter marker",
            type: "Task",
            tag: "mcp-top-level-filter-target",
            limit: 1,
          },
        },
      });
      expect(topLevelSearch?.isError).not.toBe(true);
      const topLevelSearchContent = topLevelSearch?.structuredContent as {
        warnings?: string[];
        result?: {
          count?: number;
          items?: Array<{ id?: string; title?: string }>;
        };
      } | undefined;
      expect(topLevelSearchContent?.warnings).toBeUndefined();
      expect(topLevelSearchContent?.result?.count).toBe(1);
      expect(topLevelSearchContent?.result?.items).toEqual([
        expect.objectContaining({ id: targetId, title: "Top-level filter marker target task" }),
      ]);
    });
  });

  it("pm_append appends body text with compact mutation output (pm-7u9j)", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Append tool target",
          "--description",
          "Append tool target description",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "mcp-test",
        ],
        { expectJson: true },
      );
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const appendResult = (await handleRequest({
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: {
          name: "pm_append",
          arguments: { path: context.pmPath, id, author: "mcp-test", body: "Evidence: append narrow tool works." },
        },
      })) as { isError?: boolean; structuredContent?: { warnings?: unknown; result?: Record<string, unknown> } };
      expect(appendResult?.isError).not.toBe(true);
      // Declared top-level body must not trip the unexpected-key warning.
      expect(appendResult?.structuredContent?.warnings).toBeUndefined();
      // Compact-by-default mutation projection: count instead of changed_fields.
      expect(appendResult?.structuredContent?.result?.changed_field_count).toBe(1);
      expect(appendResult?.structuredContent?.result?.changed_fields).toBeUndefined();

      const got = (await handleRequest({
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: { name: "pm_get", arguments: { path: context.pmPath, id, options: { depth: "full" } } },
      })) as { structuredContent?: { result?: { body?: string } } };
      expect(got.structuredContent?.result?.body).toContain("Evidence: append narrow tool works.");
    });
  });

  it("pm_schema and pm_config drive workspace configuration natively (pm-v68d)", async () => {
    await withTempPmPath(async (context) => {
      const schemaList = (await handleRequest({
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: { name: "pm_schema", arguments: { path: context.pmPath, subcommand: "list" } },
      })) as { isError?: boolean; structuredContent?: { warnings?: unknown; result?: { builtin?: unknown[] } } };
      expect(schemaList?.isError).not.toBe(true);
      expect(schemaList?.structuredContent?.warnings).toBeUndefined();
      expect(Array.isArray(schemaList?.structuredContent?.result?.builtin)).toBe(true);

      const addType = (await handleRequest({
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            subcommand: "add-type",
            name: "Story",
            description: "User story",
            author: "mcp-test",
          },
        },
      })) as { isError?: boolean; structuredContent?: { warnings?: unknown; result?: { registered?: boolean; type?: { name?: string } } } };
      expect(addType?.isError).not.toBe(true);
      expect(addType?.structuredContent?.warnings).toBeUndefined();
      expect(addType?.structuredContent?.result?.registered).toBe(true);
      expect(addType?.structuredContent?.result?.type?.name).toBe("Story");

      const addStatus = (await handleRequest({
        jsonrpc: "2.0",
        id: 511,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            subcommand: "add-status",
            name: "ready",
            role: "active",
            alias: "rdy",
            order: "7",
            description: "Ready for MCP work",
            author: "mcp-test",
          },
        },
      })) as { isError?: boolean; structuredContent?: { warnings?: unknown; result?: { registered?: boolean } } };
      expect(addStatus?.isError).not.toBe(true);
      expect(addStatus?.structuredContent?.warnings).toBeUndefined();
      expect(addStatus?.structuredContent?.result?.registered).toBe(true);

      const addStatusFromOptions = (await handleRequest({
        jsonrpc: "2.0",
        id: 514,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            options: {
              subcommand: "add-status",
              name: "qa_ready",
              role: ["active"],
              alias: ["qa"],
              order: 8,
              description: "Ready for QA",
              author: "mcp-test",
            },
          },
        },
      })) as { isError?: boolean; structuredContent?: { result?: { registered?: boolean } } };
      expect(addStatusFromOptions?.isError).not.toBe(true);
      expect(addStatusFromOptions?.structuredContent?.result?.registered).toBe(true);

      const showStatusFromOptions = (await handleRequest({
        jsonrpc: "2.0",
        id: 515,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            options: {
              subcommand: "show-status",
              name: "qa_ready",
            },
          },
        },
      })) as { isError?: boolean; structuredContent?: { result?: { status?: { id?: string } } } };
      expect(showStatusFromOptions?.isError).not.toBe(true);
      expect(showStatusFromOptions?.structuredContent?.result?.status?.id).toBe("qa_ready");

      const removeStatus = (await handleRequest({
        jsonrpc: "2.0",
        id: 516,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            subcommand: "remove-status",
            name: "qa_ready",
            author: "mcp-test",
          },
        },
      })) as { isError?: boolean; structuredContent?: { result?: { removed?: boolean } } };
      expect(removeStatus?.isError).not.toBe(true);
      expect(removeStatus?.structuredContent?.result?.removed).toBe(true);

      const removeType = (await handleRequest({
        jsonrpc: "2.0",
        id: 517,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            subcommand: "remove-type",
            name: "Story",
            author: "mcp-test",
          },
        },
      })) as { isError?: boolean; structuredContent?: { result?: { removed?: boolean } } };
      expect(removeType?.isError).not.toBe(true);
      expect(removeType?.structuredContent?.result?.removed).toBe(true);

      await expect(
        handleRequest({
          jsonrpc: "2.0",
          id: 512,
          method: "tools/call",
          params: {
            name: "pm_schema",
            arguments: {
              path: context.pmPath,
              subcommand: "add-status",
              name: "blocked",
              order: "1.5",
              author: "mcp-test",
            },
          },
        }),
      ).rejects.toThrow("schema add-status order must be a finite integer");

      await expect(
        handleRequest({
          jsonrpc: "2.0",
          id: 513,
          method: "tools/call",
          params: {
            name: "pm_schema",
            arguments: {
              path: context.pmPath,
              subcommand: "missing-subcommand",
              name: "Story",
              author: "mcp-test",
            },
          },
        }),
      ).rejects.toThrow('Unknown pm schema subcommand "missing-subcommand"');

      const configSet = (await handleRequest({
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: {
          name: "pm_config",
          arguments: {
            path: context.pmPath,
            configAction: "set",
            key: "governance-require-close-reason",
            value: "true",
            author: "mcp-test",
          },
        },
      })) as { isError?: boolean; structuredContent?: { warnings?: unknown; result?: { policy?: string } } };
      expect(configSet?.isError).not.toBe(true);
      expect(configSet?.structuredContent?.warnings).toBeUndefined();
      expect(configSet?.structuredContent?.result?.policy).toBe("enabled");

      const configGet = (await handleRequest({
        jsonrpc: "2.0",
        id: 53,
        method: "tools/call",
        params: {
          name: "pm_config",
          arguments: { path: context.pmPath, configAction: "get", key: "governance-require-close-reason" },
        },
      })) as { isError?: boolean; structuredContent?: { result?: { policy?: string } } };
      expect(configGet?.isError).not.toBe(true);
      expect(configGet?.structuredContent?.result?.policy).toBe("enabled");
    });
  });

  it("pm_list/pm_search echo applied filters and projection in query_summary (pm-rmjy)", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Query summary marker task",
          "--description",
          "Query summary marker task description",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "mcp-test",
        ],
        { expectJson: true },
      );
      expect(create.code).toBe(0);

      const list = (await handleRequest({
        jsonrpc: "2.0",
        id: 60,
        method: "tools/call",
        params: {
          name: "pm_list",
          arguments: { path: context.pmPath, status: "open", type: "Task", limit: 5 },
        },
      })) as { structuredContent?: { result?: { query_summary?: { filters?: Record<string, unknown>; projection?: string } } } };
      const listSummary = list.structuredContent?.result?.query_summary;
      expect(listSummary?.projection).toBe("compact");
      expect(listSummary?.filters).toMatchObject({ status: "open", type: "Task" });

      const briefList = (await handleRequest({
        jsonrpc: "2.0",
        id: 61,
        method: "tools/call",
        params: {
          name: "pm_list",
          arguments: { path: context.pmPath, options: { brief: true } },
        },
      })) as { structuredContent?: { result?: { query_summary?: { projection?: string } } } };
      expect(briefList.structuredContent?.result?.query_summary?.projection).toBe("brief");

      const search = (await handleRequest({
        jsonrpc: "2.0",
        id: 62,
        method: "tools/call",
        params: {
          name: "pm_search",
          arguments: { path: context.pmPath, query: "query summary marker", type: "Task" },
        },
      })) as { structuredContent?: { result?: { query_summary?: { filters?: Record<string, unknown>; projection?: string } } } };
      const searchSummary = search.structuredContent?.result?.query_summary;
      expect(searchSummary?.projection).toBe("compact");
      expect(searchSummary?.filters).toMatchObject({ type: "Task" });
    });
  });

  it("does not warn on unexpected top-level keys for pm_run (catch-all passthrough)", async () => {
    await withTempPmPath(async (context) => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      let result: { structuredContent?: { warnings?: unknown } } | undefined;
      try {
        result = (await handleRequest({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "pm_run",
            arguments: {
              path: context.pmPath,
              action: "context",
              // Arbitrary extra top-level key would be a typo for a narrow tool
              // but is legitimate extension passthrough for pm_run.
              somePassthroughKey: "value",
              options: { limit: "5" },
            },
          },
        })) as { structuredContent?: { warnings?: unknown } };
      } finally {
        spy.mockRestore();
      }
      expect(result?.structuredContent?.warnings).toBeUndefined();
    });
  });

  it("covers dynamic native-action guardrails and fallback resolution paths", async () => {
    await expect(
      mcpServerTestOnly.runAction({
        action: "dynamic-tool",
        path: path.join(process.cwd(), "tmp", "missing-pm-root"),
      }),
    ).rejects.toThrow("Unsupported native pm action: dynamic-tool");

    await withTempPmPath(async (context) => {
      await expect(
        mcpServerTestOnly.runAction({
          action: "dynamic-tool",
          path: context.pmPath,
          noExtensions: true,
        }),
      ).rejects.toThrow("Unsupported native pm action: dynamic-tool");
    });

    await withTempPmPath(async (context) => {
      const loadSpy = vi.spyOn(extensionLoader, "loadExtensions").mockResolvedValue({
        loaded: [],
        failed: [],
        warnings: [],
      } as never);
      const deactivateSpy = vi.spyOn(extensionLoader, "deactivateExtensions").mockRejectedValue(new Error("deactivate failed"));
      const activateSpy = vi.spyOn(extensionLoader, "activateExtensions").mockResolvedValue({
        hooks: createEmptyExtensionHookRegistry(),
        commands: {
          ...createEmptyExtensionCommandRegistry(),
          handlers: [
            {
              layer: "project",
              name: "late-handler",
              command: "dynamic tool",
              run: async () => ({ ok: true }),
            },
          ],
        },
        parsers: createEmptyExtensionParserRegistry(),
        preflight: createEmptyExtensionPreflightRegistry(),
        services: createEmptyExtensionServiceRegistry(),
        renderers: createEmptyExtensionRendererRegistry(),
        registrations: createEmptyExtensionRegistrationRegistry(),
      } as never);
      const handlerSpy = vi.spyOn(extensionRuntime, "runActiveCommandHandler").mockResolvedValue({
        handled: false,
        result: null,
        warnings: ["missing-handler"],
      });

      try {
        await expect(
          mcpServerTestOnly.runAction({
            action: "dynamic-tool",
            path: context.pmPath,
          }),
        ).rejects.toThrow("Unsupported native pm action: dynamic-tool (missing-handler)");
      } finally {
        handlerSpy.mockRestore();
        activateSpy.mockRestore();
        deactivateSpy.mockRestore();
        loadSpy.mockRestore();
      }
    });
  });

  it("covers init, history-redact, and schema-show action dispatch branches", async () => {
    await withTempPmPath(async (context) => {
      const initResult = (await mcpServerTestOnly.runAction({
        action: "init",
        path: context.pmPath,
        prefix: "pm-",
      })) as Record<string, unknown>;
      expect(typeof initResult).toBe("object");

      await expect(
        mcpServerTestOnly.runAction({
          action: "history-redact",
          path: context.pmPath,
          id: "pm-missing-history",
        }),
      ).rejects.toBeInstanceOf(Error);

      const schemaShow = (await mcpServerTestOnly.runAction({
        action: "schema",
        path: context.pmPath,
        subcommand: "show",
        name: "Task",
      })) as { action?: string };
      expect(schemaShow.action).toBe("show");
    });
  });

  it("returns an invalid-request error for non-object JSON-RPC lines", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let responseText = "";
    try {
      await processRpcLine("null");
      responseText = write.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      write.mockRestore();
    }
    expect(responseText).toContain('"id":null');
    expect(responseText).toContain('"code":-32600');
    expect(responseText).toContain("expected an object");
  });

  it("returns a JSON-RPC parse error for malformed JSON lines", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let responseText = "";
    try {
      await processRpcLine("{not-json");
      responseText = write.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      write.mockRestore();
    }
    expect(responseText).toContain('"id":null');
    expect(responseText).toContain('"code":-32700');
    expect(responseText).toContain("Parse error");
  });

  it("does not respond to JSON-RPC notifications that omit id", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await processRpcLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      await processRpcLine(JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }));
      await processRpcLine(JSON.stringify({ jsonrpc: "2.0", method: "not/supported" }));
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("writes success and non-tool error JSON-RPC envelopes", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let responses: string[] = [];
    try {
      await processRpcLine("");
      expect(write).not.toHaveBeenCalled();

      await processRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 90, method: "ping" }));
      await processRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 91, method: "not/supported" }));
      responses = write.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean);
    } finally {
      write.mockRestore();
    }

    expect(responses).toHaveLength(2);
    expect(JSON.parse(responses[0] ?? "{}")).toMatchObject({
      jsonrpc: "2.0",
      id: 90,
      result: {},
    });
    expect(JSON.parse(responses[1] ?? "{}")).toMatchObject({
      jsonrpc: "2.0",
      id: 91,
      error: {
        code: 64,
        message: "Unsupported MCP method: not/supported",
      },
    });
  });

  it("returns tool-call error envelopes for missing required request fields", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let responseText = "";
    try {
      await processRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 92, method: "tools/call", params: {} }));
      responseText = write.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      write.mockRestore();
    }

    const response = JSON.parse(responseText) as {
      result?: { isError?: boolean; structuredContent?: { result?: unknown; error?: string; code?: number } };
    };
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({
      result: null,
      error: "Missing required argument: name",
      code: 64,
    });
  });

  it("surfaces warnings for unexpected narrow-tool top-level arguments", async () => {
    await withTempPmPath(async (context) => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleRequest({
          jsonrpc: "2.0",
          id: 94,
          method: "tools/call",
          params: {
            name: "pm_list",
            arguments: { path: context.pmPath, limt: 3 },
          },
        });

        const structured = result?.structuredContent as { warnings?: string[] } | undefined;
        expect(structured?.warnings?.[0]).toContain('Unexpected top-level argument "limt"');
        expect(structured?.warnings?.[0]).toContain('did you mean "limit"');
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("[pm-mcp] Unexpected top-level argument"));
      } finally {
        stderr.mockRestore();
      }
    });
  });

  it("starts the stdio server with serialized line processing", async () => {
    let lineHandler: ((line: string) => void) | undefined;
    const fakeInterface = {
      on: vi.fn((event: string, handler: (line: string) => void) => {
        if (event === "line") {
          lineHandler = handler;
        }
        return fakeInterface;
      }),
    };
    const createInterface = vi.spyOn(readline, "createInterface").mockReturnValue(fakeInterface as never);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      startMcpServer();
      expect(createInterface).toHaveBeenCalledWith({ input: process.stdin, crlfDelay: Infinity });
      expect(fakeInterface.on).toHaveBeenCalledWith("line", expect.any(Function));
      lineHandler?.(JSON.stringify({ jsonrpc: "2.0", id: 93, method: "ping" }));
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
    } finally {
      write.mockRestore();
      createInterface.mockRestore();
    }
  });

  it("serializes pipelined same-item mutations so both succeed (pm-3puw)", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Pipelined mutation target",
          "--description",
          "Pipelined mutation target description",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "mcp-test",
        ],
        { expectJson: true },
      );
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      // Drive two mutations on the SAME item through the serial queue the stdio
      // transport wraps around each JSON-RPC line (startMcpServer enqueues
      // processRpcLine, which calls handleRequest). Before pm-3puw these ran
      // fire-and-forget/concurrently and the second hit a lock conflict;
      // serialized, the first releases the lock before the second begins so both
      // succeed. This mirrors a client that pipelines requests without awaiting.
      let callId = 100;
      const callTool = (toolName: string, options: Record<string, unknown>) =>
        handleRequest({
          jsonrpc: "2.0",
          id: callId++,
          method: "tools/call",
          params: {
            name: toolName,
            arguments: { path: context.pmPath, id, author: "mcp-test", options },
          },
        }) as Promise<{ structuredContent?: { result?: { count?: number } } }>;

      const queue = createSerialQueue();
      const first = queue.enqueue(() => callTool("pm_notes", { add: "serialized note" }));
      const second = queue.enqueue(() => callTool("pm_learnings", { add: "serialized learning" }));
      const [noteResult, learningResult] = await Promise.all([first, second]);

      // Neither call threw a lock conflict; both carry a structured result.
      expect(noteResult.structuredContent?.result).toBeDefined();
      expect(learningResult.structuredContent?.result).toBeDefined();

      // Both annotations actually landed on the item.
      const notes = await callTool("pm_notes", {});
      const learnings = await callTool("pm_learnings", {});
      expect(notes.structuredContent?.result?.count).toBe(1);
      expect(learnings.structuredContent?.result?.count).toBe(1);
    });
  });
});

describe("pm-mcp bin main-module detection (pm-qtbc)", () => {
  it("treats a symlinked argv[1] (npm .bin shim) as the main module", async () => {
    const { isInvokedAsMcpMainModule } = await import("../../src/mcp/server.js");
    const { mkdtemp, symlink: makeSymlink, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const selfPath = await realpath(fileURLToPath(new URL("../../src/mcp/server.ts", import.meta.url)));
    const moduleUrl = pathToFileURL(selfPath).href;
    const binDir = await mkdtemp(path.join(tmpdir(), "pm-mcp-bin-"));
    const shimPath = path.join(binDir, "pm-mcp");
    await makeSymlink(selfPath, shimPath);
    expect(isInvokedAsMcpMainModule(shimPath, moduleUrl)).toBe(true);
    expect(isInvokedAsMcpMainModule(selfPath, moduleUrl)).toBe(true);
    expect(isInvokedAsMcpMainModule(undefined, moduleUrl)).toBe(false);
    expect(isInvokedAsMcpMainModule(path.join(binDir, "missing"), moduleUrl)).toBe(false);
    expect(isInvokedAsMcpMainModule(path.join(binDir, "pm-mcp-other"), moduleUrl)).toBe(false);
  });

  it("serves an initialize response when launched through a symlinked npm-style bin", async () => {
    const { mkdtemp, symlink: makeSymlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const distServerPath = path.join(process.cwd(), "dist", "mcp", "server.js");
    const binDir = await mkdtemp(path.join(tmpdir(), "pm-mcp-bin-e2e-"));
    const shimPath = path.join(binDir, "pm-mcp");
    await makeSymlink(distServerPath, shimPath);

    const child = spawn(process.execPath, [shimPath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PM_NO_TELEMETRY: "1",
        PM_ANALYTICS_OPTOUT: "1",
      },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bin-smoke", version: "1.0.0" },
      },
    };
    child.stdin.end(`${JSON.stringify(initializeRequest)}\n`);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("timed out waiting for symlinked pm-mcp bin response"));
      }, 5_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.length).toBeGreaterThan(0);
    const response = JSON.parse(stdout.split(/\n/)[0] ?? "{}") as {
      result?: { serverInfo?: { name?: string }; protocolVersion?: string };
    };
    expect(response.result?.serverInfo?.name).toBe("pm-mcp");
    expect(response.result?.protocolVersion).toBe("2025-06-18");
  });
});
