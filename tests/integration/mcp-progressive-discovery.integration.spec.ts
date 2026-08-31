import { describe, expect, it, vi } from "vitest";

import { handleRequest, processRpcLine } from "../../src/mcp/server.js";
import {
  PM_MCP_ENTRY_TOOL_NAMES,
  PM_MCP_APPS_EXTENSION,
  PM_MCP_META_KEYS,
  PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION,
  PM_MCP_PROGRESSIVE_DISCOVERY_SERVER_CAPABILITY,
  PM_MCP_PROTOCOL_VERSION,
} from "../../src/sdk/index.js";

function modernParams(
  negotiated: boolean,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...params,
    _meta: {
      [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
      [PM_MCP_META_KEYS.clientCapabilities]: negotiated
        ? {
            extensions: {
              [PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION]:
                PM_MCP_PROGRESSIVE_DISCOVERY_SERVER_CAPABILITY,
            },
          }
        : {},
      [PM_MCP_META_KEYS.clientInfo]: {
        name: "progressive-discovery-test",
        version: "1.0.0",
      },
    },
  };
}

describe("MCP progressive discovery negotiation", () => {
  it("advertises the extension and preserves the full unnegotiated catalog", async () => {
    const discovery = await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: modernParams(false),
    });
    expect(discovery?.capabilities).toMatchObject({
      extensions: {
        [PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION]:
          PM_MCP_PROGRESSIVE_DISCOVERY_SERVER_CAPABILITY,
      },
    });

    const legacyShape = await handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: modernParams(false),
    });
    const progressive = await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: modernParams(true),
    });
    const legacyNames = (legacyShape?.tools as Array<{ name: string }>).map(
      ({ name }) => name,
    );
    const progressiveNames = (
      progressive?.tools as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(legacyNames.length).toBeGreaterThan(progressiveNames.length);
    expect(progressiveNames).toEqual([...PM_MCP_ENTRY_TOOL_NAMES].sort());
  });

  it("propagates unexpected optional Apps capability access failures", async () => {
    const extensions: Record<string, unknown> = {};
    Object.defineProperty(extensions, PM_MCP_APPS_EXTENSION, {
      enumerable: true,
      get: () => {
        throw new Error("apps capability access failed");
      },
    });
    const params = modernParams(false);
    (params._meta as Record<string, unknown>)[
      PM_MCP_META_KEYS.clientCapabilities
    ] = { extensions };
    await expect(
      handleRequest({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/list",
        params,
      }),
    ).rejects.toThrow("apps capability access failed");
  });

  it("expands by intent and removes duplicated model-facing JSON only when negotiated", async () => {
    const negotiated = await handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: modernParams(true, {
        name: "pm_discover",
        arguments: {
          query: "close item",
          limit: 10,
          outputBudget: "unbounded",
        },
      }),
    });
    expect(negotiated?.content).toEqual([
      {
        type: "text",
        text: "Canonical result: structuredContent.result",
      },
    ]);
    expect(negotiated?.structuredContent).toMatchObject({
      result: {
        result_type: "pm_tool_discovery",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "pm_close" }),
        ]),
      },
    });

    const compatible = await handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: modernParams(false, {
        name: "pm_discover",
        arguments: { query: "close", limit: 1, outputBudget: "unbounded" },
      }),
    });
    expect((compatible?.content as Array<{ text: string }>)[0]?.text).toContain(
      '"result_type": "pm_tool_discovery"',
    );
  });

  it("adapts every discovery option and canonicalizes negotiated refusals", async () => {
    const defaulted = await handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: modernParams(true, {
        name: "pm_discover",
        arguments: {},
      }),
    });
    expect(defaulted?.structuredContent).toMatchObject({
      result: { token_cost: { budget: 1_200 } },
    });

    const first = await handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: modernParams(true, {
        name: "pm_discover",
        arguments: {
          query: "lifecycle",
          family: "lifecycle",
          tier: "full",
          limit: 1,
          includeSchema: true,
          outputBudget: "unbounded",
        },
      }),
    });
    const firstResult = first?.structuredContent?.result as {
      next_cursor?: string;
      tools?: Array<{ input_schema?: unknown }>;
    };
    expect(firstResult.tools?.[0]?.input_schema).toBeDefined();
    expect(firstResult.next_cursor).toBeTypeOf("string");

    const second = await handleRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: modernParams(true, {
        name: "pm_discover",
        arguments: {
          query: "lifecycle",
          family: "lifecycle",
          tier: "full",
          limit: 1,
          cursor: firstResult.next_cursor,
          includeSchema: true,
          outputBudget: "unbounded",
        },
      }),
    });
    expect(second?.structuredContent?.result).toMatchObject({
      result_type: "pm_tool_discovery",
    });

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
          id: 9,
          method: "tools/call",
          params: modernParams(true, {
            name: "pm_discover",
            arguments: { limit: 0 },
          }),
        }),
      );
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(writes.join(""))).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: "Canonical error: structuredContent" }],
        structuredContent: { result: null, code: 64 },
      },
    });
  });
});
