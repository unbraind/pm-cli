import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectStaleInProgressItems,
  scanStaleInProgressItems,
} from "../../../src/sdk/index.js";
import type { ItemMetadata } from "../../../src/types/index.js";

function item(overrides: Partial<ItemMetadata>): ItemMetadata {
  return {
    id: "pm-item",
    title: "Work",
    description: "",
    type: "Task",
    status: "open",
    priority: 2,
    tags: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("stale in-progress SDK governance", () => {
  it("reports only unclaimed active work beyond the configured age", () => {
    const scan = inspectStaleInProgressItems(
      [
        item({ id: "pm-stale", status: "in_progress" }),
        item({
          id: "pm-claimed",
          status: "in_progress",
          assignee: "agent",
        }),
        item({
          id: "pm-recent",
          status: "in_progress",
          updated_at: "2026-07-23T12:00:00.000Z",
        }),
        item({ id: "pm-open", status: "open" }),
      ],
      {
        in_progress_status: "in-progress",
        threshold_hours: 72,
        now: new Date("2026-07-24T12:00:00.000Z"),
      },
    );
    expect(scan).toMatchObject({
      threshold_hours: 72,
      count: 1,
      items: [
        {
          id: "pm-stale",
          last_activity_at: "2026-07-01T00:00:00.000Z",
          age_hours: 564,
        },
      ],
    });
    expect(scan.remediation).toContain("pm claim <id>");
  });

  it("uses newer history activity and clamps invalid thresholds", () => {
    expect(
      inspectStaleInProgressItems(
        [
          item({
            id: "pm-history",
            status: "in_progress",
            updated_at: "invalid",
          }),
        ],
        {
          in_progress_status: "in_progress",
          threshold_hours: 0,
          now: new Date("2026-07-24T12:00:00.000Z"),
          last_history_activity: () => "2026-07-24T10:00:00.000Z",
        },
      ),
    ).toMatchObject({
      threshold_hours: 1,
      count: 1,
      items: [{ id: "pm-history", age_hours: 2 }],
    });
    expect(
      inspectStaleInProgressItems(
        [
          item({
            id: "pm-invalid",
            status: "in_progress",
            updated_at: "invalid",
          }),
        ],
        {
          threshold_hours: 1,
          now: new Date("2026-07-24T12:00:00.000Z"),
        },
      ),
    ).toMatchObject({ count: 0, items: [] });
  });

  it("orders equal-age stale items by id", () => {
    expect(
      inspectStaleInProgressItems(
        [
          item({ id: "pm-z", status: "in_progress" }),
          item({ id: "pm-a", status: "in_progress" }),
        ],
        {
          in_progress_status: "in_progress",
          threshold_hours: 1,
          now: new Date("2026-07-24T12:00:00.000Z"),
        },
      ).items.map((entry) => entry.id),
    ).toEqual(["pm-a", "pm-z"]);
  });

  it("scans items whose history stream has no recorded activity", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-stale-work-"));
    try {
      await mkdir(path.join(pmRoot, "history"));
      await expect(
        scanStaleInProgressItems(
          pmRoot,
          [item({ id: "pm-no-history", status: "in_progress" })],
          {
            in_progress_status: "in_progress",
            threshold_hours: 1,
            now: new Date("2026-07-24T12:00:00.000Z"),
          },
        ),
      ).resolves.toMatchObject({
        count: 1,
        items: [{ id: "pm-no-history" }],
      });
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
