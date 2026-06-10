import { describe, expect, it, vi } from "vitest";
import { handleRequest, processRpcLine } from "../../src/mcp/server.js";
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
      await processRpcLine(JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }));
      await processRpcLine(JSON.stringify({ jsonrpc: "2.0", method: "not/supported" }));
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
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
