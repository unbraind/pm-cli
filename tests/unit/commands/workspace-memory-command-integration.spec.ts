import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../helpers/withTempPmPath.js";

const memoryMocks = vi.hoisted(() => ({
  cacheStatus: "fresh" as "fresh" | "rebuilt",
  includeRollups: true,
}));

vi.mock("../../../src/sdk/workspace-memory.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/sdk/workspace-memory.js")
    >();
  const rollup = {
    kind: "epic" as const,
    key: "pm-memory-epic",
    label: "Historical SDK delivery",
    item_count: 4,
    first_closed_at: "2026-01-01T00:00:00.000Z",
    last_closed_at: "2026-04-01T00:00:00.000Z",
    representative_items: [
      { id: "pm-memory-task", title: "Ship historical SDK" },
    ],
    outcomes: ["Delivered searchable workspace memory"],
    knowledge_entries: 3,
  };
  return {
    ...actual,
    readWorkspaceMemory: vi.fn(async () => ({
      snapshot: {
        format_version: 1,
        source_cursor: "memory-cursor",
        source_item_count: 10_000,
        generated_at: "2026-07-23T00:00:00.000Z",
        rollups: memoryMocks.includeRollups ? [rollup] : [],
      },
      cache_status: memoryMocks.cacheStatus,
      warnings: [],
    })),
  };
});

import {
  renderContextMarkdown,
  runContext,
} from "../../../src/cli/commands/context.js";
import { runSearch } from "../../../src/sdk/query/search.js";

beforeEach(() => {
  memoryMocks.cacheStatus = "fresh";
  memoryMocks.includeRollups = true;
});

describe("workspace-memory command integration", () => {
  it("attaches and renders token-bounded context memory", async () => {
    await withTempPmPath(async (context: TempPmContext) => {
      const result = await runContext(
        { limit: "1", tokenBudget: 1_000 },
        { path: context.pmPath },
      );
      expect(result.workspace_memory).toMatchObject({
        cache_status: "fresh",
        source_cursor: "memory-cursor",
        rollups: [{ key: "pm-memory-epic" }],
      });
      expect(renderContextMarkdown(result)).toContain(
        "epic:pm-memory-epic — Historical SDK delivery",
      );
    });
  });

  it("attaches matching rebuilt memory to empty keyword search results", async () => {
    memoryMocks.cacheStatus = "rebuilt";
    await withTempPmPath(async (context: TempPmContext) => {
      const result = await runSearch(
        "historical SDK",
        { limit: "1" },
        { path: context.pmPath },
      );
      expect(result.workspace_memory).toMatchObject({
        cache_status: "rebuilt",
        matches: [{ key: "pm-memory-epic" }],
      });
    });
  });

  it("omits context memory when the token-bound selection is empty", async () => {
    memoryMocks.includeRollups = false;
    await withTempPmPath(async (context: TempPmContext) => {
      const result = await runContext(
        { limit: "1", tokenBudget: 1_000 },
        { path: context.pmPath },
      );
      expect(result.workspace_memory).toBeUndefined();
    });
  });

  it("marks attached context memory when persistence rebuilt it", async () => {
    memoryMocks.cacheStatus = "rebuilt";
    await withTempPmPath(async (context: TempPmContext) => {
      const result = await runContext(
        { limit: "1", tokenBudget: 1_000 },
        { path: context.pmPath },
      );
      expect(result.workspace_memory?.cache_status).toBe("rebuilt");
    });
  });

  it("marks matching fresh search memory without rebuilding", async () => {
    await withTempPmPath(async (context: TempPmContext) => {
      const result = await runSearch(
        "historical SDK",
        { limit: "1" },
        { path: context.pmPath },
      );
      expect(result.workspace_memory?.cache_status).toBe("fresh");
    });
  });
});
