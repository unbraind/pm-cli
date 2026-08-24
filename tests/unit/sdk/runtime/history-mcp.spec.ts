import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertHistoryCompactTarget: vi.fn(),
  runHistoryCompact: vi.fn(),
  runHistoryCompactBulk: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../../../src/sdk/history-compact.js", () => ({
  assertHistoryCompactTarget: mocks.assertHistoryCompactTarget,
  runHistoryCompact: mocks.runHistoryCompact,
  runHistoryCompactBulk: mocks.runHistoryCompactBulk,
}));

import { runMcpHistoryCompactAction } from "../../../../src/sdk/history-mcp.js";

describe("MCP history adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes array IDs and removes blank selectors before bulk compaction", async () => {
    await runMcpHistoryCompactAction({
      options: { ids: [123, "  ", "pm-history\npm-second", "pm-history"] },
      global: { path: "/tmp/pm-history-mcp/.agents/pm" },
    });

    expect(mocks.assertHistoryCompactTarget).toHaveBeenCalledWith(undefined, {
      ids: ["123", "pm-history", "pm-second"],
      allOver: undefined,
      scope: undefined,
    });
    expect(mocks.runHistoryCompactBulk).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ["123", "pm-history", "pm-second"] }),
      expect.any(Object),
    );
  });

  it("normalizes a finite numeric scalar without broadening the target", async () => {
    await runMcpHistoryCompactAction({
      options: { ids: 42 },
      global: { path: "/tmp/pm-history-mcp/.agents/pm" },
    });

    expect(mocks.assertHistoryCompactTarget).toHaveBeenCalledWith(undefined, {
      ids: ["42"],
      allOver: undefined,
      scope: undefined,
    });
    expect(mocks.runHistoryCompactBulk).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ["42"] }),
      expect.any(Object),
    );
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    ["pm-history", Number.POSITIVE_INFINITY],
    { id: "pm-history" },
  ])(
    "rejects an invalid explicit selector before target selection: %j",
    (ids) => {
      expect(() =>
        runMcpHistoryCompactAction({
          options: { ids, allOver: 1 },
          global: { path: "/tmp/pm-history-mcp/.agents/pm" },
        }),
      ).toThrow(
        expect.objectContaining({
          exitCode: 2,
          context: expect.objectContaining({ code: "bulk_ids_input_empty" }),
        }),
      );
      expect(mocks.assertHistoryCompactTarget).not.toHaveBeenCalled();
      expect(mocks.runHistoryCompactBulk).not.toHaveBeenCalled();
    },
  );
});
