import { describe, expect, it } from "vitest";
import {
  metadata as exampleMetadata,
  ordering as exampleOrdering,
  reason as exampleReason,
} from "../../../docs/examples/sdk-lifecycle-policy/index.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  applyTerminalOrderingPolicy,
  requireTerminalReason,
  resolveTerminalReason,
} from "../../../src/sdk/lifecycle-policy.js";
import type { ItemMetadata } from "../../../src/types/index.js";

describe("SDK terminal lifecycle policy", () => {
  it("keeps the compilable SDK lifecycle example executable", () => {
    expect(exampleReason.source).toBe("message");
    expect(exampleOrdering.changedFields).not.toContain("dependencies");
    expect(exampleMetadata.dependencies?.[0]?.id).toBe("pm-prerequisite");
  });

  it.each([
    [{ explicit: " done " }, "done", "explicit"],
    [{ duplicateOf: "pm-root" }, "Duplicate of pm-root", "duplicate"],
    [{ resolution: " fixed " }, "fixed", "resolution"],
    [{ message: " shipped " }, "shipped", "message"],
    [{ explicit: " ", message: "fallback" }, "fallback", "message"],
    [{}, undefined, "none"],
  ] as const)(
    "resolves terminal reason precedence from %o",
    (input, closeReason, source) => {
      expect(resolveTerminalReason(input)).toEqual({
        ...(closeReason === undefined ? {} : { closeReason }),
        source,
      });
    },
  );

  it("enforces the same close_reason_required verdict for every reasonless route", () => {
    for (const input of [
      {},
      { explicit: " " },
      { message: "", resolution: "\n" },
    ]) {
      expect(() => requireTerminalReason(input, true)).toThrow(
        expect.objectContaining<PmCliError>({
          exitCode: EXIT_CODE.USAGE,
          context: expect.objectContaining({ code: "close_reason_required" }),
        }),
      );
    }
    expect(requireTerminalReason({}, false)).toEqual({ source: "none" });
  });

  it("preserves predecessor edges while clearing transient blocked-state scalars", () => {
    const metadata: ItemMetadata = {
      id: "pm-dependent",
      title: "Dependent",
      type: "Task",
      status: "blocked",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      blocked_by: "pm-a",
      blocked_reason: "waiting",
      dependencies: [
        { id: "pm-a", kind: "blocked_by" },
        { id: "pm-b", kind: "blocked_by" },
        { id: "pm-related", kind: "related" },
      ],
    };

    expect(
      applyTerminalOrderingPolicy(metadata, { orderingEdges: "preserve" }),
    ).toEqual({
      changedFields: ["blocked_by", "blocked_reason"],
      warnings: [
        "closed_preserved_predecessors:pm-dependent:pm-a,pm-b",
      ],
    });
    expect(metadata.blocked_by).toBeUndefined();
    expect(metadata.blocked_reason).toBeUndefined();
    expect(metadata.dependencies).toHaveLength(3);
  });

  it("supports an explicit SDK policy that removes predecessor edges", () => {
    const metadata: ItemMetadata = {
      id: "pm-dependent",
      title: "Dependent",
      type: "Task",
      status: "blocked",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      dependencies: [
        { id: "pm-a", kind: "blocked_by" },
        { id: "pm-related", kind: "related" },
      ],
    };

    expect(
      applyTerminalOrderingPolicy(metadata, { orderingEdges: "remove" }),
    ).toEqual({
      changedFields: ["dependencies"],
      warnings: ["closed_removed_predecessors:pm-dependent:pm-a"],
    });
    expect(metadata.dependencies).toEqual([
      { id: "pm-related", kind: "related" },
    ]);
  });

  it("removes the dependency collection when every edge is a predecessor", () => {
    const metadata: ItemMetadata = {
      id: "pm-dependent",
      title: "Dependent",
      type: "Task",
      status: "blocked",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      dependencies: [{ id: "pm-a", kind: "blocked_by" }],
    };

    expect(
      applyTerminalOrderingPolicy(metadata, { orderingEdges: "remove" }),
    ).toEqual({
      changedFields: ["dependencies"],
      warnings: ["closed_removed_predecessors:pm-dependent:pm-a"],
    });
    expect(metadata.dependencies).toBeUndefined();
  });

  it("is a no-op for items without blocked-state signals", () => {
    const metadata: ItemMetadata = {
      id: "pm-independent",
      title: "Independent",
      type: "Task",
      status: "open",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    expect(
      applyTerminalOrderingPolicy(metadata, { orderingEdges: "preserve" }),
    ).toEqual({ changedFields: [], warnings: [] });
  });
});
