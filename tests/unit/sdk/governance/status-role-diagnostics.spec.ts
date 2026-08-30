import { describe, expect, it } from "vitest";
import { resolveRuntimeStatusRegistry } from "../../../../src/core/schema/runtime-schema.js";
import {
  buildStatusRoleWarnings,
  inspectStatusRoleAssignments,
} from "../../../../src/sdk/governance/status-role-diagnostics.js";
import type { ItemMetadata } from "../../../../src/types/index.js";

function item(id: string, status: string): ItemMetadata {
  return {
    id,
    title: id,
    type: "Task",
    status,
    priority: 2,
    tags: [],
    created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:00:00.000Z",
  } as ItemMetadata;
}

describe("status role diagnostics", () => {
  it("reports roleless statuses and bounded affected item ids", () => {
    const registry = resolveRuntimeStatusRegistry({
      statuses: [
        { id: "todo", roles: ["active", "default_open"] },
        { id: "review" },
        { id: "verification" },
        { id: "done", roles: ["terminal", "terminal_done", "default_close"] },
      ],
      workflow: { open_status: "todo", close_status: "done" },
    });
    const diagnostics = inspectStatusRoleAssignments(
      registry,
      [item("pm-b", "review"), item("pm-a", "review"), item("pm-c", "todo")],
      1,
    );
    expect(diagnostics).toEqual({
      roleless_status_count: 2,
      roleless_statuses: ["review"],
      roleless_statuses_truncated: true,
      affected_item_count: 2,
      affected_item_ids: ["pm-a"],
      affected_item_ids_truncated: true,
    });
    expect(buildStatusRoleWarnings(diagnostics)).toEqual([
      "schema_status_missing_lifecycle_role:2",
    ]);
  });

  it("returns an explicit clean diagnostic when every status has a role", () => {
    const registry = resolveRuntimeStatusRegistry({
      statuses: [
        { id: "todo", roles: ["active", "default_open"] },
        { id: "done", roles: ["terminal", "terminal_done", "default_close"] },
      ],
      workflow: { open_status: "todo", close_status: "done" },
    });
    const diagnostics = inspectStatusRoleAssignments(registry, []);
    expect(diagnostics.roleless_status_count).toBe(0);
    expect(diagnostics.roleless_statuses).toEqual([]);
    expect(diagnostics.roleless_statuses_truncated).toBe(false);
    expect(buildStatusRoleWarnings(diagnostics)).toEqual([]);
  });
});
