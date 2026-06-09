import { expect } from "vitest";
import { handleRequest } from "../../src/mcp/server.js";
import type { TempPmContext } from "./withTempPmPath.js";

export async function assertPmContextDepthProjection(
  context: TempPmContext,
  itemTitle = "MCP context projection target",
): Promise<void> {
  const create = context.runCli(
    [
      "create",
      "--json",
      "--title",
      itemTitle,
      "--description",
      `${itemTitle} description`,
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

  const brief = (await handleRequest({
    jsonrpc: "2.0",
    id: 68,
    method: "tools/call",
    params: { name: "pm_context", arguments: { path: context.pmPath } },
  })) as {
    structuredContent?: {
      result?: {
        depth?: string;
        summary?: { active_items?: number; open?: number; low_level?: number };
        low_level?: Array<Record<string, unknown>>;
      };
    };
  };
  expect(brief.structuredContent?.result?.depth).toBe("brief");
  expect(brief.structuredContent?.result?.summary).toMatchObject({
    active_items: 1,
    open: 1,
    low_level: 1,
  });
  expect(brief.structuredContent?.result?.low_level).toEqual([
    expect.objectContaining({
      id,
      title: itemTitle,
      type: "Task",
      status: "open",
    }),
  ]);
  expect(brief.structuredContent?.result?.low_level?.[0]).not.toHaveProperty("description");
  expect(brief.structuredContent?.result?.low_level?.[0]).not.toHaveProperty("body");

  const deep = (await handleRequest({
    jsonrpc: "2.0",
    id: 69,
    method: "tools/call",
    params: { name: "pm_context", arguments: { path: context.pmPath, options: { depth: "deep" } } },
  })) as {
    structuredContent?: {
      result?: {
        depth?: string;
        summary?: { active_items?: number; open?: number };
        low_level?: Array<Record<string, unknown>>;
      };
    };
  };
  expect(deep.structuredContent?.result?.depth).toBe("deep");
  expect(deep.structuredContent?.result?.summary).toMatchObject({
    active_items: 1,
    open: 1,
  });
  expect(deep.structuredContent?.result?.low_level).toEqual([
    expect.objectContaining({
      id,
      title: itemTitle,
    }),
  ]);
}
