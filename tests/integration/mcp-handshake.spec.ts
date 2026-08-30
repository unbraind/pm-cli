import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  _testOnly as mcpServerTestOnly,
  handleRequest,
  processRpcLine,
  startMcpServer,
} from "../../src/mcp/server.js";
import {
  TOOLS,
  buildMcpToolContracts,
} from "../../src/mcp/tool-definitions.js";
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
import { PM_MCP_LEGACY_PROTOCOL_VERSIONS } from "../../src/sdk/mcp/protocol.js";
import { createSerialQueue } from "../../src/core/shared/serial-queue.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import {
  GRAPH_SUBCOMMAND_VALUES,
  PM_DEPRECATED_TOOL_ACTIONS,
  PM_DISCOVERABLE_TOOL_ACTIONS,
} from "../../src/sdk/cli-contracts/enum-contracts.js";
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
  "pm_next",
  "pm_search",
  "pm_list",
  "pm_get",
  "pm_create",
  "pm_mutate",
  "pm_copy",
  "pm_focus",
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
  "pm_events",
  "pm_graph",
  "pm_test",
  "pm_validate",
  "pm_health",
  "pm_contracts",
  "pm_schema",
  "pm_profile",
  "pm_config",
  "pm_plan",
];

describe("MCP protocol handshake", () => {
  const originalMcpProfile = process.env.PM_MCP_PROFILE;

  beforeAll(() => {
    process.env.PM_MCP_PROFILE = "full";
  });

  afterAll(() => {
    if (originalMcpProfile === undefined) {
      delete process.env.PM_MCP_PROFILE;
    } else {
      process.env.PM_MCP_PROFILE = originalMcpProfile;
    }
  });

  it("handles ping with an empty result payload", async () => {
    expect(mcpServerTestOnly.getMcpClientInfo()).toBeUndefined();
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 0,
        method: "ping",
      }),
    ).resolves.toEqual({});
  });

  it("negotiates every declared legacy revision and echoes the requested one", async () => {
    // The revision list is read from the contract rather than restated, so this
    // test can never iterate a shorter set than the transport accepts.
    for (const version of PM_MCP_LEGACY_PROTOCOL_VERSIONS) {
      const result = (await handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: "handshake-matrix", version: "1.0.0" },
        },
      })) as { protocolVersion?: string };
      // A legacy client has no fall-forward mechanism: answering a version it
      // did not request strands it on a revision it never agreed to.
      expect(result.protocolVersion).toBe(version);
    }
  });

  it("offers the newest legacy revision when the client omits protocolVersion", async () => {
    const result = (await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "handshake-default", version: "1.0.0" },
      },
    })) as { protocolVersion?: string };
    expect(result.protocolVersion).toBe(PM_MCP_LEGACY_PROTOCOL_VERSIONS[0]);
  });

  it("refuses an undeclared revision and names every supported revision", async () => {
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "handshake-refusal", version: "1.0.0" },
        },
      }),
    ).rejects.toMatchObject({
      code: -32022,
      data: {
        supported: [...PM_MCP_LEGACY_PROTOCOL_VERSIONS],
        requested: "2025-03-26",
      },
    });
  });

  it("initialize returns protocolVersion, serverInfo, and instructions", async () => {
    const result = (await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "handshake-test",
          version: "1.0.0",
          provenance: { effort: "xhigh", role: "implementation" },
          episode: {
            id: "mcp-episode",
            label: "Boundary crossing",
            parent_id: "sdk-episode",
          },
        },
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
    expect(result.instructions).toContain("automatically");
    expect(result.instructions).not.toContain("claude-code-agent");
    expect(mcpServerTestOnly.getMcpClientInfo()).toEqual({
      name: "handshake-test",
      version: "1.0.0",
      provenance: { effort: "xhigh", role: "implementation" },
      episode: {
        id: "mcp-episode",
        label: "Boundary crossing",
        parent_id: "sdk-episode",
      },
    });
    expect(result.capabilities).toMatchObject({
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
    });

    await handleRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: {
        clientInfo: {
          name: "empty-provenance-test",
          provenance: { Invalid: "value", effort: "   " },
          episode: { id: "invalid episode id" },
        },
      },
    });
    expect(mcpServerTestOnly.getMcpClientInfo()).toEqual({
      name: "empty-provenance-test",
    });
    const inheritedProvenance = Object.assign(
      Object.create({ inherited: "must-not-be-retained" }) as Record<
        string,
        string
      >,
      Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `dimension-${index}`,
          `value-${index}`,
        ]),
      ),
    );
    expect(mcpServerTestOnly.boundMcpClientProvenance(undefined)).toEqual({});
    expect(
      mcpServerTestOnly.boundMcpClientProvenance(
        Object.create({ inherited: "must-not-be-retained" }) as Record<
          string,
          string
        >,
      ),
    ).toEqual({});
    expect(
      mcpServerTestOnly.boundMcpClientProvenance(inheritedProvenance),
    ).not.toHaveProperty("inherited");
    await handleRequest({
      jsonrpc: "2.0",
      id: 13,
      method: "initialize",
      params: {
        clientInfo: {
          name: "bounded-provenance-test",
          provenance: inheritedProvenance,
        },
      },
    });
    expect(
      Object.keys(mcpServerTestOnly.getMcpClientInfo()?.provenance ?? {}),
    ).toHaveLength(32);
    expect(mcpServerTestOnly.getMcpClientInfo()?.provenance).not.toHaveProperty(
      "inherited",
    );
    await handleRequest({
      jsonrpc: "2.0",
      id: 12,
      method: "initialize",
      params: {
        clientInfo: {
          name: "handshake-test",
          version: "1.0.0",
          provenance: { effort: "xhigh", role: "implementation" },
        },
      },
    });
  });

  it("tools/list returns exactly the 31 expected tools including the new narrow tools", async () => {
    const result = (await handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as {
      tools?: Array<{
        name?: string;
        description?: string;
        inputSchema?: unknown;
      }>;
    };

    const tools = result.tools ?? [];
    expect(tools).toHaveLength(31);

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
    expect(contracts.map((contract) => contract.name)).toEqual(
      [...EXPECTED_TOOL_NAMES].sort(),
    );
    expect(
      contracts.every((contract) => contract.input_schema.type === "object"),
    ).toBe(true);
    expect(
      contracts.find((contract) => contract.name === "pm_run"),
    ).toMatchObject({
      required: ["action"],
      input_schema: {
        properties: expect.objectContaining({
          action: expect.objectContaining({
            type: "string",
            description: expect.stringContaining(
              PM_DISCOVERABLE_TOOL_ACTIONS[0],
            ),
          }),
        }),
      },
    });
    expect(
      contracts.find((contract) => contract.name === "pm_create")?.required,
    ).toEqual(["options"]);
    expect(
      contracts.find((contract) => contract.name === "pm_mutate")?.required,
    ).toEqual(["mutations", "transactionId"]);
    expect(
      contracts.find((contract) => contract.name === "pm_health")?.required,
    ).toEqual([]);
  });

  it("keeps the pm_graph subcommand enum in lockstep with the shared contract", () => {
    const target = TOOLS.find((tool) => tool.name === "pm_graph");
    expect(target).toBeDefined();
    const schema = target!.inputSchema as {
      properties: { subcommand: { enum: string[] } };
    };
    // Regression for the pre-push Greptile P1: a hardcoded enum silently
    // dropped new subcommands, making them unreachable over MCP transport.
    expect(schema.properties.subcommand.enum).toEqual([
      ...GRAPH_SUBCOMMAND_VALUES,
    ]);
  });

  it("treats malformed required schema fields as optional in MCP contracts", () => {
    const target = TOOLS.find((tool) => tool.name === "pm_health");
    expect(target).toBeDefined();
    const schema = target!.inputSchema as Record<string, unknown>;
    const originalRequired = schema.required;
    try {
      schema.required = "not-an-array";
      const contracts = buildMcpToolContracts();
      expect(
        contracts.find((contract) => contract.name === "pm_health")?.required,
      ).toEqual([]);
    } finally {
      schema.required = originalRequired;
    }
  });

  it("covers MCP option normalization and typo warning helpers", () => {
    expect(
      mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_create", [] as never),
    ).toEqual([]);
    expect(
      mcpServerTestOnly.normalizeMcpOptionsArrays({
        tags: ["a", "b"],
        fields: ["id", "title"],
      }),
    ).toEqual({
      tags: "a,b",
      fields: "id,title",
    });
    expect(
      mcpServerTestOnly.normalizeMcpOptionsArrays(
        { tag: ["a", "b"], role: "active", add: "file" },
        "files",
      ),
    ).toEqual({
      tag: ["a", "b"],
      role: "active",
      add: ["file"],
    });
    expect(
      mcpServerTestOnly.normalizeMcpOptionsArrays(
        { remove: "src/old.ts" },
        "docs",
      ),
    ).toEqual({ remove: ["src/old.ts"] });
    expect(
      mcpServerTestOnly.normalizeMcpOptionsArrays({ add: "plain" }),
    ).toEqual({ add: "plain" });
    expect(
      mcpServerTestOnly.normalizeMcpOptionsArrays(
        { add: "comment", file: "-" },
        "comments",
      ),
    ).toEqual({ add: "comment", file: "-" });
    expect(
      mcpServerTestOnly.normalizeMcpOptionsArrays(
        { file: "src/index.ts" },
        "create",
      ),
    ).toEqual({ file: ["src/index.ts"] });
    expect(
      mcpServerTestOnly.withAddNoteOption({ note: "already-set" }),
    ).toEqual({ note: "already-set" });
    expect(
      mcpServerTestOnly.withAddNoteOption({ addNote: 123, other: true }),
    ).toEqual({ other: true });
    expect(
      mcpServerTestOnly.withAddNoteOption({ addNote: "linked note" }),
    ).toEqual({ note: "linked note" });
    expect(
      mcpServerTestOnly.withAddNoteOption({
        addNote: "ignored",
        note: "explicit",
      }),
    ).toEqual({ note: "explicit" });
    expect(
      mcpServerTestOnly.withFilesDiscoveryOptions({
        discover: true,
        discoveryNote: "found",
        other: "kept",
      }),
    ).toEqual({ note: "found", other: "kept" });
    expect(
      mcpServerTestOnly.withFilesDiscoveryOptions({
        discoveryNote: "ignored",
        note: "explicit",
      }),
    ).toEqual({ note: "explicit" });
    expect(
      mcpServerTestOnly.nearestDeclaredKey("optons", ["options", "author"]),
    ).toBe("options");
    expect(
      mcpServerTestOnly.nearestDeclaredKey("zzzzzz", ["options", "author"]),
    ).toBeUndefined();
    expect(mcpServerTestOnly.readScalarString({ value: 42 }, "value")).toBe(
      "42",
    );
    expect(
      mcpServerTestOnly.readScalarString(
        { value: Number.POSITIVE_INFINITY },
        "value",
      ),
    ).toBeUndefined();
    expect(
      mcpServerTestOnly.readScalarString({ value: false }, "value"),
    ).toBeUndefined();
    expect(
      mcpServerTestOnly.readScalarString({ value: "" }, "value"),
    ).toBeUndefined();
    expect(
      mcpServerTestOnly.readScalarStringAllowBlank({ value: 7 }, "value"),
    ).toBe("7");
    expect(
      mcpServerTestOnly.readScalarStringAllowBlank(
        { value: Number.NaN },
        "value",
      ),
    ).toBeUndefined();
    expect(
      mcpServerTestOnly.readScalarStringAllowBlank({ value: "" }, "value"),
    ).toBe("");
    expect(() => mcpServerTestOnly.readRequiredString({}, "action")).toThrow(
      /Missing required argument: action/,
    );
    expect(
      mcpServerTestOnly.readRequiredString({ action: "run" }, "action"),
    ).toBe("run");
    expect(mcpServerTestOnly.readStringArray("not-array")).toEqual([]);
    expect(mcpServerTestOnly.readStringArray(["one", 2, ""])).toEqual([
      "one",
      "2",
    ]);
    expect(mcpServerTestOnly.normalizeActionName("  History Repair! ")).toBe(
      "history-repair",
    );
    expect(mcpServerTestOnly.normalizeCommandPath("  Foo   Bar ")).toBe(
      "foo bar",
    );
    expect(mcpServerTestOnly.normalizeCommandPath(" /Foo.Bar_baz/ ")).toBe(
      "/foo.bar_baz/",
    );
    expect(
      mcpServerTestOnly.globalOptions({
        path: "/tmp/pm-mcp",
        noExtensions: true,
      }),
    ).toMatchObject({
      json: true,
      quiet: true,
      noPager: true,
      path: "/tmp/pm-mcp",
    });
    expect(
      mcpServerTestOnly.extensionOptionsFromArgs(
        { action: "x", custom: "arg", args: ["kept"] },
        { custom: "option" },
      ),
    ).toEqual({
      custom: "option",
    });
    expect(
      mcpServerTestOnly.optionsWithAuthor(
        { action: "files", options: { add: "src/a.ts" }, author: "agent" },
        "files",
      ),
    ).toEqual({
      add: ["src/a.ts"],
      author: "agent",
    });
    expect(
      mcpServerTestOnly.optionsWithAuthor(
        { status: "open", limit: 5, options: { status: "closed" } },
        "list",
      ),
    ).toEqual({
      status: "closed",
      limit: 5,
    });
    expect(
      mcpServerTestOnly.optionsWithAuthor(
        { query: "sdk", mode: "hybrid", options: {} },
        "search",
      ),
    ).toEqual({
      mode: "hybrid",
    });
    expect(
      mcpServerTestOnly.optionsWithAuthor(
        { allowMissingParent: true, options: {} },
        "create",
      ),
    ).toEqual({
      allowMissingParent: true,
    });
    expect(
      mcpServerTestOnly.optionsWithAuthor(
        { duplicateOf: "pm-old", options: {} },
        "close",
      ),
    ).toEqual({
      duplicateOf: "pm-old",
    });
    expect(
      mcpServerTestOnly.optionsWithAuthor(
        { body: "append body", options: {} },
        "append",
      ),
    ).toEqual({ body: "append body" });
    expect(
      mcpServerTestOnly.optionsWithAuthor(
        { author: "agent", options: { author: "explicit" } },
        "create",
      ),
    ).toEqual({
      author: "explicit",
    });
    expect(
      mcpServerTestOnly.optionsWithAuthor(
        { options: { add: "src/a.ts" } },
        "docs",
      ),
    ).toEqual({ add: ["src/a.ts"] });
    expect(
      mcpServerTestOnly.optionsWithAuthor(
        { options: { add: "keep-scalar" } },
        "notes",
      ),
    ).toEqual({ add: "keep-scalar" });
    expect(
      mcpServerTestOnly.optionsWithAuthor(
        { title: "not-hoisted", options: {} },
        "unknown-action",
      ),
    ).toEqual({});
    expect(
      mcpServerTestOnly.optionsWithAuthor({
        title: "not-hoisted",
        options: {},
      }),
    ).toEqual({});
    expect(
      mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_run", { typo: true }),
    ).toEqual([]);
    expect(
      mcpServerTestOnly.detectUnexpectedTopLevelKeys("unknown_tool", {
        typo: true,
      }),
    ).toEqual([]);
    expect(
      mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_create", {
        options: {},
      }),
    ).toEqual([]);
    expect(
      mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_create", {
        optons: {},
      })[0],
    ).toContain('did you mean "options"');
    expect(
      mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_create", {
        totallyDifferent: true,
      })[0],
    ).toContain("Unexpected top-level argument");
    expect(
      mcpServerTestOnly.detectUnexpectedTopLevelKeys("pm_update", {
        authar: "agent",
        author: "kept",
      })[0],
    ).toContain('did you mean "author"');
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
    expect(
      mcpServerTestOnly.withMutationCompaction(
        { fullChangedFields: true, idOnly: true },
        { title: "x" },
      ),
    ).toEqual({
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

  it("pm_run advertises canonical actions while legacy aliases stay SDK-compatible", async () => {
    const result = (await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    })) as {
      tools?: Array<{
        name?: string;
        inputSchema?: { properties?: Record<string, { description?: string }> };
      }>;
    };

    const pmRun = (result.tools ?? []).find((tool) => tool.name === "pm_run");
    const actionDescription =
      pmRun?.inputSchema?.properties?.action?.description ?? "";
    // Every canonical action must appear in the generated enumeration; the
    // string cannot drift because it is joined from the discoverable contract.
    for (const action of PM_DISCOVERABLE_TOOL_ACTIONS) {
      expect(actionDescription).toContain(action);
    }
    for (const action of PM_DEPRECATED_TOOL_ACTIONS) {
      expect(actionDescription).not.toMatch(
        new RegExp(`(?:^|, )${action}(?:,|\\.)`, "u"),
      );
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
    await withTempPmPath((context) =>
      assertPmContextDepthProjection(context, "MCP context projection target"),
    );
  });

  it("pm_next recommends the next ready item and lists blocked work with their blockers", async () => {
    await withTempPmPath(async (context) => {
      const ready = (
        context.runCli(
          [
            "create",
            "--json",
            "--title",
            "Ready leaf",
            "--type",
            "Task",
            "--priority",
            "0",
            "--body",
            "",
          ],
          { expectJson: true },
        ).json as { item: { id: string } }
      ).item.id;
      const blocker = (
        context.runCli(
          [
            "create",
            "--json",
            "--title",
            "Gate",
            "--type",
            "Task",
            "--body",
            "",
          ],
          { expectJson: true },
        ).json as { item: { id: string } }
      ).item.id;
      context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Waiting",
          "--type",
          "Task",
          "--dep",
          `id=${blocker},kind=blocked_by`,
          "--body",
          "",
        ],
        { expectJson: true },
      );

      const response = (await handleRequest({
        jsonrpc: "2.0",
        id: 71,
        method: "tools/call",
        params: { name: "pm_next", arguments: { path: context.pmPath } },
      })) as {
        structuredContent?: {
          result?: {
            recommended?: { id?: string } | null;
            ready?: Array<{ id?: string }>;
            blocked?: Array<{ id?: string; blockers?: Array<{ id?: string }> }>;
            summary?: { recommended?: boolean };
          };
        };
      };

      const result = response.structuredContent?.result;
      expect(result?.recommended?.id).toBe(ready);
      expect(result?.summary?.recommended).toBe(true);
      expect(result?.blocked?.[0]?.blockers?.[0]?.id).toBe(blocker);
    });
  });

  it("pm_health defaults to the compact summary projection and full=true opts into detail (F2)", async () => {
    await withTempPmPath(async (context) => {
      const callHealth = (options: Record<string, unknown>) =>
        handleRequest({
          jsonrpc: "2.0",
          id: 70,
          method: "tools/call",
          params: {
            name: "pm_health",
            arguments: { path: context.pmPath, options },
          },
        }) as Promise<{
          structuredContent?: {
            result?: {
              projection?: { mode?: string };
              checks?: Array<{ details?: Record<string, unknown> }>;
            };
          };
        }>;

      // No projection flag -> summary by default (ok + per-check status only).
      const summary = await callHealth({});
      expect(summary.structuredContent?.result?.projection?.mode).toBe(
        "summary",
      );
      for (const check of summary.structuredContent?.result?.checks ?? []) {
        expect(Object.keys(check.details ?? {})).toHaveLength(0);
      }

      // full=true opts back into the deep payload with populated check details.
      const full = await callHealth({ full: true });
      expect(full.structuredContent?.result?.projection?.mode).not.toBe(
        "summary",
      );
      const fullChecks = full.structuredContent?.result?.checks ?? [];
      expect(
        fullChecks.some((check) => Object.keys(check.details ?? {}).length > 0),
      ).toBe(true);
    });
  });

  it("routes pm_files discover/apply options through file discovery (pm-wcaa)", async () => {
    await withTempPmPath(async (context) => {
      const projectRoot = path.join(context.tempRoot, "workspace");
      await mkdir(path.join(projectRoot, "src"), { recursive: true });
      await writeFile(
        path.join(projectRoot, "src", "mcp-discovered.ts"),
        "export const mcpDiscovered = true;\n",
        "utf8",
      );

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
            path: "workspace/src/mcp-discovered.ts",
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
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: unknown) => {
          writes.push(String(chunk));
          return true;
        });
      try {
        await processRpcLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 71,
            method: "tools/call",
            params: {
              name: "pm_get",
              arguments: { path: context.pmPath, id: "pm-does-not-exist" },
            },
          }),
        );
      } finally {
        write.mockRestore();
      }
      const response = JSON.parse(writes.join("")) as {
        result?: {
          isError?: boolean;
          structuredContent?: {
            result?: unknown;
            error?: unknown;
            code?: unknown;
          };
        };
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
      let cleanResult:
        | { structuredContent?: { warnings?: unknown; result?: unknown } }
        | undefined;
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
        const cleanStderr = cleanErr.mock.calls
          .map((call) => String(call[0]))
          .join("\n");
        expect(cleanStderr).not.toContain("[pm-mcp]");
      } finally {
        cleanErr.mockRestore();
      }
      expect(cleanResult?.structuredContent?.warnings).toBeUndefined();
      expect(cleanResult?.structuredContent?.result).toBeDefined();

      // Typo'd call: `fullChangedField` is a near-miss of `fullChangedFields`.
      const typoErr = vi.spyOn(console, "error").mockImplementation(() => {});
      let typoResult:
        | { structuredContent?: { warnings?: string[]; result?: unknown } }
        | undefined;
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
        })) as {
          structuredContent?: { warnings?: string[]; result?: unknown };
        };
        // Warning surfaced to stderr.
        expect(typoErr).toHaveBeenCalled();
        const stderrText = typoErr.mock.calls
          .map((call) => String(call[0]))
          .join("\n");
        expect(stderrText).toContain("fullChangedField");
        expect(stderrText).toContain("fullChangedFields");
      } finally {
        typoErr.mockRestore();
      }

      // Warning surfaced additively in structuredContent, result still present.
      const warnings = typoResult?.structuredContent?.warnings;
      expect(Array.isArray(warnings)).toBe(true);
      expect(
        warnings?.some(
          (w) =>
            w.includes("fullChangedField") && w.includes("fullChangedFields"),
        ),
      ).toBe(true);
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
      const topLevelListContent = topLevelList?.structuredContent as
        | {
            warnings?: string[];
            result?: {
              count?: number;
              items?: Array<{ id?: string; type?: string }>;
            };
          }
        | undefined;
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
      const optionsOverrideContent = optionsOverrideList?.structuredContent as
        | {
            warnings?: string[];
            result?: {
              count?: number;
              items?: Array<{ id?: string; type?: string }>;
            };
          }
        | undefined;
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
      const topLevelSearchContent = topLevelSearch?.structuredContent as
        | {
            warnings?: string[];
            result?: {
              count?: number;
              items?: Array<{ id?: string; title?: string }>;
            };
          }
        | undefined;
      expect(topLevelSearchContent?.warnings).toBeUndefined();
      expect(topLevelSearchContent?.result?.count).toBe(1);
      expect(topLevelSearchContent?.result?.items).toEqual([
        expect.objectContaining({
          id: targetId,
          title: "Top-level filter marker target task",
        }),
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
          arguments: {
            path: context.pmPath,
            id,
            author: "mcp-test",
            body: "Evidence: append narrow tool works.",
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: {
          warnings?: unknown;
          result?: Record<string, unknown>;
        };
      };
      expect(appendResult?.isError).not.toBe(true);
      // Declared top-level body must not trip the unexpected-key warning.
      expect(appendResult?.structuredContent?.warnings).toBeUndefined();
      // Compact-by-default mutation projection: count instead of changed_fields.
      expect(appendResult?.structuredContent?.result?.changed_field_count).toBe(
        1,
      );
      expect(
        appendResult?.structuredContent?.result?.changed_fields,
      ).toBeUndefined();

      const got = (await handleRequest({
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: {
          name: "pm_get",
          arguments: { path: context.pmPath, id, options: { depth: "full" } },
        },
      })) as { structuredContent?: { result?: { item?: { body?: string } } } };
      expect(got.structuredContent?.result?.item?.body).toContain(
        "Evidence: append narrow tool works.",
      );
    });
  });

  it("pm_schema and pm_config drive workspace configuration natively (pm-v68d)", async () => {
    await withTempPmPath(async (context) => {
      const schemaList = (await handleRequest({
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: { path: context.pmPath, subcommand: "list" },
        },
      })) as {
        isError?: boolean;
        structuredContent?: {
          warnings?: unknown;
          result?: { builtin?: unknown[] };
        };
      };
      expect(schemaList?.isError).not.toBe(true);
      expect(schemaList?.structuredContent?.warnings).toBeUndefined();
      expect(
        Array.isArray(schemaList?.structuredContent?.result?.builtin),
      ).toBe(true);

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
      })) as {
        isError?: boolean;
        structuredContent?: {
          warnings?: unknown;
          result?: { registered?: boolean; type?: { name?: string } };
        };
      };
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
            role: ["active"],
            alias: ["rdy"],
            order: "7",
            description: "Ready for MCP work",
            author: "mcp-test",
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: {
          warnings?: unknown;
          result?: { registered?: boolean };
        };
      };
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
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { registered?: boolean } };
      };
      expect(addStatusFromOptions?.isError).not.toBe(true);
      expect(addStatusFromOptions?.structuredContent?.result?.registered).toBe(
        true,
      );

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
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { status?: { id?: string } } };
      };
      expect(showStatusFromOptions?.isError).not.toBe(true);
      expect(showStatusFromOptions?.structuredContent?.result?.status?.id).toBe(
        "qa_ready",
      );

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
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { removed?: boolean } };
      };
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
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { removed?: boolean } };
      };
      expect(removeType?.isError).not.toBe(true);
      expect(removeType?.structuredContent?.result?.removed).toBe(true);

      // GH-vhbf: custom field management over MCP (add-field/list-fields/show-field/remove-field).
      const addField = (await handleRequest({
        jsonrpc: "2.0",
        id: 520,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            subcommand: "add-field",
            name: "severity_level",
            fieldType: "string",
            commands: ["create", "update"],
            cliFlag: "--sev",
            alias: ["severity"],
            required: true,
            requiredOnCreate: true,
            allowUnset: false,
            requiredTypes: ["Bug"],
            author: "mcp-test",
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: {
          result?: { registered?: boolean; field?: { key?: string } };
        };
      };
      expect(addField?.isError).not.toBe(true);
      expect(addField?.structuredContent?.result?.registered).toBe(true);
      expect(addField?.structuredContent?.result?.field?.key).toBe(
        "severity_level",
      );

      // add-field via the nested options bag exercises the options-source arms.
      const addFieldFromOptions = (await handleRequest({
        jsonrpc: "2.0",
        id: 519,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            options: {
              subcommand: "add-field",
              name: "owner",
              fieldType: "string",
              commands: ["create"],
              cliFlag: "--lead",
              requiredTypes: ["Story"],
              required: true,
              requiredOnCreate: true,
              allowUnset: false,
              author: "mcp-test",
            },
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { registered?: boolean } };
      };
      expect(addFieldFromOptions?.isError).not.toBe(true);
      expect(addFieldFromOptions?.structuredContent?.result?.registered).toBe(
        true,
      );

      // add-field with neither commands nor requiredTypes exercises the
      // undefined-source arms (defaults applied downstream).
      const addFieldMinimal = (await handleRequest({
        jsonrpc: "2.0",
        id: 518,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            subcommand: "add-field",
            name: "reviewer_team",
            fieldType: "string",
            author: "mcp-test",
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { registered?: boolean } };
      };
      expect(addFieldMinimal?.isError).not.toBe(true);
      expect(addFieldMinimal?.structuredContent?.result?.registered).toBe(true);

      const listFields = (await handleRequest({
        jsonrpc: "2.0",
        id: 521,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: { path: context.pmPath, subcommand: "list-fields" },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { counts?: { total?: number } } };
      };
      expect(listFields?.isError).not.toBe(true);
      expect(
        listFields?.structuredContent?.result?.counts?.total,
      ).toBeGreaterThanOrEqual(1);

      const showField = (await handleRequest({
        jsonrpc: "2.0",
        id: 522,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            options: { subcommand: "show-field", name: "severity_level" },
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { field?: { key?: string } } };
      };
      expect(showField?.isError).not.toBe(true);
      expect(showField?.structuredContent?.result?.field?.key).toBe(
        "severity_level",
      );

      const removeField = (await handleRequest({
        jsonrpc: "2.0",
        id: 523,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            subcommand: "remove-field",
            name: "severity_level",
            author: "mcp-test",
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { removed?: boolean } };
      };
      expect(removeField?.isError).not.toBe(true);
      expect(removeField?.structuredContent?.result?.removed).toBe(true);

      // GH-86ob: standalone apply-preset over MCP (typePreset via the options bag).
      const applyPreset = (await handleRequest({
        jsonrpc: "2.0",
        id: 524,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            options: {
              subcommand: "apply-preset",
              typePreset: "agile",
              author: "mcp-test",
            },
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: {
          result?: { preset?: string; registered?: unknown[] };
        };
      };
      expect(applyPreset?.isError).not.toBe(true);
      expect(applyPreset?.structuredContent?.result?.preset).toBe("agile");
      expect(
        Array.isArray(applyPreset?.structuredContent?.result?.registered),
      ).toBe(true);

      // GH-245: add-type infer (dry-run preview) over MCP (top-level args; minCount number).
      const inferTypes = (await handleRequest({
        jsonrpc: "2.0",
        id: 525,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            subcommand: "add-type",
            infer: true,
            minCount: 1,
            options: { apply: false },
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { action?: string; applied?: boolean } };
      };
      expect(inferTypes?.isError).not.toBe(true);
      expect(inferTypes?.structuredContent?.result?.action).toBe("infer-types");
      expect(inferTypes?.structuredContent?.result?.applied).toBe(false);

      // infer via the options bag with a string minCount + apply exercises the
      // options-source and string-parse arms of the dispatcher.
      const inferApply = (await handleRequest({
        jsonrpc: "2.0",
        id: 526,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            subcommand: "add-type",
            options: { infer: true, minCount: "1", apply: true },
            author: "mcp-test",
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { applied?: boolean } };
      };
      expect(inferApply?.isError).not.toBe(true);
      expect(inferApply?.structuredContent?.result?.applied).toBe(true);

      // infer with no minCount exercises the default (undefined) min-count arm.
      const inferDefault = (await handleRequest({
        jsonrpc: "2.0",
        id: 527,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: {
            path: context.pmPath,
            subcommand: "add-type",
            infer: true,
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { min_count?: number } };
      };
      expect(inferDefault?.isError).not.toBe(true);
      expect(inferDefault?.structuredContent?.result?.min_count).toBe(10);

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
      })) as {
        isError?: boolean;
        structuredContent?: {
          warnings?: unknown;
          result?: { policy?: string };
        };
      };
      expect(configSet?.isError).not.toBe(true);
      expect(configSet?.structuredContent?.warnings).toBeUndefined();
      expect(configSet?.structuredContent?.result?.policy).toBe("enabled");

      const configGet = (await handleRequest({
        jsonrpc: "2.0",
        id: 53,
        method: "tools/call",
        params: {
          name: "pm_config",
          arguments: {
            path: context.pmPath,
            configAction: "get",
            key: "governance-require-close-reason",
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { result?: { policy?: string } };
      };
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
          arguments: {
            path: context.pmPath,
            status: "open",
            type: "Task",
            limit: 5,
          },
        },
      })) as {
        structuredContent?: {
          result?: {
            query_summary?: {
              filters?: Record<string, unknown>;
              projection?: string;
            };
          };
        };
      };
      const listSummary = list.structuredContent?.result?.query_summary;
      expect(listSummary?.projection).toBe("compact");
      expect(listSummary?.filters).toMatchObject({
        status: "open",
        type: "Task",
      });

      const briefList = (await handleRequest({
        jsonrpc: "2.0",
        id: 61,
        method: "tools/call",
        params: {
          name: "pm_list",
          arguments: { path: context.pmPath, options: { brief: true } },
        },
      })) as {
        structuredContent?: {
          result?: { query_summary?: { projection?: string } };
        };
      };
      expect(
        briefList.structuredContent?.result?.query_summary?.projection,
      ).toBe("brief");

      const search = (await handleRequest({
        jsonrpc: "2.0",
        id: 62,
        method: "tools/call",
        params: {
          name: "pm_search",
          arguments: {
            path: context.pmPath,
            query: "query summary marker",
            type: "Task",
          },
        },
      })) as {
        structuredContent?: {
          result?: {
            query_summary?: {
              filters?: Record<string, unknown>;
              projection?: string;
            };
          };
        };
      };
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
      const loadSpy = vi
        .spyOn(extensionLoader, "loadExtensions")
        .mockResolvedValue({
          loaded: [],
          failed: [],
          warnings: [],
        } as never);
      const deactivateSpy = vi
        .spyOn(extensionLoader, "deactivateExtensions")
        .mockRejectedValue(new Error("deactivate failed"));
      const activateSpy = vi
        .spyOn(extensionLoader, "activateExtensions")
        .mockResolvedValue({
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
      const handlerSpy = vi
        .spyOn(extensionRuntime, "runActiveCommandHandler")
        .mockResolvedValue({
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
        ).rejects.toThrow(
          "Unsupported native pm action: dynamic-tool (missing-handler)",
        );
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

  it("preserves MCP mutation dash values as JSON document data", async () => {
    await withTempPmPath(async (context) => {
      const created = (await mcpServerTestOnly.runAction({
        action: "create",
        path: context.pmPath,
        options: {
          title: "mcp literal stdin tokens",
          type: "Task",
          body: "-",
          comment: ["-"],
        },
      })) as { id: string };

      await mcpServerTestOnly.runAction({
        action: "update",
        path: context.pmPath,
        id: created.id,
        options: { description: "-", note: ["-"] },
      });
      await mcpServerTestOnly.runAction({
        action: "update-many",
        path: context.pmPath,
        options: {
          list: { ids: [created.id] },
          update: { body: "-", learning: ["-"] },
        },
      });
      await mcpServerTestOnly.runAction({
        action: "append",
        path: context.pmPath,
        id: created.id,
        options: { body: "-" },
      });
      await mcpServerTestOnly.runAction({
        action: "comments",
        path: context.pmPath,
        id: created.id,
        options: { add: "-" },
      });
      await mcpServerTestOnly.runAction({
        action: "notes",
        path: context.pmPath,
        id: created.id,
        options: { add: "-" },
      });
      await mcpServerTestOnly.runAction({
        action: "learnings",
        path: context.pmPath,
        id: created.id,
        options: { add: "-" },
      });

      const plan = (await mcpServerTestOnly.runAction({
        action: "plan",
        path: context.pmPath,
        options: {
          subcommand: "create",
          title: "mcp literal plan description",
          description: "-",
        },
      })) as { plan: { id: string } };
      const shortcutIds: string[] = [];
      for (const action of ["meet", "event", "remind"] as const) {
        const shortcut = (await mcpServerTestOnly.runAction({
          action,
          path: context.pmPath,
          title: `mcp literal ${action}`,
          options: { body: "-" },
        })) as { item: { id: string } };
        shortcutIds.push(shortcut.item.id);
      }

      const loaded = (await mcpServerTestOnly.runAction({
        action: "get",
        path: context.pmPath,
        id: created.id,
        options: { full: true },
      })) as {
        item: {
          body?: string;
          description?: string;
          comments?: Array<{ text: string }>;
          notes?: Array<{ text: string }>;
          learnings?: Array<{ text: string }>;
        };
      };
      expect(loaded.item).toMatchObject({
        body: "-\n\n-",
        description: "-",
        comments: expect.arrayContaining([
          expect.objectContaining({ text: "-" }),
          expect.objectContaining({ text: "-" }),
        ]),
        notes: expect.arrayContaining([expect.objectContaining({ text: "-" })]),
        learnings: expect.arrayContaining([
          expect.objectContaining({ text: "-" }),
        ]),
      });
      const planItem = (await mcpServerTestOnly.runAction({
        action: "get",
        path: context.pmPath,
        id: plan.plan.id,
        options: { full: true },
      })) as { item: { description?: string } };
      expect(planItem.item.description).toBe("-");
      for (const id of shortcutIds) {
        const shortcutItem = (await mcpServerTestOnly.runAction({
          action: "get",
          path: context.pmPath,
          id,
          options: { full: true },
        })) as { item: { body?: string } };
        expect(shortcutItem.item.body).toBe("-");
      }
    });
  });

  it("refuses MCP annotation stdin and server-file directives", async () => {
    await withTempPmPath(async (context) => {
      const created = (await mcpServerTestOnly.runAction({
        action: "create",
        path: context.pmPath,
        options: { title: "mcp annotation stdin refusal", type: "Task" },
      })) as { id: string };
      for (const action of ["comments", "notes", "learnings"] as const) {
        await expect(
          mcpServerTestOnly.runAction({
            action,
            path: context.pmPath,
            id: created.id,
            options: { stdin: true },
          }),
        ).rejects.toMatchObject({
          code: "mcp_stdin_unavailable",
        });
        await expect(
          mcpServerTestOnly.runAction({
            action,
            path: context.pmPath,
            id: created.id,
            options: { file: "-" },
          }),
        ).rejects.toMatchObject({
          code: "mcp_annotation_file_unavailable",
        });
        await expect(
          mcpServerTestOnly.runAction({
            action,
            path: context.pmPath,
            id: created.id,
            options: { file: "/etc/hostname" },
          }),
        ).rejects.toMatchObject({
          code: "mcp_annotation_file_unavailable",
        });
      }
    });
  });

  it("returns an invalid-request error for non-object JSON-RPC lines", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
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
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
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
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await processRpcLine(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      );
      await processRpcLine(
        JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
      );
      await processRpcLine(
        JSON.stringify({ jsonrpc: "2.0", method: "not/supported" }),
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("writes success and non-tool error JSON-RPC envelopes", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    let responses: string[] = [];
    try {
      await processRpcLine("");
      expect(write).not.toHaveBeenCalled();

      await processRpcLine(
        JSON.stringify({ jsonrpc: "2.0", id: 90, method: "ping" }),
      );
      await processRpcLine(
        JSON.stringify({ jsonrpc: "2.0", id: 91, method: "not/supported" }),
      );
      responses = write.mock.calls
        .map((call) => String(call[0]).trim())
        .filter(Boolean);
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
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    let responseText = "";
    try {
      await processRpcLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 92,
          method: "tools/call",
          params: {},
        }),
      );
      responseText = write.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      write.mockRestore();
    }

    const response = JSON.parse(responseText) as {
      result?: {
        isError?: boolean;
        structuredContent?: { result?: unknown; error?: string; code?: number };
      };
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

        const structured = result?.structuredContent as
          | { warnings?: string[] }
          | undefined;
        expect(structured?.warnings?.[0]).toContain(
          'Unexpected top-level argument "limt"',
        );
        expect(structured?.warnings?.[0]).toContain('did you mean "limit"');
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining("[pm-mcp] Unexpected top-level argument"),
        );
      } finally {
        stderr.mockRestore();
      }
    });
  });

  it("starts the stdio server with serialized line processing", async () => {
    let lineHandler: ((line: string) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    const fakeInterface = {
      on: vi.fn((event: string, handler: (line: string) => void) => {
        if (event === "line") {
          lineHandler = handler;
        } else if (event === "close") {
          closeHandler = handler;
        }
        return fakeInterface;
      }),
    };
    const createInterface = vi
      .spyOn(readline, "createInterface")
      .mockReturnValue(fakeInterface as never);
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      startMcpServer();
      expect(createInterface).toHaveBeenCalledWith({
        input: process.stdin,
        crlfDelay: Infinity,
      });
      expect(fakeInterface.on).toHaveBeenCalledWith(
        "line",
        expect.any(Function),
      );
      lineHandler?.(JSON.stringify({ jsonrpc: "2.0", id: 93, method: "ping" }));
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
      lineHandler?.(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "stdio-close",
          method: "subscriptions/listen",
          params: {
            notifications: {},
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      );
      await vi.waitFor(() =>
        expect(mcpServerTestOnly.subscriptionCount()).toBe(1),
      );
      closeHandler?.();
      await vi.waitFor(() =>
        expect(mcpServerTestOnly.subscriptionCount()).toBe(0),
      );
      expect(write).toHaveBeenCalledWith(
        expect.stringContaining('"id":"stdio-close"'),
      );
    } finally {
      write.mockRestore();
      createInterface.mockRestore();
    }
  });

  it("keeps typed per-request errors when stdio process configuration is invalid", async () => {
    const originalClock = process.env.PM_CLOCK;
    const originalSeed = process.env.PM_SEED;
    let lineHandler: ((line: string) => void) | undefined;
    const fakeInterface = {
      on: vi.fn((event: string, handler: (line: string) => void) => {
        if (event === "line") {
          lineHandler = handler;
        }
        return fakeInterface;
      }),
    };
    const createInterface = vi
      .spyOn(readline, "createInterface")
      .mockReturnValue(fakeInterface as never);
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      process.env.PM_CLOCK = "2026-08-22T12:00:00.000Z";
      delete process.env.PM_SEED;
      startMcpServer();
      lineHandler?.(JSON.stringify({ jsonrpc: "2.0", id: 94, method: "ping" }));
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
      const payload = JSON.parse(String(write.mock.calls[0]?.[0])) as {
        error?: { code?: number; data?: { code?: string; recovery?: unknown } };
      };
      expect(payload.error).toMatchObject({
        code: EXIT_CODE.USAGE,
        data: {
          code: "invalid_reproducible_process_environment",
          recovery: { missing_required_fields: ["PM_SEED"] },
        },
      });
    } finally {
      if (originalClock === undefined) {
        delete process.env.PM_CLOCK;
      } else {
        process.env.PM_CLOCK = originalClock;
      }
      if (originalSeed === undefined) {
        delete process.env.PM_SEED;
      } else {
        process.env.PM_SEED = originalSeed;
      }
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
            arguments: {
              path: context.pmPath,
              id,
              author: "mcp-test",
              options,
            },
          },
        }) as Promise<{ structuredContent?: { result?: { count?: number } } }>;

      const queue = createSerialQueue();
      const first = queue.enqueue(() =>
        callTool("pm_notes", { add: "serialized note" }),
      );
      const second = queue.enqueue(() =>
        callTool("pm_learnings", { add: "serialized learning" }),
      );
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
    const { isInvokedAsMcpMainModule } =
      await import("../../src/mcp/server.js");
    const {
      mkdtemp,
      symlink: makeSymlink,
      realpath,
    } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const selfPath = await realpath(
      fileURLToPath(new URL("../../src/mcp/server.ts", import.meta.url)),
    );
    const moduleUrl = pathToFileURL(selfPath).href;
    const binDir = await mkdtemp(path.join(tmpdir(), "pm-mcp-bin-"));
    const shimPath = path.join(binDir, "pm-mcp");
    await makeSymlink(selfPath, shimPath);
    expect(isInvokedAsMcpMainModule(shimPath, moduleUrl)).toBe(true);
    expect(isInvokedAsMcpMainModule(selfPath, moduleUrl)).toBe(true);
    expect(isInvokedAsMcpMainModule(undefined, moduleUrl)).toBe(false);
    expect(
      isInvokedAsMcpMainModule(path.join(binDir, "missing"), moduleUrl),
    ).toBe(false);
    expect(
      isInvokedAsMcpMainModule(path.join(binDir, "pm-mcp-other"), moduleUrl),
    ).toBe(false);
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
        reject(
          new Error("timed out waiting for symlinked pm-mcp bin response"),
        );
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

  it("refuses files and preserves atomic/Plan dashes while MCP stdin remains open", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "MCP file-refusal target",
          "--type",
          "Task",
          "--status",
          "open",
        ],
        { expectJson: true },
      );
      expect(create.code).toBe(0);
      const targetId = (create.json as { item: { id: string } }).item.id;
      const pauseTarget = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "MCP pause-task target",
          "--type",
          "Task",
          "--status",
          "open",
        ],
        { expectJson: true },
      );
      expect(pauseTarget.code).toBe(0);
      const pauseTargetId = (pauseTarget.json as { item: { id: string } }).item
        .id;
      expect(
        context.runCli([
          "start-task",
          pauseTargetId,
          "--author",
          "mcp-pause-setup",
          "--json",
        ]).code,
      ).toBe(0);
      const materializePlan = context.runCli(
        [
          "plan",
          "create",
          "MCP materialize literal plan",
          "--step",
          "literal materialized step",
          "--json",
        ],
        { expectJson: true },
      );
      expect(materializePlan.code).toBe(0);
      const materializePlanId = (
        materializePlan.json as { plan: { id: string } }
      ).plan.id;
      const distServerPath = path.join(
        process.cwd(),
        "dist",
        "mcp",
        "server.js",
      );
      const child = spawn(process.execPath, [distServerPath], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...context.env,
          PM_PATH: context.pmPath,
          PM_NO_TELEMETRY: "1",
          PM_ANALYTICS_OPTOUT: "1",
        },
      });
      const responses = readline.createInterface({ input: child.stdout });
      const responsePromise = new Promise<Map<number, Record<string, unknown>>>(
        (resolve, reject) => {
          const received = new Map<number, Record<string, unknown>>();
          const timeout = setTimeout(() => {
            reject(
              new Error(
                "timed out waiting for MCP file refusal, materialization, and literal mutation responses with open stdin",
              ),
            );
          }, 5_000);
          responses.on("line", (line) => {
            const response = JSON.parse(line) as Record<string, unknown>;
            if (
              response.id === 40 ||
              response.id === 41 ||
              response.id === 42 ||
              response.id === 43 ||
              response.id === 44 ||
              response.id === 45
            ) {
              received.set(response.id, response);
            }
            if (received.size === 6) {
              clearTimeout(timeout);
              resolve(received);
            }
          });
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once("exit", (code, signal) => {
            if (received.size === 6) return;
            clearTimeout(timeout);
            reject(
              new Error(
                `MCP server exited before answering (code=${code}, signal=${signal})`,
              ),
            );
          });
        },
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 39,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "legacy-stdin-test", version: "1.0.0" },
          },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 40,
          method: "tools/call",
          params: {
            name: "pm_comments",
            arguments: {
              path: context.pmPath,
              id: targetId,
              options: { file: "/etc/hostname" },
            },
          },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 45,
          method: "tools/call",
          params: {
            name: "pm_plan",
            arguments: {
              path: context.pmPath,
              id: materializePlanId,
              options: {
                subcommand: "materialize",
                steps: "plan-step-001",
                step: "singular alias provenance probe",
                field: ["body=-"],
                materializeType: "Task",
              },
            },
          },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 43,
          method: "tools/call",
          params: {
            name: "pm_run",
            arguments: {
              action: "start-task",
              path: context.pmPath,
              id: targetId,
              options: { body: "-" },
            },
          },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 44,
          method: "tools/call",
          params: {
            name: "pm_run",
            arguments: {
              action: "pause-task",
              path: context.pmPath,
              id: pauseTargetId,
              options: { body: "-" },
            },
          },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 41,
          method: "tools/call",
          params: {
            name: "pm_plan",
            arguments: {
              path: context.pmPath,
              options: {
                subcommand: "create",
                title: "open MCP stdin literal",
                description: "-",
              },
            },
          },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: {
            name: "pm_mutate",
            arguments: {
              path: context.pmPath,
              transactionId: "mcp-atomic-literal-dashes",
              mutations: [
                {
                  op: "create",
                  id: "pm-mcp-atomic-literal-a",
                  options: {
                    title: "MCP atomic literal A",
                    type: "Task",
                    description: "-",
                  },
                },
                {
                  op: "create",
                  id: "pm-mcp-atomic-literal-b",
                  options: {
                    title: "MCP atomic literal B",
                    type: "Task",
                    body: "-",
                  },
                },
              ],
            },
          },
        })}\n`,
      );
      try {
        const received = await responsePromise;
        expect(received.get(40)).toMatchObject({
          result: {
            isError: true,
            structuredContent: {
              result: null,
              details: { code: "mcp_annotation_file_unavailable" },
            },
          },
        });
        expect(received.get(41)?.error).toBeUndefined();
        expect(received.get(41)?.result).toBeDefined();
        expect(received.get(42)).toMatchObject({
          result: {
            structuredContent: {
              result: { status: "committed", mutation_count: 2 },
            },
          },
        });
        expect(received.get(43)?.error).toBeUndefined();
        expect(received.get(43)?.result).toBeDefined();
        expect(received.get(44)?.error).toBeUndefined();
        expect(received.get(44)?.result).toBeDefined();
        expect(received.get(45)?.error).toBeUndefined();
        expect(received.get(45)?.result).toBeDefined();
        const target = context.runCli(["get", targetId, "--json", "--full"], {
          expectJson: true,
        });
        expect(target.code).toBe(0);
        expect(
          (target.json as { item: { comments?: unknown[] } }).item.comments,
        ).toEqual([]);
        expect((target.json as { item: { status?: string } }).item.status).toBe(
          "in_progress",
        );
        const paused = context.runCli(
          ["get", pauseTargetId, "--json", "--full"],
          { expectJson: true },
        );
        expect(paused.code).toBe(0);
        expect(
          (
            paused.json as {
              item: { status?: string; assignee?: string };
            }
          ).item,
        ).toMatchObject({ status: "open" });
        expect(
          (paused.json as { item: { assignee?: string } }).item.assignee,
        ).toBeUndefined();
        const atomicFirst = context.runCli(
          ["get", "pm-mcp-atomic-literal-a", "--json", "--full"],
          { expectJson: true },
        );
        const atomicSecond = context.runCli(
          ["get", "pm-mcp-atomic-literal-b", "--json", "--full"],
          { expectJson: true },
        );
        expect(
          (atomicFirst.json as { item: { description?: string } }).item
            .description,
        ).toBe("-");
        expect(
          (atomicSecond.json as { item: { body?: string } }).item.body,
        ).toBe("-");
        const materializedId = (
          received.get(45) as {
            result?: {
              structuredContent?: {
                result?: { materialized?: Array<{ id?: string }> };
              };
            };
          }
        ).result?.structuredContent?.result?.materialized?.[0]?.id;
        expect(materializedId).toBeTruthy();
        const materialized = context.runCli(
          ["get", materializedId ?? "", "--json", "--full"],
          { expectJson: true },
        );
        expect(materialized.code).toBe(0);
        expect(
          (materialized.json as { item: { body?: string } }).item.body,
        ).toBe("-");
      } finally {
        responses.close();
        child.stdin.end();
        child.kill("SIGTERM");
      }
    });
  });
});
