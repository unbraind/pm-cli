import { describe, expect, it } from "vitest";
import {
  IN_PROGRESS_WORK_DETAIL_LIMIT,
  buildInProgressSweepCommands,
  buildInProgressWorkHealthSummary,
} from "../../../../src/sdk/governance/in-progress-work-health.js";
import { inspectInProgressWork } from "../../../../src/sdk/governance/stale-work.js";
import type { ItemMetadata } from "../../../../src/types/index.js";

function work(id: string, overrides: Partial<ItemMetadata> = {}): ItemMetadata {
  return {
    id,
    title: id,
    description: "",
    type: "Task",
    status: "doing",
    priority: 2,
    tags: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("in-progress work health projection (GH-1724)", () => {
  it("builds the exact sweeps from the workspace status id and threshold", () => {
    expect(buildInProgressSweepCommands("doing", 48)).toEqual({
      unowned: "pm list --status doing --assignee-filter unassigned",
      idle: "pm list --status doing --updated-before -48h",
      stale: "pm list --status doing --assignee-filter unassigned --updated-before -48h",
    });
  });

  it("emits nothing but registry overrides when no in-progress item is unattended", () => {
    const scan = inspectInProgressWork(
      [work("pm-held", { assignee: "agent", updated_at: "2026-07-24T11:00:00.000Z" })],
      { in_progress_status: "doing", threshold_hours: 48, now: NOW },
    );
    expect(buildInProgressWorkHealthSummary(scan, { in_progress: "doing", open: "todo" })).toEqual({
      warnings: [],
      details: undefined,
      remediation: {
        stale_in_progress_items: "pm list --status doing --assignee-filter unassigned --updated-before -48h",
        in_progress_unowned: "pm list --status doing --assignee-filter unassigned",
        in_progress_idle: "pm list --status doing --updated-before -48h",
      },
    });
  });

  it("publishes bounded groups with their sweeps and per-item remedies", () => {
    const unowned = Array.from({ length: IN_PROGRESS_WORK_DETAIL_LIMIT + 2 }, (_, index) =>
      work(`pm-u${String(index).padStart(2, "0")}`, { updated_at: "2026-07-24T11:00:00.000Z" }),
    );
    const scan = inspectInProgressWork(
      [...unowned, work("pm-idle", { assignee: "agent" })],
      { in_progress_status: "doing", threshold_hours: 48, now: NOW },
    );
    const summary = buildInProgressWorkHealthSummary(scan, { in_progress: "doing", open: "todo" });
    expect(summary.warnings).toEqual([
      `in_progress_unowned:${IN_PROGRESS_WORK_DETAIL_LIMIT + 2}`,
      "in_progress_idle:1",
    ]);
    expect(summary.details).toMatchObject({
      threshold_hours: 48,
      threshold_setting: "mutation_guard.stale_in_progress_hours",
      unowned: {
        count: IN_PROGRESS_WORK_DETAIL_LIMIT + 2,
        truncated: true,
        sweep: "pm list --status doing --assignee-filter unassigned",
      },
      idle: {
        count: 1,
        items: [{ id: "pm-idle", assignee: "agent", age_hours: 564 }],
        sweep: "pm list --status doing --updated-before -48h",
      },
      item_remedies: { claim: "pm claim <id>", return_to_open: "pm update <id> --status todo" },
    });
    expect(summary.details?.unowned.items).toHaveLength(IN_PROGRESS_WORK_DETAIL_LIMIT);
    expect(summary.details?.idle).not.toHaveProperty("truncated");
  });
});
