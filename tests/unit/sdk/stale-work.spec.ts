import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STALE_WORK_THRESHOLD_SETTING,
  inspectInProgressWork,
  inspectStaleInProgressItems,
  resolveLastActivityAt,
  scanInProgressWork,
  scanStaleInProgressItems,
} from "../../../src/sdk/index.js";
import {
  latestHistoryTimestamp,
  recordedPrefixActivity,
  readLatestHistoryActivity,
  staleEligibleAt,
  unprovenHistoryActivity,
  wholeHoursSince,
} from "../../../src/sdk/governance/stale-work.js";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import type { ItemMetadata, ItemStatus } from "../../../src/types/index.js";

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

  it("degrades corrupt item history to metadata activity", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-stale-work-"));
    try {
      const historyDirectory = path.join(pmRoot, "history");
      await mkdir(historyDirectory);
      await writeFile(
        path.join(historyDirectory, "pm-corrupt.jsonl"),
        "not-json\n",
      );
      await expect(
        scanStaleInProgressItems(
          pmRoot,
          [item({ id: "pm-corrupt", status: "in_progress" })],
          {
            in_progress_status: "in_progress",
            threshold_hours: 1,
            now: new Date("2026-07-24T12:00:00.000Z"),
          },
        ),
      ).resolves.toMatchObject({
        count: 1,
        items: [{ id: "pm-corrupt" }],
      });
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("classifies in-progress work by ownership and idleness independently (GH-1724)", () => {
    const scan = inspectInProgressWork(
      [
        item({ id: "pm-unowned-idle", status: "in_progress" }),
        item({ id: "pm-unowned-fresh", status: "in_progress", updated_at: "2026-07-24T11:00:00.000Z" }),
        item({ id: "pm-owned-idle", status: "in_progress", assignee: " agent " }),
        item({ id: "pm-owned-fresh", status: "in_progress", assignee: "agent", updated_at: "2026-07-24T11:00:00.000Z" }),
        item({ id: "pm-blank-owner", status: "in_progress", assignee: "   ", updated_at: "2026-07-24T11:00:00.000Z" }),
        item({ id: "pm-unknown", status: "in_progress", updated_at: "invalid" }),
        item({ id: "pm-unknown-b", status: "in_progress", updated_at: "invalid" }),
        item({ id: "pm-owned-unknown", status: "in_progress", assignee: "agent", updated_at: "invalid" }),
        item({ id: "pm-open", status: "open" }),
      ],
      { threshold_hours: 72, now: new Date("2026-07-24T12:00:00.000Z") },
    );
    expect(scan.threshold_hours).toBe(72);
    expect(scan.unowned).toEqual({
      count: 5,
      items: [
        { id: "pm-unowned-idle", last_activity_at: "2026-07-01T00:00:00.000Z", age_hours: 564 },
        { id: "pm-blank-owner", last_activity_at: "2026-07-24T11:00:00.000Z", age_hours: 1 },
        { id: "pm-unowned-fresh", last_activity_at: "2026-07-24T11:00:00.000Z", age_hours: 1 },
        { id: "pm-unknown", last_activity_at: null, age_hours: null },
        { id: "pm-unknown-b", last_activity_at: null, age_hours: null },
      ],
    });
    expect(scan.idle).toEqual({
      count: 2,
      items: [
        { id: "pm-owned-idle", last_activity_at: "2026-07-01T00:00:00.000Z", age_hours: 564, assignee: "agent" },
        { id: "pm-unowned-idle", last_activity_at: "2026-07-01T00:00:00.000Z", age_hours: 564 },
      ],
    });
    expect(scan.stale).toMatchObject({ count: 1, items: [{ id: "pm-unowned-idle" }] });
  });

  it("defaults the classification clock to now and reads history for unparseable metadata", async () => {
    expect(
      inspectInProgressWork([item({ id: "pm-old", status: "in_progress" })], { threshold_hours: 1 }).idle.count,
    ).toBe(1);
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-stale-work-"));
    try {
      await mkdir(path.join(pmRoot, "history"));
      await writeFile(
        path.join(pmRoot, "history", "pm-unparsed.jsonl"),
        `${JSON.stringify({ ts: "2026-07-24T11:30:00.000Z", author: "a", op: "update", patch: [], before_hash: "x", after_hash: "y" })}\n`,
      );
      const scan = await scanInProgressWork(
        pmRoot,
        [
          item({ id: "pm-unparsed", status: "in_progress", updated_at: "invalid" }),
          item({ id: "pm-no-evidence", status: "in_progress", updated_at: "invalid" }),
        ],
        { threshold_hours: 72, now: new Date("2026-07-24T12:00:00.000Z") },
      );
      expect(scan.unowned.items).toEqual([
        { id: "pm-unparsed", last_activity_at: "2026-07-24T11:30:00.000Z", age_hours: 0 },
        { id: "pm-no-evidence", last_activity_at: null, age_hours: null },
      ]);
      expect(scan.idle.count).toBe(0);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("resolves the shared activity clock and its derived instants", () => {
    expect(STALE_WORK_THRESHOLD_SETTING).toBe("mutation_guard.stale_in_progress_hours");
    // A restore advances only history, so the clock is the newer of the two.
    expect(resolveLastActivityAt("2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z")).toBe("2026-07-02T00:00:00.000Z");
    expect(resolveLastActivityAt("2026-07-03T00:00:00.000Z", "2026-07-02T00:00:00.000Z")).toBe("2026-07-03T00:00:00.000Z");
    expect(resolveLastActivityAt("invalid", undefined)).toBeUndefined();
    expect(resolveLastActivityAt(undefined, "2026-07-02T00:00:00.000Z")).toBe("2026-07-02T00:00:00.000Z");
    expect(wholeHoursSince("2026-07-24T10:30:00.000Z", Date.parse("2026-07-24T12:00:00.000Z"))).toBe(1);
    expect(wholeHoursSince("2026-07-25T00:00:00.000Z", Date.parse("2026-07-24T12:00:00.000Z"))).toBe(0);
    expect(staleEligibleAt("2026-07-24T00:00:00.000Z", 72)).toBe("2026-07-27T00:00:00.000Z");
    // A threshold settings accept but the Date range cannot represent yields null, never a RangeError.
    expect(staleEligibleAt("2026-07-24T00:00:00.000Z", 3_000_000_000)).toBeNull();
    expect(
      latestHistoryTimestamp([
        { ts: "2026-07-02T00:00:00.000Z", op: "restore", patch: [] },
        { ts: "bad", op: "update", patch: [] },
        { ts: "2026-07-01T00:00:00.000Z", op: "comment_add", patch: [] },
        // Maintenance preserves the record without working on the item (history-compact, repair, redact).
        { ts: "2026-07-09T00:00:00.000Z", op: "history_compact", patch: [] },
        { ts: "2026-07-08T00:00:00.000Z", op: "update", patch: [], event_class: "maintenance" },
        // Decoded values that are not records never throw.
        null,
        "text",
        { ts: 42, op: "update" },
        { ts: "2026-07-05T00:00:00.000Z" },
        // Records the classifier could not read are skipped too: no op, or patch entries without a string path.
        { ts: "2026-07-06T00:00:00.000Z", patch: [] },
        { ts: "2026-07-06T00:00:00.000Z", op: "update", patch: [null] },
        { ts: "2026-07-06T00:00:00.000Z", op: "update", patch: [{}] },
      ]),
    ).toBe("2026-07-02T00:00:00.000Z");
    // A compaction baseline contributes its recorded prefix activity; the audit entry never counts.
    const baseline = (receipt: Record<string, unknown> | undefined) => ({
      ts: "2026-07-06T00:00:00.000Z",
      op: "history_compact_baseline",
      patch: [],
      ...(receipt === undefined ? {} : { context: { history_compaction: receipt } }),
    });
    const audit = { ts: "2026-07-09T00:00:00.000Z", op: "history_compact", patch: [] };
    const create = { ts: "2026-07-01T00:00:00.000Z", op: "create", patch: [] };
    expect(latestHistoryTimestamp([create, baseline({ last_activity_at: "2026-07-03T00:00:00.000Z" }), audit])).toBe("2026-07-03T00:00:00.000Z");
    // A prefix with no work records null: the baseline contributes nothing.
    expect(latestHistoryTimestamp([create, baseline({ last_activity_at: null }), audit])).toBe("2026-07-01T00:00:00.000Z");
    // A baseline written before the field existed is approximated by its own timestamp (the last pruned
    // entry) for advisory reads; takeover decisions refuse it instead (unprovenHistoryActivity).
    expect(latestHistoryTimestamp([create, baseline({ contract_version: 1 }), audit])).toBe("2026-07-06T00:00:00.000Z");
    expect(latestHistoryTimestamp([create, baseline(undefined), audit])).toBe("2026-07-06T00:00:00.000Z");
    expect(latestHistoryTimestamp([create, { ...baseline(undefined), context: {} }, audit])).toBe("2026-07-06T00:00:00.000Z");
    // Malformed receipts never throw in an advisory read; they degrade to the baseline's own time.
    for (const malformed of [
      { ...baseline(undefined), context: null },
      { ...baseline(undefined), context: "x" },
      { ...baseline(undefined), context: { history_compaction: null } },
      { ...baseline(undefined), context: { history_compaction: 5 } },
      { ...baseline(undefined), context: [] },
      { ...baseline(undefined), context: { history_compaction: [] } },
      baseline({ last_activity_at: "invalid" }),
      baseline({ last_activity_at: 5 }),
    ]) {
      expect(latestHistoryTimestamp([create, malformed, audit])).toBe("2026-07-06T00:00:00.000Z");
    }
    expect(latestHistoryTimestamp([{ ts: "bad", op: "update" }])).toBeUndefined();
    // Unproven activity: a legacy baseline, a salvaged tail, or a receipt carrying either reason forward.
    for (const legacy of [baseline(undefined), baseline({ contract_version: 1 }), { ...baseline(undefined), context: {} }]) {
      expect(unprovenHistoryActivity([create, legacy, audit])).toBe("legacy_compaction_baseline");
    }
    const salvage = { ts: "2026-07-07T00:00:00.000Z", op: "history_salvage", patch: [] };
    expect(unprovenHistoryActivity([create, salvage])).toBe("discarded_history_tail");
    expect(unprovenHistoryActivity([baseline({ last_activity_at: null, unproven_activity: "discarded_history_tail" })])).toBe("discarded_history_tail");
    // The first such record decides; recorded, malformed and non-record values prove nothing either way.
    expect(unprovenHistoryActivity([baseline(undefined), salvage])).toBe("legacy_compaction_baseline");
    expect(
      unprovenHistoryActivity([
        baseline({ last_activity_at: null }),
        baseline({ last_activity_at: "2026-07-03T00:00:00.000Z" }),
        baseline({ last_activity_at: "invalid" }),
        baseline({ last_activity_at: null, unproven_activity: "other" }),
        { ...baseline(undefined), context: null },
        { ...baseline(undefined), patch: undefined },
        { ...salvage, op: undefined },
        create,
        audit,
        null,
      ]),
    ).toBeUndefined();
    // An unknown reason makes the receipt malformed, so advisory reads degrade it to the baseline's own time.
    expect(latestHistoryTimestamp([create, baseline({ last_activity_at: null, unproven_activity: "other" })])).toBe("2026-07-06T00:00:00.000Z");
    expect(latestHistoryTimestamp([create, baseline({ last_activity_at: null, unproven_activity: "legacy_compaction_baseline" })])).toBe("2026-07-01T00:00:00.000Z");
    // A compaction records its pruned prefix's newest work, or null when the prefix held none.
    expect(recordedPrefixActivity([{ ts: "2026-07-02T00:00:00.000Z", op: "update", patch: [] }])).toBe("2026-07-02T00:00:00.000Z");
    expect(recordedPrefixActivity([{ ts: "2026-07-02T00:00:00.000Z", op: "history_compact", patch: [] }])).toBeNull();
  });

  it("lets a newer history entry (a restore) rescue an item whose metadata alone looks idle", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-stale-work-"));
    try {
      const historyDirectory = path.join(pmRoot, "history");
      await mkdir(historyDirectory);
      // pm restore writes the historical document (old updated_at) and appends a new entry.
      await writeFile(
        path.join(historyDirectory, "pm-rescued.jsonl"),
        `${JSON.stringify({ ts: "2026-07-24T11:00:00.000Z", author: "a", op: "comment_add", patch: [], before_hash: "x", after_hash: "y" })}\n`,
      );
      // An unowned row is published with its exact activity, even when its metadata alone is fresh.
      await writeFile(
        path.join(historyDirectory, "pm-unowned-fresh.jsonl"),
        `${JSON.stringify({ ts: "2026-07-24T11:00:00.000Z", author: "a", op: "restore", patch: [], before_hash: "x", after_hash: "y" })}\n`,
      );
      const scan = await scanInProgressWork(
        pmRoot,
        [
          item({ id: "pm-unowned-fresh", status: "in_progress", updated_at: "2026-07-23T16:00:00.000Z" }),
          item({ id: "pm-rescued", status: "in_progress", assignee: "agent" }),
          item({ id: "pm-fresh", status: "in_progress", assignee: "agent", updated_at: "2026-07-24T11:30:00.000Z" }),
          item({ id: "pm-idle", status: "in_progress", assignee: "agent" }),
        ],
        { threshold_hours: 72, now: new Date("2026-07-24T12:00:00.000Z") },
      );
      expect(scan.idle.items.map((entry) => entry.id)).toEqual(["pm-idle"]);
      expect(scan.unowned.items).toEqual([
        { id: "pm-unowned-fresh", last_activity_at: "2026-07-24T11:00:00.000Z", age_hours: 1 },
      ]);
      await expect(readLatestHistoryActivity(pmRoot, "pm-rescued")).resolves.toBe("2026-07-24T11:00:00.000Z");
      await expect(readLatestHistoryActivity(pmRoot, "pm-missing")).resolves.toBeUndefined();
      await writeFile(path.join(historyDirectory, "pm-corrupt-direct.jsonl"), "not-json\n");
      await expect(readLatestHistoryActivity(pmRoot, "pm-corrupt-direct")).resolves.toBeUndefined();
      // A `null` line parses as JSON but is no record: the advisory read degrades instead of throwing.
      await writeFile(path.join(historyDirectory, "pm-null-line.jsonl"), "null\n");
      await expect(readLatestHistoryActivity(pmRoot, "pm-null-line")).resolves.toBeUndefined();
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("resolves stored status aliases through the registry, matching the in-progress counters", async () => {
    const registry = resolveRuntimeStatusRegistry({
      statuses: [
        { id: "todo", roles: ["active", "default_open"] },
        { id: "doing", aliases: ["wip"], roles: ["active"] },
        { id: "shipped", roles: ["terminal", "terminal_done", "default_close"] },
      ],
      fields: [],
      workflow: { open_status: "todo", in_progress_status: "doing", close_status: "shipped" },
    });
    const items = [
      item({ id: "pm-alias", status: "wip" as ItemStatus }),
      item({ id: "pm-canonical", status: "doing" as ItemStatus }),
      item({ id: "pm-open", status: "todo" as ItemStatus }),
    ];
    const now = new Date("2026-07-24T12:00:00.000Z");
    // The target defaults to the registry's in-progress status.
    expect(
      inspectInProgressWork(items, { status_registry: registry, threshold_hours: 72, now }).unowned.items.map((entry) => entry.id),
    ).toEqual(["pm-alias", "pm-canonical"]);
    // Without a registry only the spelling matches, so an item stored under an alias is not counted.
    expect(
      inspectInProgressWork(items, { in_progress_status: "doing", threshold_hours: 72, now }).unowned.items.map((entry) => entry.id),
    ).toEqual(["pm-canonical"]);
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-stale-work-"));
    try {
      const scan = await scanInProgressWork(pmRoot, items, {
        in_progress_status: "doing",
        status_registry: registry,
        threshold_hours: 72,
        now,
      });
      expect(scan.stale.items.map((entry) => entry.id)).toEqual(["pm-alias", "pm-canonical"]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
